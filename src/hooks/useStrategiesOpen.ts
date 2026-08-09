/**
 * Orchestrates opening a leveraged position: preview here, execute in the same hook.
 *
 * The preview is the seed → quote → re-size → maybe-re-quote → build loop. It exists because
 * sizeOpen needs a swap rate it cannot fetch, and the oracle's rate is mid-market — good enough
 * to size a first quote, not good enough to sign.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useChainId, useConnection, usePublicClient, useSignTypedData, useWriteContract } from 'wagmi'
import { parseAbi, type Address, type Hex } from 'viem'
import {
  getAllowedRouters,
  getDelegationAllowance,
  getPauseState,
  getPermitContext,
  resolveMode,
  sizeOpen,
  planOpen,
  buildCreditDelegation,
  toStrategiesSig,
  ZERO_STRATEGIES_SIG,
  aaveV3StrategiesAbi,
  type OpenMode,
  type SizeOpenError,
} from '../lib/strategies-sdk'
import {
  MAX_REFINE_ROUNDS,
  minOutFromBuild,
  needsRequote,
  rateFromOracle,
  rateFromQuote,
} from '../lib/openPlan'
import { getAdaptersForChain } from '../adapters'
import { getChainConfig } from '../config/chains'
import { getPoolDataProvider, getReserveTokens } from '../lib/aaveStatics'
import { decodeStrategiesError } from '../lib/strategiesErrors'
import { extractRevertMessage } from '../utils/errors'

export interface ReserveInfo {
  address: Address
  decimals: number
  priceUsd: bigint
  ltvBps: bigint
  liquidationThresholdBps: bigint
}

export interface OpenInput {
  contract: Address
  mode: OpenMode
  volatile: Address
  stable: Address
  marginAmount: bigint
  leverageBps: bigint
  slippageBps: bigint
  reserves: { collateral: ReserveInfo; debt: ReserveInfo }
}

export type PreviewErrorKind = SizeOpenError | 'paused' | 'no-route' | 'no-client' | 'quote-failed'

export interface PreviewError {
  kind: PreviewErrorKind
  message: string
}

export interface OpenPreview {
  collateral: Address
  debtAsset: Address
  marginAsset: Address
  flashAmount: bigint
  borrowAmount: bigint
  minOut: bigint
  expectedCollateral: bigint
  expectedDebt: bigint
  expectedLeverageBps: bigint
  expectedHealthFactorBps: bigint
  router: Address
  swapData: Hex
  /** Aggregator name, for display. */
  aggregator: string
}

const DEBOUNCE_MS = 400

export type OpenStep = 'idle' | 'approving' | 'signing' | 'sending' | 'done' | 'error'

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const)

/** How long a delegation signature stays valid. Long enough to survive a build and inclusion. */
const SIGNATURE_TTL_S = 1800n

export interface OpenDeps {
  writeContract: (args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }) => Promise<Hex>
  signTypedData: (payload: unknown) => Promise<Hex>
}

/**
 * `injected` is a PARTIAL override, not an all-or-nothing swap: a test that only wants to stub
 * `signTypedData` still gets the real `writeContract` wired to wagmi underneath, and vice versa.
 * That is also why `useWriteContract`/`useSignTypedData` are called unconditionally below rather
 * than skipped when `injected` is present — rules of hooks, and the merge needs both live.
 */
