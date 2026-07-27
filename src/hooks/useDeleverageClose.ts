import { useCallback, useState } from 'react'
import { useConnection, useChainId, usePublicClient, useWalletClient, useConfig } from 'wagmi'
import { estimateFeesPerGas, simulateContract } from 'wagmi/actions'
import { erc20Abi, formatUnits, parseSignature, type Address } from 'viem'
import { calculateAdjustedFees, bufferedGasLimit } from '../utils/gas'
import { getChainConfig, getDeleveragerAddress } from '../config/chains'
import { getAdaptersForChain } from '../adapters'
import { isNativeAddress, NATIVE_ZERO_ADDRESS } from '../adapters/native'
import type { Adapter, Asset, QuoteResponse } from '../adapters/types'
import {
  DELEVERAGER_ABI,
  COMPATIBLE_ADAPTERS,
  pickBestRoute,
  buildPermitTypedData,
} from '../lib/deleverage'

/** Ceiling division for bigints: smallest n such that n * b >= a. */
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

// Headroom over the debt for interest accruing between the quote and execution (0.5%).
// This covers accrual ONLY — slippage is handled separately by sizing against the
// router's guaranteed output, because the two compose multiplicatively: a fixed 0.5%
// margin is entirely consumed by 0.5% slippage, leaving the swap short of the debt.
const ACCRUAL_BUFFER_BPS = 50n

// How many times to re-quote while converging on the collateral actually required.
// Each round is one parallel fan-out across the compatible aggregators.
const SIZING_ROUNDS = 3

const PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getPoolDataProvider',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const DATA_PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getReserveTokensAddresses',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'aTokenAddress', type: 'address' },
      { name: 'stableDebtTokenAddress', type: 'address' },
      { name: 'variableDebtTokenAddress', type: 'address' },
    ],
  },
] as const

const NONCES_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

export interface CloseInput {
  collateral: Asset
  debtAsset: Asset
  slippagePercent: number
}

/** The sized, quoted swap plan shared by preview() and close(). All amounts are wei. */
interface ClosePlan {
  deleverager: Address
  collateralAddr: Address
  debtAddr: Address
  aToken: Address
  debt: bigint
  collAmount: bigint
  requiredIn: bigint // collateral fed to the swap
  expectedOut: bigint // debt-token the swap is expected to return
  minDebtOut: bigint // debt-token the router guarantees (expectedOut × (1 − slippage))
  covered: boolean // collateral value can repay the debt (not underwater)
  guaranteed: boolean // router-guaranteed min ≥ debt → close cannot revert on output
  best: QuoteResponse
  adapter: Adapter
}

/** Router numbers surfaced to the UI so the user can review the swap before signing. */
export interface ClosePreview {
  covered: boolean
  guaranteed: boolean
  aggregator: string
  collateralSymbol: string
  debtSymbol: string
  debtRepaid: string
  collateralSwapped: string
  collateralKeptSupplied: string
  minDebtOut: string
  expectedDebtOut: string
  collateralKeptSuppliedUsd: number | null
}

export type CloseStep = 'idle' | 'running' | 'done' | 'error'

