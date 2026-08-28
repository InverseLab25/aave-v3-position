import { type Address, type Hex, type PublicClient } from 'viem'
import { getAllowedRouters, getPauseState, resolveMode, BPS } from '../../lib/strategies-sdk'
import {
  deriveOpen,
  projectOpen,
  resolveOpenMode,
  validateSizing,
  type LeverageError,
} from '../../lib/leverage'
import { solveBorrow } from '../../lib/solveBorrow'
import { routeCostPercent } from '../../lib/swapRoute'
import { getAdaptersForChain } from '../../adapters'
import { AggregatorHttpError } from '../../adapters/http'
import type { Adapter, QuoteResponse } from '../../adapters/types'
import { getChainConfig, getTxGasCap } from '../../config/chains'
import { COMPATIBLE_ADAPTERS, selectBuildableRoute } from '../../lib/deleverage'
import { MAX_REFINE_ROUNDS, type LeverageOpenInput, type OpenPreview } from '../open/types'

/**
 * What the debounced preview run needs from the hook.
 *
 * The setters come in rather than the run returning a result, because the run reports several
 * distinct failures on its way through and each sets different wording. Threading those back as
 * return values would rewrite the control flow, and the point of this move is that the control
 * flow does not change.
 *
 * `cancelled` is a getter, not a boolean: the run awaits many times over, and an attempt that
 * has been superseded has to notice in between.
 */
interface PreviewRunContext {
  input: LeverageOpenInput
  /**
   * The borrow a held signature has already committed to, or null when nothing is pinned.
   * Set, the run must reuse it rather than re-solve: the signature authorises this exact figure.
   */
  pinned: bigint | null
  /** The input key this run answers for, stamped so a stale run cannot claim a later one. */
  forInput: string
  client: PublicClient | undefined
  chainId: number
  owner: Address | undefined
  cancelled: () => boolean
  setIsQuoting: (v: boolean) => void
  setPreviewError: (v: LeverageError | null) => void
  /** Why each candidate was unusable. Cleared per run, so a stale reason cannot outlive it. */
  setRejected: (v: string[]) => void
  setPreview: (v: OpenPreview | null) => void
  setPreviewFor: (v: string) => void
}

