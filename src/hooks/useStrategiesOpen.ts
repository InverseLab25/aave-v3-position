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
  type MarginIn,
} from '../lib/strategies-sdk'
import {
  MAX_REFINE_ROUNDS,
  leverageCeilingBps,
  minOutFromBuild,
  needsRequote,
  rateFromOracle,
  rateFromQuote,
  sizeOpenErrorMessage,
} from '../lib/openPlan'
import { routeCostPercent } from '../lib/swapRoute'
import { getAdaptersForChain } from '../adapters'
import type { Adapter, QuoteResponse, TransactionPayload } from '../adapters/types'
import { getChainConfig } from '../config/chains'
import { getPoolDataProvider, getReserveTokens } from '../lib/aaveStatics'
import { validateSwapTx } from '../lib/deleverage'
import { decodeStrategiesError } from '../lib/strategiesErrors'
import type { StrategiesRemedy } from '../lib/strategiesErrors'
import { extractRevertMessage } from '../utils/errors'

export interface ReserveInfo {
  address: Address
  symbol: string
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
  /**
   * What the route costs, as a percentage of the value put in — the aggregator's own USD
   * figures for both sides, so it folds in price impact, DEX fees and spread. Null when the
   * aggregator did not price both sides. See `PRICE_IMPACT_HIGH_PERCENT`/`_BLOCK_PERCENT` in
   * `swapRoute.ts` for the thresholds this is meant to be judged against.
   */
  priceImpactPercent: number | null
}

const DEBOUNCE_MS = 400

export type OpenStep = 'idle' | 'approving' | 'signing' | 'sending' | 'done' | 'error'

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const)

/**
 * A value key for an `OpenInput`, so staleness can be judged by VALUE rather than by object
 * identity. `input` is not guaranteed to be referentially stable across renders — it is
 * whatever the caller passes, and nothing in this hook's contract requires memoizing it — so
 * comparing `input` objects with `!==` would treat a caller re-creating an equal object every
 * render as a change on every single render, permanently masking a settled preview.
 */
