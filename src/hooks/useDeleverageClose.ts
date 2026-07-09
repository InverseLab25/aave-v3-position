import { useCallback, useState } from 'react'
import { useAccount, useChainId, usePublicClient, useWalletClient, useConfig } from 'wagmi'
import { estimateFeesPerGas, simulateContract } from 'wagmi/actions'
import { erc20Abi, parseSignature, type Address } from 'viem'
import { calculateAdjustedFees } from '../utils/gas'
import { getChainConfig, getDeleveragerAddress } from '../config/chains'
import { getAdaptersForChain } from '../adapters'
import type { Asset } from '../adapters/types'
import {
  DELEVERAGER_ABI,
  COMPATIBLE_ADAPTERS,
  pickBestRoute,
  computeMinOut,
  buildPermitTypedData,
} from '../lib/deleverage'

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

export type CloseStep = 'idle' | 'running' | 'done' | 'error'

export function useDeleverageClose() {
  const { address } = useAccount()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const config = useConfig()
  const [logs, setLogs] = useState<string[]>([])
  const [step, setStep] = useState<CloseStep>('idle')

  const log = useCallback((m: string) => setLogs((prev) => [...prev, m]), [])

  const close = useCallback(
    async ({ collateral, debtAsset, slippagePercent }: CloseInput) => {
      setLogs([])
      setStep('running')
      try {
        if (!address || !publicClient || !walletClient) throw new Error('Wallet not connected')
        const deleverager = getDeleveragerAddress(chainId)
        if (!deleverager) throw new Error('One-click close is not available on this network')
        const chainConfig = getChainConfig(chainId)
        if (!chainConfig) throw new Error('Unsupported chain')

        const collateralAddr = collateral.underlyingAsset as Address
        const debtAddr = debtAsset.underlyingAsset as Address

        // 1. Resolve Aave token addresses via the ProtocolDataProvider.
        log('Reading Aave reserve token addresses…')
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

        // 2. Live balances (wei): debt to repay, collateral to swap.
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

        // 3. Quote collateral -> debt on the compatible aggregators, pick the best.
        log('Fetching swap routes (KyberSwap, OpenOcean)…')
        const adapters = getAdaptersForChain(chainConfig.adapters).filter((a) =>
          (COMPATIBLE_ADAPTERS as readonly string[]).includes(a.name),
        )
        const quotes = await Promise.all(
          adapters.map((a) =>
            a.getQuote(collateral, debtAsset, collAmount.toString(), slippagePercent, chainId),
          ),
        )
        const best = pickBestRoute(quotes)
        if (!best) throw new Error('No compatible swap route available')
        const adapter = adapters.find((a) => a.name === best.aggregator)
        if (!adapter) throw new Error('Selected adapter unavailable')
        log(`Best route: ${best.aggregator}`)

        // 4. Build router calldata with the DELEVERAGER as the swap recipient.
        const tx = await adapter.buildTransaction(best, slippagePercent, deleverager, chainId)
        const router = tx.to as Address
        const swapData = tx.data as `0x${string}`
        // The contract approves `router` and calls `router`, so the aggregator's approval
        // spender must equal its call target. True for KyberSwap/OpenOcean; guard in case a
        // future adapter with a separate spender is added to COMPATIBLE_ADAPTERS.
        if (tx.to.toLowerCase() !== tx.spender.toLowerCase()) {
          throw new Error('Router approval target and call target differ; incompatible with deleverager')
        }

        // 5. Slippage floor + coverage. Block underwater closes before signing.
        const slippageBps = Math.round(slippagePercent * 100)
        if (slippageBps < 0 || slippageBps >= 10000) {
          throw new Error('Slippage must be between 0% and 100%')
        }
        const { minOut, covered } = computeMinOut(BigInt(best.amountOut), debt, slippageBps)
        if (!covered) {
          throw new Error('Collateral will not cover the debt at this slippage (position underwater)')
        }

        // 6. EIP-2612 permit on the collateral aToken (spender = deleverager).
        log('Requesting permit signature…')
        const aTokenName = await publicClient.readContract({
          address: aToken,
          abi: erc20Abi,
          functionName: 'name',
        })
        const nonce = await publicClient.readContract({
          address: aToken,
          abi: NONCES_ABI,
          functionName: 'nonces',
          args: [address],
        })
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
        // aTokens rebase upward between signing and inclusion. Sign the permit for a 1% buffer
        // above the live balance so the contract can pull the *full* balance at execution
        // (it pulls min(live balance, permitValue)), leaving zero aToken dust supplied in Aave.
        // Interest over the ~20min deadline is a tiny fraction of 1%, so the buffer is ample; any
        // unused headroom is harmless since the aToken balance is drained to ~0 by the withdraw.
        const permitValue = collAmount + collAmount / 100n
        const typedData = buildPermitTypedData({
          aToken,
          aTokenName,
          chainId,
          owner: address,
          spender: deleverager,
          value: permitValue,
          nonce,
          deadline,
        })
        const signature = await walletClient.signTypedData({ account: address, ...typedData })
        const sig = parseSignature(signature)
        const v = sig.v !== undefined ? Number(sig.v) : sig.yParity + 27

        // 7. Fire the one-tx close.
        const { maxFeePerGas, maxPriorityFeePerGas } = await estimateFeesPerGas(config)
        const { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas } = calculateAdjustedFees(maxFeePerGas, maxPriorityFeePerGas)

        // Simulate before writing to catch reverts early
        log('Simulating close transaction…')
        const { request } = await simulateContract(config, {
          address: deleverager,
          abi: DELEVERAGER_ABI,
          functionName: 'closePositionWithPermit',
          args: [collateralAddr, debtAddr, minOut, router, swapData, { value: permitValue, deadline, v, r: sig.r, s: sig.s }],
          account: address,
          maxFeePerGas: adjustedMaxFeePerGas,
          maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)

        log('Submitting close transaction…')
        const hash = await walletClient.writeContract(request)
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
    [address, chainId, publicClient, walletClient, log, config],
  )

  return { close, logs, step }
}