/** One debounced quote-and-size pass. Everything the preview shows is decided here. */
export async function runPreview(ctx: PreviewRunContext): Promise<void> {
  const {
    input, pinned, forInput, client, chainId, cancelled,
    setIsQuoting, setPreviewError, setPreview, setPreviewFor, setRejected,
  } = ctx

      /**
       * Whether this run produced a route.
       *
       * Every failure below returns early with only an error set, and `previewFor` is stamped in
       * `finally` regardless — which used to leave the PREVIOUS run's preview looking like the
       * answer for these inputs. Confirm stayed enabled on it, so a re-quote that failed after
       * (say) a slippage edit would send calldata built for the tolerance before the edit.
       */
      let produced = false
      setIsQuoting(true)
      setPreviewError(null)
      setRejected([])
      try {
        if (!client) {
          setPreviewError('NO_CLIENT')
          return
        }

        const mode = resolveOpenMode(input.direction, input.marginAsset)
        const { collateral, debtAsset } = resolveMode({
          mode, volatile: input.subject, stable: input.quote,
        })
        const coll = input.reserves.collateral
        const debt = input.reserves.debt

        // Cheap checks before spending a quote. Both denominations share the ceiling check by
        // measuring `maxSupply` in whatever unit `sizedBy` names.
        const typedAmount = input.sizedBy === 'borrow' ? input.borrowAmount : input.supplyAmount
        const sizingError = validateSizing({
          marginAsset: input.marginAsset,
          marginAmount: input.marginAmount,
          supplyAmount: typedAmount,
          marginBalance: input.marginBalance,
          maxSupply: input.maxSupply,
          collateral: input.collateralEnablement,
          // The same prices `solveBorrow` seeds from, so a debt margin the supply cannot absorb
          // is named here rather than surfacing later as an unactionable quote failure.
          pricing: {
            slipNum: BPS - input.slippageBps,
            collateralPriceUsd: coll.priceUsd,
            debtPriceUsd: debt.priceUsd,
            collateralDecimals: coll.decimals,
            debtDecimals: debt.decimals,
          },
        })
        if (sizingError) {
          setPreviewError(sizingError)
          return
        }

        const [{ paused }, routers] = await Promise.all([
          getPauseState(client, input.contract),
          getAllowedRouters(client, input.contract),
        ])
        if (cancelled()) return
        if (paused) {
          setPreviewError('PAUSED')
          return
        }

        const allowed = new Set(routers.map((r) => r.toLowerCase()))
        // Same filter the close flow uses, and for the same reason: `supportsExecution` only
        // says the adapter returns a transaction, not that this contract can execute it. See
        // COMPATIBLE_ADAPTERS — quoting the rest gets them ranked and sized against, then
        // rejected at build, which surfaces as a "rate moved" the user cannot act on.
        const adapters = getAdaptersForChain(getChainConfig(chainId)?.adapters ?? [])
          .filter((a) => (COMPATIBLE_ADAPTERS as readonly string[]).includes(a.name))

        const fromAsset = { underlyingAsset: debtAsset, symbol: '', decimals: debt.decimals }
        const toAsset = { underlyingAsset: collateral, symbol: '', decimals: coll.decimals }
        const slippagePercent = Number(input.slippageBps) / 100

        type Candidate = { a: Adapter; q: QuoteResponse }

        /**
         * Whether an aggregator refused to answer, as opposed to answering with nothing.
         *
         * Sticky for the whole attempt: a route that fails to price after a 429 has not been
         * shown to be unpriceable, and saying so would send the user hunting for liquidity that
         * is very likely there.
         */
        let throttled = false

        /** Every adapter's quote for a given debt-asset input, best output first. */
        const quoteAll = async (swapIn: bigint): Promise<Candidate[]> => {
          const results = await Promise.all(
            adapters.map(async (a) => {
              try {
                const q = await a.getQuote(
                  fromAsset, toAsset, swapIn.toString(), slippagePercent, chainId,
                )
                return q ? { a, q } : null
              } catch (e) {
                if (e instanceof AggregatorHttpError && e.retryable) throttled = true
                return null
              }
            }),
          )
          return results
            .filter((r): r is Candidate => r !== null)
            .sort((x, y) => (BigInt(y.q.amountOut) > BigInt(x.q.amountOut) ? 1 : -1))
        }

        /**
         * "Nothing priced" in the user's terms — which is only NO_ROUTE when the aggregators
         * actually answered.
         */
        const nothingPriced = (): LeverageError =>
          throttled ? 'AGGREGATOR_UNAVAILABLE' : 'NO_ROUTE'

        // Kept as a list so route selection can fall through a candidate that fails to build or
        // fails `validateSwapTx`, instead of erroring out on the first pick.
        let candidates: Candidate[] = []
        let borrowAmount: bigint
        let debtMargin = 0n
        // Provisional on the borrow path: the real flash is read off the BUILT route below,
        // because only the built output is what the swap actually guarantees.
        let flashAmount = 0n

        if (input.sizedBy === 'borrow') {
          // The user named the borrow, so there is nothing to solve — quote it directly. The
          // flash is derived from the route afterwards.
          borrowAmount = input.borrowAmount
          candidates = await quoteAll(borrowAmount)
          if (cancelled()) return
          if (candidates.length === 0) {
            setPreviewError(nothingPriced())
            return
          }
        } else if (pinned !== null) {
          // A signature is held for exactly this borrow, so the solve is skipped and the route is
          // re-priced around the signed figure instead. Whether it still repays the flash is NOT
          // assumed — the shared `guaranteedOut < flashAmount` check below judges that, and
          // reports QUOTE_MOVED once the market has left the signed size behind.
          const derived = deriveOpen({
            marginAsset: input.marginAsset,
            marginAmount: input.marginAmount,
            supplyAmount: input.supplyAmount,
          })
          flashAmount = derived.flashAmount
          debtMargin = derived.debtMargin
          borrowAmount = pinned
          candidates = await quoteAll(borrowAmount + debtMargin)
          if (cancelled()) return
          if (candidates.length === 0) {
            setPreviewError(nothingPriced())
            return
          }
        } else {
          const derived = deriveOpen({
            marginAsset: input.marginAsset,
            marginAmount: input.marginAmount,
            supplyAmount: input.supplyAmount,
          })
          flashAmount = derived.flashAmount
          debtMargin = derived.debtMargin

          const solution = await solveBorrow({
            flashAmount,
            debtMargin,
            slipNum: BPS - input.slippageBps,
            rounds: MAX_REFINE_ROUNDS,
            collateralPriceUsd: coll.priceUsd,
            debtPriceUsd: debt.priceUsd,
            collateralDecimals: coll.decimals,
            debtDecimals: debt.decimals,
            quoteAt: async (swapIn) => {
              candidates = await quoteAll(swapIn)
              return candidates.map((c) => c.q)
            },
          })
          if (cancelled()) return
          if (!solution.ok) {
            setPreviewError(solution.error === 'NO_ROUTE' ? nothingPriced() : 'QUOTE_FAILED')
            return
          }
          borrowAmount = solution.solved.borrowAmount
        }

        // Build FIRST, then validate what was actually built. The list is best-output-first, so
        // a fallback prices strictly worse than the route the borrow was solved against. The
        // walk is shared with the close flow so the allowlist and calldata checks cannot drift.
        const { selected, rejected } = await selectBuildableRoute(candidates, {
          build: (c) => c.a.buildTransaction(c.q, slippagePercent, input.contract, chainId),
          isAllowlisted: (router) => allowed.has(router.toLowerCase()),
          label: (c) => c.a.name,
          txGasCap: getTxGasCap(chainId),
          cancelled,
        })
        // A null here can also mean "cancelled mid-build" — check `cancelled` first, or a
        // superseded attempt writes a no-route error that a reverted input would make current.
        if (cancelled()) return
        if (!selected) {
          setRejected(rejected)
          setPreviewError(nothingPriced())
          return
        }
        const build = { quote: selected.candidate.q, adapter: selected.candidate.a, built: selected.tx }

        // The BUILT route's output, not the quote's: `buildTransaction`'s amountOut is
        // re-simulated and documented as authoritative, and it is what `minOut` derives from.
        const builtOut = BigInt(build.built.amountOut ?? build.quote.amountOut)
        // What this route contractually guarantees to deliver.
        const guaranteedOut = (builtOut * (BPS - input.slippageBps)) / BPS

        if (input.sizedBy === 'borrow') {
          // Flash exactly what the swap is guaranteed to return. The contract needs
          // `received >= flashAmount` (:501) and `received >= minOut` (:499), and both are this
          // same floor — so the repayment cannot come up short however the route lands, and
          // whatever it beats the floor by is supplied as surplus (:506-513).
          flashAmount = guaranteedOut
          if (flashAmount <= 0n) {
            setPreviewError('QUOTE_FAILED')
            return
          }
        } else if (guaranteedOut < flashAmount) {
          // The borrow was solved against the quote; the build can come back worse. That is a
          // moving market rather than anything the user got wrong — re-solving here would race
          // the same drift, so ask for a refresh instead. Nothing unsafe reaches the chain
          // either way: `minOut` floors at `flashAmount` below.
          setPreviewError('QUOTE_MOVED')
          return
        }

        if (borrowAmount <= 0n) {
          setPreviewError('ZERO_BORROW')
          return
        }

        // The swap input the contract will actually make: borrow PLUS the margin on the debt
        // path — AaveV3Strategies.sol:491. Scaled off the built route's realized rate.
        const swapIn = borrowAmount + debtMargin
        const quotedIn = BigInt(build.quote.amountIn)
        const expectedSwapOut = quotedIn > 0n ? (swapIn * builtOut) / quotedIn : 0n

        const projection = projectOpen({
          marginAsset: input.marginAsset,
          marginAmount: input.marginAmount,
          borrowAmount,
          expectedSwapOut,
          collateralPriceUsd: coll.priceUsd,
          debtPriceUsd: debt.priceUsd,
          collateralDecimals: coll.decimals,
          debtDecimals: debt.decimals,
          ltvBps: coll.ltvBps,
          liquidationThresholdBps: coll.liquidationThresholdBps,
          existingCollateralUsd: input.existingCollateralUsd,
          existingDebtUsd: input.existingDebtUsd,
          existingLtvBps: input.existingLtvBps,
          existingLiquidationThresholdBps: input.existingLiquidationThresholdBps,
        })

        // Aave's `borrow` reverts at the LTV wall, so land strictly below it. The wall is the
        // account's BLENDED LTV, which is what `validateBorrow` actually compares against — and
        // not generally the reserve's own, which is what `maxSupply` was computed from.
        if (projection.impliedLtvBps >= projection.avgLtvBps) {
          setPreviewError('LTV_EXCEEDED')
          return
        }

        // Never below `flashAmount`: the contract enforces both floors, and an output short of
        // the flash repayment reverts the whole transaction rather than merely disappointing.
        produced = true
        setPreview({
          collateral,
          debtAsset,
          // Must agree with planOpen, which routes everything but "debt" through the collateral
          // entry point. This drives which ERC-20 allowance `execute` checks, so a disagreement
          // approves the wrong token.
          marginAsset: input.marginAsset === 'debt' ? debtAsset : collateral,
          flashAmount,
          borrowAmount,
          swapIn,
          expectedOut: builtOut,
          minOut: guaranteedOut > flashAmount ? guaranteedOut : flashAmount,
          projection,
          router: build.built.to as Address,
          swapData: build.built.data as Hex,
          aggregator: build.adapter.name,
          priceImpactPercent: routeCostPercent(build.quote.rawAmountInUsd, build.quote.rawAmountOutUsd),
        })
      } catch {
        if (!cancelled()) setPreviewError('QUOTE_FAILED')
      } finally {
        if (!cancelled()) {
          setIsQuoting(false)
          // No route for these inputs is an answer too — and it is NOT the last one's route.
          if (!produced) setPreview(null)
          setPreviewFor(forInput)
        }
      }
}