function reserveKey(r: ReserveInfo): string {
  return `${r.address}|${r.symbol}|${r.decimals}|${r.priceUsd}|${r.ltvBps}|${r.liquidationThresholdBps}`
}
function inputKey(input: OpenInput): string {
  return [
    input.contract, input.mode, input.volatile, input.stable,
    input.marginAmount, input.leverageBps, input.slippageBps,
    reserveKey(input.reserves.collateral), reserveKey(input.reserves.debt),
  ].join('|')
}

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
  // The `inputKey` of whichever `input` the two states above were computed for. A mismatch
  // against the current input's key is what marks them stale — see `stale` below. Deriving
  // staleness this way (rather than an effect clearing `preview`/`previewError` via setState)
  // is what keeps the effect from calling setState synchronously in its own body, which trips
  // react-hooks/set-state-in-effect, while still invalidating a stale preview the instant
  // `input` changes — no debounce-length window where it is still live (Task "CRITICAL 2").
  const [previewFor, setPreviewFor] = useState<string | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)
  const [tick, setTick] = useState(0)
  const [step, setStep] = useState<OpenStep>('idle')
  const [txHash, setTxHash] = useState<Hex | undefined>()
  const [execError, setExecError] = useState<string | null>(null)
  const [execRemedy, setExecRemedy] = useState<StrategiesRemedy | null>(null)

  /** Set while a signature is held, to stop the preview moving underneath it (Task 7). */
  const frozen = useRef(false)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    // Frozen: a held signature commits to an exact borrowAmount, so the plan must not move
    // underneath it. Nothing here reads stale — `preview`/`previewError` stay exactly as they
    // were, because `previewFor` (see `stale` below, near the return statement) still matches
    // `input`, which has not changed either.
    if (!input || frozen.current) return

    let cancelled = false
    // Captured once per effect run — stable across the whole async attempt below, and this is
    // what `previewFor` gets set to at the end, however that attempt concludes. Value-based
    // (see `inputKey`), not the `input` reference itself — a caller that does not memoize
    // `input` would otherwise never produce a key that matches a later render's `input`.
    const forInput = inputKey(input)

    const timer = setTimeout(async () => {
      setIsQuoting(true)
      setPreviewError(null)
      try {
        if (!client) {
          setPreviewError({ kind: 'no-client', message: 'Wallet client unavailable.' })
          return
        }

        const { collateral, debtAsset, marginIn } = resolveMode({
          mode: input.mode, volatile: input.volatile, stable: input.stable,
        })
        // resolveMode's "none" (ratchet modes 5/6) has no wiring into this auto-sizing hook yet
        // — that lands with manual-amount entry in a later task. Until then, narrow it away for
        // sizeOpen the same way sizeOpen's own runtime already treats anything but "debt": as
        // the collateral-margin flow.
        const marginInForSizing: MarginIn = marginIn === 'debt' ? 'debt' : 'collateral'

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
          marginIn: marginInForSizing,
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

        // The hard LTV wall, for LEVERAGE_ABOVE_LTV's message — sizeOpen rejects at exactly
        // this ceiling, so it is the number the message should show, not the raw enum name
        // (Task "IMPORTANT 7").
        const hardCeilingBps = leverageCeilingBps({
          ltvBps: coll.ltvBps, liquidationThresholdBps: coll.liquidationThresholdBps,
        }).hard
        const reject = (error: SizeOpenError) => setPreviewError({
          kind: error,
          message: sizeOpenErrorMessage(error, { collateralSymbol: coll.symbol, hardCeilingBps }),
        })

        // The contract swaps borrowAmount PLUS the margin on the debt-margin path — see
        // AaveV3Strategies.sol's `swapIn`. Quoting and building against borrowAmount alone
        // undersizes the trade by exactly marginAmount and reverts on every debt-margin open
        // (Task "CRITICAL 1").
        const swapInFor = (size: { borrowAmount: bigint }) =>
          size.borrowAmount + (marginIn === 'debt' ? input.marginAmount : 0n)

        // Seed off the oracle so the first quote is asked for a plausible size.
        let sized = sizeOpen({ ...sizeArgs, rateWad: rateFromOracle({
          collateralPriceUsd: coll.priceUsd, debtPriceUsd: debt.priceUsd,
          collateralDecimals: coll.decimals, debtDecimals: debt.decimals,
        }) })
        if (!sized.ok) { reject(sized.error); return }

        const allowed = new Set(routers.map((r) => r.toLowerCase()))
        const adapters = getAdaptersForChain(getChainConfig(chainId)?.adapters ?? [])
          .filter((a) => a.supportsExecution)

        const fromAsset = { underlyingAsset: debtAsset, symbol: '', decimals: debt.decimals }
        const toAsset = { underlyingAsset: collateral, symbol: '', decimals: coll.decimals }
        const slippagePercent = Number(input.slippageBps) / 100

        type Candidate = { a: Adapter; q: QuoteResponse }
        // Every candidate quoted in the winning round, ranked best-output-first. Kept as a
        // list (not just the top one) so route selection below can fall through a candidate
        // that fails to build or fails validateSwapTx, instead of erroring out on the first
        // pick — Task "IMPORTANT 3".
        let rankedFinal: Candidate[] = []
        // The sizing whose borrowAmount was actually submitted to getQuote for the round that
        // wins — swapData ends up built against that exact amount, so the preview must report
        // it verbatim. `sized` keeps moving after that (it drives the next round's amountIn,
        // or reflects a re-size the loop never re-quoted), so it is NOT safe to read after the
        // loop: it can be smaller than what was quoted (under-approves the router — reverts)
        // or larger (a position that was never actually priced).
        let quotedSize = sized.size

        for (let round = 0; round < MAX_REFINE_ROUNDS; round++) {
          const amountIn = swapInFor(sized.size).toString()
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

          const ranked = results
            .filter((r): r is Candidate => r !== null)
            .sort((x, y) => (BigInt(y.q.amountOut) > BigInt(x.q.amountOut) ? 1 : -1))
          if (ranked.length === 0) { rankedFinal = []; break }

          rankedFinal = ranked
          quotedSize = sized.size

          const top = ranked[0]
          const resized = sizeOpen({ ...sizeArgs, rateWad: rateFromQuote({
            amountIn: BigInt(top.q.amountIn), amountOut: BigInt(top.q.amountOut),
          }) })
          if (!resized.ok) { reject(resized.error); return }

          // Compare like with like: the round's quoted amountIn is a swapIn (borrow + margin
          // on the debt-margin path), so what it is measured against must be too, or this
          // mistakes an unchanged borrowAmount for a shrunk swapIn and skips a re-quote that
          // was actually warranted.
          const grew = needsRequote(BigInt(top.q.amountIn), swapInFor(resized.size))
          sized = resized
          if (!grew) break
        }

        if (rankedFinal.length === 0) {
          setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
          return
        }

        // Every candidate in rankedFinal was quoted at the same amountIn (one round, one
        // amount), so quotedSize applies to whichever of them ends up buildable — pick the
        // first that survives a real build and the same checks the close flow already runs,
        // rather than building only the top-ranked one and erroring out if it alone fails.
        let quote: QuoteResponse | null = null
        let adapter: Adapter | null = null
        let built: TransactionPayload | null = null
        for (const cand of rankedFinal) {
          let candBuilt: TransactionPayload
          try {
            candBuilt = await cand.a.buildTransaction(cand.q, slippagePercent, input.contract, chainId)
          } catch {
            continue
          }
          if (cancelled) return
          const problem = validateSwapTx(
            { to: candBuilt.to, data: candBuilt.data, value: candBuilt.value, spender: candBuilt.spender },
            allowed.has(candBuilt.to.toLowerCase()),
          )
          if (problem) continue
          quote = cand.q
          adapter = cand.a
          built = candBuilt
          break
        }

        if (!quote || !adapter || !built) {
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
          priceImpactPercent: routeCostPercent(quote.rawAmountInUsd, quote.rawAmountOutUsd),
        })
      } catch {
        if (!cancelled) {
          setPreviewError({ kind: 'quote-failed', message: 'Could not price this position.' })
        }
      } finally {
        if (!cancelled) {
          setIsQuoting(false)
          // Whatever this attempt settled on (a fresh preview, a rejection, or nothing because
          // it was superseded) is now current for forInput — see the note on `previewFor` above.
          setPreviewFor(forInput)
        }
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [input, client, chainId, owner, tick])

  // Masks preview/previewError the instant `input` no longer matches what they were computed
  // for — see the note on `previewFor` above. `execute` and the return value both use these,
  // never the raw state, so nothing downstream can observe a preview that belongs to a
  // different input than the one currently live.
  const stale = (input ? inputKey(input) : null) !== previewFor
  const effectivePreview = stale ? null : preview
  const effectivePreviewError = stale ? null : previewError
  const effectiveIsQuoting = stale || isQuoting

  const execute = useCallback(async () => {
    if (!input || !effectivePreview || !client || !owner) return

    // The delegation signs an exact borrowAmount, so the plan must not move once we start.
    frozen.current = true
    setExecError(null)
    setExecRemedy(null)
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
      const { vDebt: variableDebtToken } = await getReserveTokens(client, chainId, dataProvider, effectivePreview.debtAsset)

      // 1. Approve the margin, unless the allowance already covers it.
      setStep('approving')
      const allowance = (await client.readContract({
        address: effectivePreview.marginAsset, abi: ERC20_ABI, functionName: 'allowance',
        args: [owner, input.contract],
      })) as bigint
      if (allowance < input.marginAmount) {
        await deps.writeContract({
          address: effectivePreview.marginAsset, abi: ERC20_ABI, functionName: 'approve',
          args: [input.contract, input.marginAmount],
        })
      }

      // 2. Delegate credit, unless a standing delegation already covers this borrow.
      setStep('signing')
      const standing = await getDelegationAllowance(client, variableDebtToken, owner, input.contract)
      let delegation = ZERO_STRATEGIES_SIG
      if (standing < effectivePreview.borrowAmount) {
        const ctx = await getPermitContext(client, variableDebtToken, owner)
        const deadline = BigInt(Math.floor(Date.now() / 1000)) + SIGNATURE_TTL_S
        const signature = await deps.signTypedData(
          buildCreditDelegation({
            chainId, debtToken: variableDebtToken, debtTokenName: ctx.name,
            delegatee: input.contract, value: effectivePreview.borrowAmount,
            nonce: ctx.nonce, deadline,
          }),
        )
        delegation = toStrategiesSig(signature, deadline)
      }

      // 3. Send.
      setStep('sending')
      const plan = planOpen({
        mode: input.mode, volatile: input.volatile, stable: input.stable,
        flashAmount: effectivePreview.flashAmount, borrowAmount: effectivePreview.borrowAmount,
        marginAmount: input.marginAmount, minOut: effectivePreview.minOut,
        router: effectivePreview.router, swapData: effectivePreview.swapData, delegation,
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
      setExecRemedy(decoded?.remedy ?? null)
      setStep('error')
    } finally {
      frozen.current = false
      // Re-arm the preview effect now that the freeze is lifting. `frozen` is a ref, so
      // clearing it alone does not trigger a re-render — nothing else would make the effect
      // re-run, and a preview left over from before signing could go stale forever with no
      // input change to prompt a refresh (Task "CRITICAL 2").
      refresh()
    }
  }, [input, effectivePreview, client, owner, chainId, injected, writeContractAsync, signTypedDataAsync, refresh])

  return {
    preview: effectivePreview,
    previewError: effectivePreviewError,
    isQuoting: effectiveIsQuoting,
    refresh, frozen, step, txHash, execError, execRemedy, execute,
  }
}
