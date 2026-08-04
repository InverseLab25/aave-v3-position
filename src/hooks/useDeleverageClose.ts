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
  rankRoutes,
  validateSwapTx,
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
  // Every compatible quote at `requiredIn`, best-first. close() walks these in order
  // because the winning route's router may not be allowlisted on the deleverager —
  // the router address is only known after buildTransaction, so it cannot be filtered
  // during sizing.
  ranked: QuoteResponse[]
  adapters: Adapter[]
  slipNum: bigint // 10000 − slippageBps, for re-deriving a candidate's guaranteed output
  /** Lowercased router allowlist, read once in buildPlan. */
  allowedRouters: Set<string>
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

/**
 * preview() outcome. It returns a result object rather than a bare null because the
 * reasons a preview fails are no longer interchangeable: "this pair has no route" is
 * actionable (try other collateral), whereas "the contract is paused" or "no routers are
 * allowlisted" are not, and showing the former for the latter sends users in circles.
 */
export interface PreviewResult {
  preview: ClosePreview | null
  /** Human-readable reason the preview could not be produced, if any. */
  error: string | null
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

      // 0. Three independent reads — the pause flag, the router allowlist, and the Aave data
      //    provider — issued as one batch rather than a waterfall. None depends on the others,
      //    and this runs before every preview as well as every close.
      logFn('Reading deleverager state and Aave reserve addresses…')
      const [isPaused, allowedRouterList, dataProvider] = await Promise.all([
        publicClient.readContract({
          address: deleverager,
          abi: DELEVERAGER_ABI,
          functionName: 'paused',
        }),
        // Whole allowlist in one call. Previously close() probed allowedRouters(tx.to) once
        // per candidate route, which meant a round-trip for every rejection; the contract's
        // set is enumerable precisely so this can be a single read.
        publicClient.readContract({
          address: deleverager,
          abi: DELEVERAGER_ABI,
          functionName: 'getAllowedRouters',
        }),
        publicClient.readContract({
          address: chainConfig.aave.poolAddressesProvider,
          abi: PROVIDER_ABI,
          functionName: 'getPoolDataProvider',
        }),
      ])
      if (isPaused !== 0n) throw new Error('One-click close is paused on this deployment')
      const allowedRouters = new Set(allowedRouterList.map((r) => r.toLowerCase()))
      if (allowedRouters.size === 0) {
        throw new Error('No swap routers are allowlisted on the deleverager yet')
      }
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
      // Ranked rather than just the winner: close() may have to fall through to the
      // runner-up when the best route's router is not allowlisted on the deleverager.
      const quoteAll = async (amountIn: bigint) => {
        const quotes = await Promise.all(
          adapters.map((a) =>
            a
              .getQuote(collateral, debtAsset, amountIn.toString(), slippagePercent, chainId)
              .catch(() => null),
          ),
        )
        return rankRoutes(quotes)
      }