export function useStrategiesOpen(input: OpenInput | null, injected?: Partial<OpenDeps>) {
  const client = usePublicClient()
  const chainId = useChainId()
  const { address: owner } = useConnection()

  // wagmi's hooks must be called unconditionally, so they run even when deps are injected —
  // the injected object simply wins, field by field (see OpenDeps above).
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()

  const [preview, setPreview] = useState<OpenPreview | null>(null)
  const [previewError, setPreviewError] = useState<PreviewError | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)
  const [tick, setTick] = useState(0)
  const [step, setStep] = useState<OpenStep>('idle')
  const [txHash, setTxHash] = useState<Hex | undefined>()
  const [execError, setExecError] = useState<string | null>(null)

  /** Set while a signature is held, to stop the preview moving underneath it (Task 7). */
  const frozen = useRef(false)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!input || !client || frozen.current) return
    let cancelled = false

    const timer = setTimeout(async () => {
      setIsQuoting(true)
      setPreviewError(null)
      try {
        const { collateral, debtAsset, marginIn } = resolveMode({
          mode: input.mode, volatile: input.volatile, stable: input.stable,
        })

        const [{ paused }, routers] = await Promise.all([
          getPauseState(client, input.contract),
          getAllowedRouters(client, input.contract),
        ])
        if (cancelled) return
        if (paused) {
          setPreviewError({ kind: 'paused', message: 'Leverage is paused.' })
          return
        }

        const coll = input.reserves.collateral
        const debt = input.reserves.debt
        const sizeArgs = {
          marginIn,
          marginAmount: input.marginAmount,
          leverageBps: input.leverageBps,
          collateralPriceUsd: coll.priceUsd,
          debtPriceUsd: debt.priceUsd,
          collateralDecimals: coll.decimals,
          debtDecimals: debt.decimals,
          ltvBps: coll.ltvBps,
          liquidationThresholdBps: coll.liquidationThresholdBps,
          rateBufferBps: input.slippageBps,
          slippageBps: input.slippageBps,
        }

        // Seed off the oracle so the first quote is asked for a plausible size.
        let sized = sizeOpen({ ...sizeArgs, rateWad: rateFromOracle({
          collateralPriceUsd: coll.priceUsd, debtPriceUsd: debt.priceUsd,
          collateralDecimals: coll.decimals, debtDecimals: debt.decimals,
        }) })
        if (!sized.ok) {
          setPreviewError({ kind: sized.error, message: sized.error })
          return
        }

        const allowed = new Set(routers.map((r) => r.toLowerCase()))
        const adapters = getAdaptersForChain(getChainConfig(chainId)?.adapters ?? [])
          .filter((a) => a.supportsExecution)

        const fromAsset = { underlyingAsset: debtAsset, symbol: '', decimals: debt.decimals }
        const toAsset = { underlyingAsset: collateral, symbol: '', decimals: coll.decimals }
        const slippagePercent = Number(input.slippageBps) / 100

        let quote = null
        let adapter = null
        // The sizing whose borrowAmount was actually submitted to getQuote for the round that
        // wins — swapData ends up built against that exact amount, so the preview must report
        // it verbatim. `sized` keeps moving after that (it drives the next round's amountIn,
        // or reflects a re-size the loop never re-quoted), so it is NOT safe to read after the
        // loop: it can be smaller than what was quoted (under-approves the router — reverts)
        // or larger (a position that was never actually priced).
        let quotedSize = sized.size
        for (let round = 0; round < MAX_REFINE_ROUNDS; round++) {
          const amountIn = sized.size.borrowAmount.toString()
          const results = await Promise.all(
            adapters.map(async (a) => {
              try {
                const q = await a.getQuote(fromAsset, toAsset, amountIn, slippagePercent, chainId)
                return q ? { a, q } : null
              } catch {
                return null
              }
            }),
          )
          if (cancelled) return

          const best = results
            .filter((r): r is NonNullable<typeof r> => r !== null)
            .sort((x, y) => (BigInt(y.q.amountOut) > BigInt(x.q.amountOut) ? 1 : -1))[0]
          if (!best) break

          quote = best.q
          adapter = best.a
          quotedSize = sized.size

          const resized = sizeOpen({ ...sizeArgs, rateWad: rateFromQuote({
            amountIn: BigInt(quote.amountIn), amountOut: BigInt(quote.amountOut),
          }) })
          if (!resized.ok) {
            setPreviewError({ kind: resized.error, message: resized.error })
            return
          }

          const grew = needsRequote(BigInt(quote.amountIn), resized.size.borrowAmount)
          sized = resized
          if (!grew) break
        }

        if (!quote || !adapter) {
          setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
          return
        }

        const built = await adapter.buildTransaction(quote, slippagePercent, input.contract, chainId)
        if (cancelled) return
        if (!allowed.has(built.to.toLowerCase())) {
          setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
          return
        }

        setPreview({
          collateral, debtAsset,
          marginAsset: marginIn === 'collateral' ? collateral : debtAsset,
          flashAmount: quotedSize.flashAmount,
          borrowAmount: quotedSize.borrowAmount,
          minOut: minOutFromBuild({
            buildAmountOut: BigInt(built.amountOut ?? quote.amountOut),
            slippageBps: input.slippageBps,
            flashAmount: quotedSize.flashAmount,
          }),
          expectedCollateral: quotedSize.expectedCollateral,
          expectedDebt: quotedSize.expectedDebt,
          expectedLeverageBps: quotedSize.expectedLeverageBps,
          expectedHealthFactorBps: quotedSize.expectedHealthFactorBps,
          router: built.to as Address,
          swapData: built.data as Hex,
          aggregator: adapter.name,
        })
      } catch {
        if (!cancelled) {
          setPreviewError({ kind: 'quote-failed', message: 'Could not price this position.' })
        }
      } finally {
        if (!cancelled) setIsQuoting(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [input, client, chainId, owner, tick])

  const execute = useCallback(async () => {
    if (!input || !preview || !client || !owner) return

    // The delegation signs an exact borrowAmount, so the plan must not move once we start.
    frozen.current = true
    setExecError(null)
    try {
      // A partial override, not an all-or-nothing swap: a caller stubbing only `signTypedData`
      // still gets the real `writeContract` wired to wagmi underneath, and vice versa.
      const deps: OpenDeps = {
        writeContract:
          injected?.writeContract ??
          ((args) => writeContractAsync(args as Parameters<typeof writeContractAsync>[0])),
        signTypedData:
          injected?.signTypedData ??
          ((payload) => signTypedDataAsync(payload as Parameters<typeof signTypedDataAsync>[0])),
      }

      const chainConfig = getChainConfig(chainId)
      if (!chainConfig) throw new Error('Unsupported chain')
      const dataProvider = await getPoolDataProvider(client, chainId, chainConfig.aave.poolAddressesProvider)
      const { vDebt: variableDebtToken } = await getReserveTokens(client, chainId, dataProvider, preview.debtAsset)

      // 1. Approve the margin, unless the allowance already covers it.
      setStep('approving')
      const allowance = (await client.readContract({
        address: preview.marginAsset, abi: ERC20_ABI, functionName: 'allowance',
        args: [owner, input.contract],
      })) as bigint
      if (allowance < input.marginAmount) {
        await deps.writeContract({
          address: preview.marginAsset, abi: ERC20_ABI, functionName: 'approve',
          args: [input.contract, input.marginAmount],
        })
      }

      // 2. Delegate credit, unless a standing delegation already covers this borrow.
      setStep('signing')
      const standing = await getDelegationAllowance(client, variableDebtToken, owner, input.contract)
      let delegation = ZERO_STRATEGIES_SIG
      if (standing < preview.borrowAmount) {
        const ctx = await getPermitContext(client, variableDebtToken, owner)
        const deadline = BigInt(Math.floor(Date.now() / 1000)) + SIGNATURE_TTL_S
        const signature = await deps.signTypedData(
          buildCreditDelegation({
            chainId, debtToken: variableDebtToken, debtTokenName: ctx.name,
            delegatee: input.contract, value: preview.borrowAmount,
            nonce: ctx.nonce, deadline,
          }),
        )
        delegation = toStrategiesSig(signature, deadline)
      }

      // 3. Send.
      setStep('sending')
      const plan = planOpen({
        mode: input.mode, volatile: input.volatile, stable: input.stable,
        flashAmount: preview.flashAmount, borrowAmount: preview.borrowAmount,
        marginAmount: input.marginAmount, minOut: preview.minOut,
        router: preview.router, swapData: preview.swapData, delegation,
      })
      const hash = await deps.writeContract({
        address: input.contract, abi: aaveV3StrategiesAbi,
        functionName: plan.functionName, args: plan.args,
      })
      setTxHash(hash)
      setStep('done')
    } catch (err) {
      const decoded = decodeStrategiesError(err)
      setExecError(decoded?.message ?? extractRevertMessage(err))
      setStep('error')
    } finally {
      frozen.current = false
    }
  }, [input, preview, client, owner, chainId, injected, writeContractAsync, signTypedDataAsync])

  return { preview, previewError, isQuoting, refresh, frozen, step, txHash, execError, execute }
}