export function useDeleverageClose() {
  const { address } = useConnection()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const config = useConfig()
  const [logs, setLogs] = useState<string[]>([])
  const [step, setStep] = useState<CloseStep>('idle')

  const log = useCallback((m: string) => setLogs((prev) => [...prev, m]), [])

  // Resolve reserves, read live balances, size the swap, and quote it. No signing —
  // shared by preview() (display) and close() (execution) so both use one code path.
  const buildPlan = useCallback(
    async (
      { collateral, debtAsset, slippagePercent }: CloseInput,
      logFn: (m: string) => void = () => {},
    ): Promise<ClosePlan> => {
      if (!address || !publicClient) throw new Error('Wallet not connected')
      const deleverager = getDeleveragerAddress(chainId)
      if (!deleverager) throw new Error('One-click close is not available on this network')
      const chainConfig = getChainConfig(chainId)
      if (!chainConfig) throw new Error('Unsupported chain')

      const collateralAddr = collateral.underlyingAsset as Address
      const debtAddr = debtAsset.underlyingAsset as Address

      // The deleverager operates purely on Aave's wrapped ERC-20 reserves (e.g. WETH).
      // A native-ETH sentinel (0xEeee… or the zero address) would resolve to a zero
      // aToken/vDebt and make the aggregators quote a native swap the contract can't
      // fund — reject it up front rather than reverting deep in the flash-loan callback.
      if (
        isNativeAddress(collateralAddr) ||
        isNativeAddress(debtAddr) ||
        collateralAddr.toLowerCase() === NATIVE_ZERO_ADDRESS ||
        debtAddr.toLowerCase() === NATIVE_ZERO_ADDRESS
      ) {
        throw new Error('Native ETH is not an Aave reserve — use the wrapped token (e.g. WETH)')
      }

      const slippageBps = Math.round(slippagePercent * 100)
      if (slippageBps < 0 || slippageBps >= 10000) {
        throw new Error('Slippage must be between 0% and 100%')
      }

      // 1. Resolve Aave token addresses via the ProtocolDataProvider.
      logFn('Reading Aave reserve token addresses…')
      const dataProvider = await publicClient.readContract({
        address: chainConfig.aave.poolAddressesProvider,
        abi: PROVIDER_ABI,
        functionName: 'getPoolDataProvider',
      })
      const [collTokens, debtTokens] = await Promise.all([
        publicClient.readContract({
          address: dataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getReserveTokensAddresses',
          args: [collateralAddr],
        }),
        publicClient.readContract({
          address: dataProvider,
          abi: DATA_PROVIDER_ABI,
          functionName: 'getReserveTokensAddresses',
          args: [debtAddr],
        }),
      ])
      const aToken = collTokens[0]
      const vDebt = debtTokens[2]

      // 2. Live balances (wei): debt to repay, collateral available.
      const [debt, collAmount] = await Promise.all([
        publicClient.readContract({
          address: vDebt,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }),
        publicClient.readContract({
          address: aToken,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [address],
        }),
      ])
      if (debt === 0n) throw new Error('No debt to close')
      if (collAmount === 0n) throw new Error('No collateral to withdraw')

      // 3. Quote collateral -> debt on the compatible aggregators.
      logFn('Fetching swap routes (KyberSwap, OpenOcean, Odos)…')
      const adapters = getAdaptersForChain(chainConfig.adapters).filter((a) =>
        (COMPATIBLE_ADAPTERS as readonly string[]).includes(a.name),
      )
      const quoteBest = async (amountIn: bigint) => {
        const quotes = await Promise.all(
          adapters.map((a) =>
            a
              .getQuote(collateral, debtAsset, amountIn.toString(), slippagePercent, chainId)
              .catch(() => null),
          ),
        )
        return pickBestRoute(quotes)
      }

      // Quote the full collateral first to gauge price and coverage.
      const bestFull = await quoteBest(collAmount)
      if (!bestFull) throw new Error('No compatible swap route available')
      const fullOut = BigInt(bestFull.amountOut)
      const covered = fullOut >= debt

      const slipNum = BigInt(10000 - slippageBps)
      /** What a router contractually guarantees to deliver for a given quoted output. */
      const guaranteedOut = (quotedOut: bigint) => (quotedOut * slipNum) / 10000n
      // The swap has to clear the debt out of the router's GUARANTEED output, not its
      // quoted output, plus headroom for interest accruing before it lands.
      const needed = (debt * (10000n + ACCRUAL_BUFFER_BPS)) / 10000n

      // 4. Work out how much collateral actually has to be swapped.
      //
      //    Aggregators quote exact-INPUT only (`Adapter.getQuote` takes an amountIn), so
      //    the required input cannot be asked for directly. We estimate it from an
      //    observed rate, then VERIFY that estimate against a real quote at that size and
      //    refine if it falls short. Pricing is non-linear — `fullOut` is the rate for
      //    swapping the entire collateral, i.e. the worst price-impact point — so a single
      //    back-out is an estimate, never an answer.
      let requiredIn =
        covered && fullOut > 0n ? ceilDiv(collAmount * needed * 10000n, fullOut * slipNum) : collAmount
      if (!covered || requiredIn >= collAmount) requiredIn = collAmount

      let best = bestFull
      for (let round = 0; round < SIZING_ROUNDS && requiredIn !== collAmount; round++) {
        const quote = await quoteBest(requiredIn)
        // A failed re-quote must NOT fall back to the full-collateral quote: its calldata
        // swaps `collAmount` while the contract only withdraws `requiredIn`, so the router
        // would try to pull more than it was approved for. Drain instead, which keeps the
        // quote and the withdrawal consistent.
        if (!quote) {
          requiredIn = collAmount
          best = bestFull
          break
        }
        best = quote

        const quotedOut = BigInt(quote.amountOut)
        if (guaranteedOut(quotedOut) >= needed) break // this size is enough — stop here

        // Short. Scale the input up by the shortfall ratio and re-measure.
        const scaled =
          quotedOut > 0n ? ceilDiv(requiredIn * needed * 10000n, quotedOut * slipNum) : collAmount
        if (scaled >= collAmount) {
          requiredIn = collAmount
          best = bestFull
          break
        }
        if (scaled <= requiredIn) break // not converging — accept and let `guaranteed` decide
        requiredIn = scaled
      }

      const adapter = adapters.find((a) => a.name === best.aggregator)
      if (!adapter) throw new Error('Selected adapter unavailable')

      const expectedOut = BigInt(best.amountOut)
      // What the router bakes in as its minimum return for this quote at this slippage.
      const minDebtOut = guaranteedOut(expectedOut)
      const guaranteed = covered && minDebtOut >= debt

      return {
        deleverager,
        collateralAddr,
        debtAddr,
        aToken,
        debt,
        collAmount,
        requiredIn,
        expectedOut,
        minDebtOut,
        covered,
        guaranteed,
        best,
        adapter,
      }
    },
    [address, chainId, publicClient],
  )

  // Read-only: size + quote the swap and return the router numbers, no signature.
  const preview = useCallback(
    async (input: CloseInput): Promise<ClosePreview | null> => {
      try {
        const p = await buildPlan(input)
        const cDec = input.collateral.decimals
        const dDec = input.debtAsset.decimals
        // The collateral the swap does NOT consume is never withdrawn — it stays supplied in Aave.
        const collateralKeptSuppliedWei = p.collAmount - p.requiredIn
        const collateralPrice = Number(input.collateral.priceInUsd ?? 0)
        const collateralKeptSuppliedUsd =
          collateralPrice > 0
            ? Number(formatUnits(collateralKeptSuppliedWei, cDec)) * collateralPrice
            : null
        return {
          covered: p.covered,
          guaranteed: p.guaranteed,
          aggregator: p.best.aggregator,
          collateralSymbol: input.collateral.symbol,
          debtSymbol: input.debtAsset.symbol,
          debtRepaid: formatUnits(p.debt, dDec),
          collateralSwapped: formatUnits(p.requiredIn, cDec),
          collateralKeptSupplied: formatUnits(collateralKeptSuppliedWei, cDec),
          minDebtOut: formatUnits(p.minDebtOut, dDec),
          expectedDebtOut: formatUnits(p.expectedOut, dDec),
          collateralKeptSuppliedUsd,
        }
      } catch {
        return null
      }
    },
    [buildPlan],
  )

  const close = useCallback(
    async (input: CloseInput) => {
      setLogs([])
      setStep('running')
      try {
        if (!address || !publicClient || !walletClient) throw new Error('Wallet not connected')

        const p = await buildPlan(input, log)
        if (!p.covered) {
          throw new Error('Collateral will not cover the debt (position underwater)')
        }
        // Sizing targets a guaranteed output above the debt, but the verifying re-quote can
        // still come back short (thin liquidity, a route change, price moving between
        // quotes). Refuse here rather than take a permit signature for a swap the router
        // does not guarantee: `minOut` below is the full debt, so the close would revert
        // on-chain with InsufficientOutput after burning gas, leaving the signature live
        // for the rest of its deadline.
        if (!p.guaranteed) {
          throw new Error(
            `No route guarantees repaying the debt at ${input.slippagePercent}% slippage. Lower the slippage and try again.`,
          )
        }
        log(
          `Best route: ${p.best.aggregator}. Swapping ~${formatUnits(p.requiredIn, input.collateral.decimals)} ${input.collateral.symbol}; the rest stays supplied in Aave.`,
        )

        // Build router calldata with the DELEVERAGER as the swap recipient.
        const tx = await p.adapter.buildTransaction(p.best, input.slippagePercent, p.deleverager, chainId)
        const router = tx.to as Address
        const swapData = tx.data as `0x${string}`
        // The contract approves `router` and calls `router`, so the aggregator's approval
        // spender must equal its call target. True for KyberSwap/OpenOcean/Odos; guard in case a
        // future adapter with a separate spender is added to COMPATIBLE_ADAPTERS.
        if (tx.to.toLowerCase() !== tx.spender.toLowerCase()) {
          throw new Error('Router approval target and call target differ; incompatible with deleverager')
        }

        // minOut floor = the debt itself: the swap output must cover the flash loan or
        // the contract reverts cleanly (InsufficientOutput) instead of underflowing.
        const minOut = p.debt
        // Withdraw only the collateral the swap needs, plus a tiny cushion so a 1-wei aToken
        // rounding never leaves the router short. If the swap needs (nearly) all the collateral,
        // fall back to the full-drain sentinel. Everything not withdrawn stays supplied in Aave.
        const MAX_UINT256 = (1n << 256n) - 1n
        const cushion = p.requiredIn / 100_000n > 2n ? p.requiredIn / 100_000n : 2n
        const drainAll = p.requiredIn + cushion >= p.collAmount
        const collateralToWithdraw = drainAll ? MAX_UINT256 : p.requiredIn + cushion

        // EIP-2612 permit on the collateral aToken (spender = deleverager).
        log('Requesting permit signature…')
        const aTokenName = await publicClient.readContract({
          address: p.aToken,
          abi: erc20Abi,
          functionName: 'name',
        })
        const nonce = await publicClient.readContract({
          address: p.aToken,
          abi: NONCES_ABI,
          functionName: 'nonces',
          args: [address],
        })
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
        // Full drain pulls the live (rebasing) balance so keep the +1% buffer; a fixed partial
        // pull needs no buffer — the permit value is exactly what we pull.
        const permitValue = drainAll ? p.collAmount + p.collAmount / 100n : collateralToWithdraw
        const typedData = buildPermitTypedData({
          aToken: p.aToken,
          aTokenName,
          chainId,
          owner: address,
          spender: p.deleverager,
          value: permitValue,
          nonce,
          deadline,
        })
        const signature = await walletClient.signTypedData({ account: address, ...typedData })
        const sig = parseSignature(signature)
        const v = sig.v !== undefined ? Number(sig.v) : sig.yParity + 27

        // Fire the one-tx close.
        const { maxFeePerGas, maxPriorityFeePerGas, gasPrice } = await estimateFeesPerGas(config)
        const { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas, adjustedGasPrice } = calculateAdjustedFees(maxFeePerGas, maxPriorityFeePerGas, 10n, gasPrice)

        // Simulate before writing to catch reverts early
        log('Simulating close transaction…')
        const { request } = await simulateContract(config, {
          address: p.deleverager,
          abi: DELEVERAGER_ABI,
          functionName: 'closePositionWithPermit',
          args: [p.collateralAddr, p.debtAddr, collateralToWithdraw, minOut, router, swapData, { value: permitValue, deadline, v, r: sig.r, s: sig.s }],
          account: address,
          maxFeePerGas: adjustedMaxFeePerGas,
          maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas,
          gasPrice: adjustedGasPrice,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)

        // Pin a buffered gas limit — a flash-loan close touches far more state than a
        // plain Aave action, and an unpinned limit leaves it to the wallet's estimate.
        let gas: bigint | undefined
        try {
          gas = bufferedGasLimit(
            await publicClient.estimateContractGas({
              address: p.deleverager,
              abi: DELEVERAGER_ABI,
              functionName: 'closePositionWithPermit',
              args: [p.collateralAddr, p.debtAddr, collateralToWithdraw, minOut, router, swapData, { value: permitValue, deadline, v, r: sig.r, s: sig.s }],
              account: address,
            }),
          )
        } catch {
          gas = undefined
        }

        log('Submitting close transaction…')
        const hash = await walletClient.writeContract(gas ? { ...request, gas } : request)
        log(`Tx submitted: ${hash}`)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status === 'success') {
          log('Position closed ✓')
          setStep('done')
        } else {
          log('Transaction reverted')
          setStep('error')
        }
        return { hash, status: receipt.status }
      } catch (e: unknown) {
        const err = e as { shortMessage?: string; message?: string }
        log(`Error: ${err.shortMessage || err.message || String(e)}`)
        setStep('error')
        return { hash: null, status: 'error' as const }
      }
    },
    [address, chainId, publicClient, walletClient, log, config, buildPlan],
  )

  return { preview, close, logs, step }
}