      // Quote the full collateral first to gauge price and coverage.
      const rankedFull = await quoteAll(collAmount)
      const bestFull = rankedFull[0]
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
      let ranked = rankedFull
      for (let round = 0; round < SIZING_ROUNDS && requiredIn !== collAmount; round++) {
        const rankedAt = await quoteAll(requiredIn)
        const quote = rankedAt[0]
        // A failed re-quote must NOT fall back to the full-collateral quote: its calldata
        // swaps `collAmount` while the contract only withdraws `requiredIn`, so the router
        // would try to pull more than it was approved for. Drain instead, which keeps the
        // quote and the withdrawal consistent.
        if (!quote) {
          requiredIn = collAmount
          best = bestFull
          ranked = rankedFull
          break
        }
        best = quote
        ranked = rankedAt

        const quotedOut = BigInt(quote.amountOut)
        if (guaranteedOut(quotedOut) >= needed) break // this size is enough — stop here

        // Short. Scale the input up by the shortfall ratio and re-measure.
        const scaled =
          quotedOut > 0n ? ceilDiv(requiredIn * needed * 10000n, quotedOut * slipNum) : collAmount
        if (scaled >= collAmount) {
          requiredIn = collAmount
          best = bestFull
          ranked = rankedFull
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
        ranked,
        adapters,
        slipNum,
        allowedRouters,
      }
    },
    [address, chainId, publicClient],
  )

  // Read-only: size + quote the swap and return the router numbers, no signature.
  const preview = useCallback(
    async (input: CloseInput): Promise<PreviewResult> => {
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
        return { error: null, preview: {
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
        } }
      } catch (e) {
        return { preview: null, error: e instanceof Error ? e.message : String(e) }
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

        // Build router calldata with the DELEVERAGER as both sender and swap recipient,
        // then vet it against everything the contract will enforce. The router address is
        // only known after buildTransaction, so allowlist filtering cannot happen during
        // sizing — walk the ranked routes and take the first the deleverager will accept.
        // Every rejection here is one the user would otherwise pay gas to discover, after
        // signing a permit that stays live for the rest of its deadline.
        let router: Address | null = null
        let swapData: `0x${string}` | null = null
        let chosen: QuoteResponse | null = null
        const rejected: string[] = []

        for (const candidate of p.ranked) {
          const adapter = p.adapters.find((a) => a.name === candidate.aggregator)
          if (!adapter) continue

          // A fallback route is a different quote with a different output, so its
          // guarantee has to be re-derived — p.guaranteed only vouches for p.best.
          const candidateMin = (BigInt(candidate.amountOut) * p.slipNum) / 10000n
          if (candidateMin < p.debt) {
            rejected.push(`${candidate.aggregator}: guaranteed output below the debt`)
            continue
          }

          let tx
          try {
            tx = await adapter.buildTransaction(candidate, input.slippagePercent, p.deleverager, chainId)
          } catch (e) {
            rejected.push(`${candidate.aggregator}: build failed (${(e as Error).message})`)
            continue
          }

          // Set lookup rather than a round-trip — the allowlist arrived with the preflight
          // batch, so a rejected candidate now costs nothing beyond its buildTransaction.
          const problem = validateSwapTx(tx, p.allowedRouters.has(tx.to.toLowerCase()))
          if (problem) {
            rejected.push(`${candidate.aggregator}: ${problem}`)
            continue
          }

          router = tx.to as Address
          swapData = tx.data as `0x${string}`
          chosen = candidate
          break
        }

        if (!router || !swapData || !chosen) {
          throw new Error(
            `No usable swap route for the deleverager. Tried: ${rejected.join('; ') || 'none'}`,
          )
        }
        if (chosen.aggregator !== p.best.aggregator) {
          log(`${p.best.aggregator} unusable — falling back to ${chosen.aggregator}.`)
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

        // Two EIP-2612 permits on the collateral aToken (spender = deleverager):
        //   nonce N   — grants `permitValue`
        //   nonce N+1 — grants 0, consumed right after the pull so no residual allowance
        //               survives. Sequential nonces mean the revoke can only ever be applied
        //               after the grant, and it is signed here so the contract never has to
        //               trust a value the user did not authorise.
        // Costs a second wallet prompt; without it the rebase buffer below would stay
        // approved to the deleverager forever, accumulating across every close.
        log('Requesting permit signatures (2 of 2 prompts)…')
        // Batched: neither depends on the other, and both sit between the user clicking
        // Close and the first wallet prompt appearing.
        const [aTokenName, nonce] = await Promise.all([
          publicClient.readContract({
            address: p.aToken,
            abi: erc20Abi,
            functionName: 'name',
          }),
          publicClient.readContract({
            address: p.aToken,
            abi: NONCES_ABI,
            functionName: 'nonces',
            args: [address],
          }),
        ])
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

        // The revoke, at the next nonce and over value 0. Same deadline: both are consumed in
        // the same transaction, so a separate expiry would only add a way for one half to be
        // valid while the other is not.
        log('Requesting revoke signature (2 of 2)…')
        const revokeTypedData = buildPermitTypedData({
          aToken: p.aToken,
          aTokenName,
          chainId,
          owner: address,
          spender: p.deleverager,
          value: 0n,
          nonce: nonce + 1n,
          deadline,
        })
        const revokeSignature = await walletClient.signTypedData({ account: address, ...revokeTypedData })
        const revokeSig = parseSignature(revokeSignature)
        const revokeV = revokeSig.v !== undefined ? Number(revokeSig.v) : revokeSig.yParity + 27

        const permitArg = { value: permitValue, deadline, v, r: sig.r, s: sig.s }
        const revokeArg = { deadline, v: revokeV, r: revokeSig.r, s: revokeSig.s }

        // Fire the one-tx close.
        const { maxFeePerGas, maxPriorityFeePerGas, gasPrice } = await estimateFeesPerGas(config)
        const { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas, adjustedGasPrice } = calculateAdjustedFees(maxFeePerGas, maxPriorityFeePerGas, 10n, gasPrice)

        // Simulate before writing to catch reverts early
        log('Simulating close transaction…')
        const { request } = await simulateContract(config, {
          address: p.deleverager,
          abi: DELEVERAGER_ABI,
          functionName: 'closePositionWithPermit',
          args: [p.collateralAddr, p.debtAddr, collateralToWithdraw, minOut, router, swapData, permitArg, revokeArg],
          account: address,
          // viem's fee parameters are a union: EIP-1559 (maxFeePerGas/maxPriorityFeePerGas)
          // OR legacy (gasPrice), never both. Passing all three fell outside every member,
          // which is what the old `as any` was hiding. Pick the branch the chain supports.
          ...(adjustedMaxFeePerGas
            ? { maxFeePerGas: adjustedMaxFeePerGas, maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas }
            : { gasPrice: adjustedGasPrice }),
        })

        // Pin a buffered gas limit — a flash-loan close touches far more state than a
        // plain Aave action, and an unpinned limit leaves it to the wallet's estimate.
        let gas: bigint | undefined
        try {
          gas = bufferedGasLimit(
            await publicClient.estimateContractGas({
              address: p.deleverager,
              abi: DELEVERAGER_ABI,
              functionName: 'closePositionWithPermit',
              args: [p.collateralAddr, p.debtAddr, collateralToWithdraw, minOut, router, swapData, permitArg, revokeArg],
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
