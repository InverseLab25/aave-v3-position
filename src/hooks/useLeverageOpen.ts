/**
 * Orchestrates opening a leveraged position: preview here, execute in the same hook.
 *
 * The preview is solve → build → validate. `solveBorrow` works out what has to be borrowed for
 * the swap to repay the flash, the winning route is built, and the built figures — not the
 * quote's — are what the projection and `minOut` are taken from.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChainId, useConnection, usePublicClient, useSignTypedData, useWriteContract } from 'wagmi'
import { parseAbi, type Address, type Hex } from 'viem'
import {
  getAllowedRouters,
  getDelegationAllowance,
  getPauseState,
  getPermitContext,
  resolveMode,
  planOpen,
  buildCreditDelegation,
  toStrategiesSig,
  ZERO_STRATEGIES_SIG,
  aaveV3StrategiesAbi,
  BPS,
} from '../lib/strategies-sdk'
import type { StrategiesSig } from '../lib/strategies-sdk'
import {
  deriveOpen,
  projectOpen,
  resolveOpenMode,
  validateSizing,
  type CollateralEnablement,
  type Direction,
  type LeverageError,
  type MarginLocation,
  type OpenProjection,
} from '../lib/leverage'
import { seedBorrow, solveBorrow } from '../lib/solveBorrow'
import {
  browserStorage,
  canReuseDelegation,
  clearDelegation,
  delegationKey,
  loadDelegation,
  MIN_DELEGATION_REMAINING_S,
  saveDelegation,
  withinAdoptionBand,
  type HeldDelegation,
} from '../lib/delegationCache'
import { routeCostPercent } from '../lib/swapRoute'
import { getAdaptersForChain } from '../adapters'
import type { Adapter, QuoteResponse } from '../adapters/types'
import { getChainConfig } from '../config/chains'
import { getPoolDataProvider, getReserveTokens } from '../lib/aaveStatics'
import { COMPATIBLE_ADAPTERS, selectBuildableRoute } from '../lib/deleverage'
import { decodeStrategiesError } from '../lib/strategiesErrors'
import type { StrategiesRemedy } from '../lib/strategiesErrors'
import { extractRevertMessage } from '../utils/errors'

export interface ReserveInfo {
  address: Address
  symbol: string
  decimals: number
  /** Aave market-reference price, 8 decimals. */
  priceUsd: bigint
  ltvBps: bigint
  liquidationThresholdBps: bigint
}

export interface LeverageOpenInput {
  contract: Address
  direction: Direction
  marginAsset: MarginLocation
  /** The asset being longed or shorted, and the asset quoted against it. */
  subject: Address
  quote: Address
  marginAmount: bigint
  /**
   * How the position is sized.
   *
   * `supply` is the normal path: the user names what lands in the pool and the borrow is SOLVED
   * from the flash it has to repay. `borrow` is the boost path's alternative denomination: the
   * user names the borrow, and the flash is set to the swap's GUARANTEED output — so the
   * repayment is covered by construction there too, and any surplus is supplied
   * (AaveV3Strategies.sol:506-513).
   */
  sizedBy: 'supply' | 'borrow'
  /** What lands in the pool, in COLLATERAL wei. Zero when `sizedBy` is `borrow`. */
  supplyAmount: bigint
  /** What to borrow, in DEBT wei. Zero when `sizedBy` is `supply`. */
  borrowAmount: bigint
  /** From `maxSupplyAmount`/`maxBorrowAmount`, in whichever unit `sizedBy` names. */
  maxSupply: bigint
  slippageBps: bigint
  reserves: { collateral: ReserveInfo; debt: ReserveInfo }
  /** Wallet balance of the margin asset. */
  marginBalance: bigint
  /** `getUserAccountData` totals, 8dp USD — folded in so the health factor is account-wide. */
  existingCollateralUsd: bigint
  existingDebtUsd: bigint
  /** That account's collateral-weighted LTV and threshold, bps, eMode included. */
  existingLtvBps: bigint
  existingLiquidationThresholdBps: bigint
  /**
   * Whether Aave will actually count the incoming supply toward borrow power — see
   * `collateralEnablement`. Null when the caller has not resolved the reserve config, which
   * skips the check rather than blocking every open on a missing read.
   */
  collateralEnablement?: CollateralEnablement | null
}

export interface OpenPreview {
  collateral: Address
  debtAsset: Address
  marginAsset: Address
  flashAmount: bigint
  borrowAmount: bigint
  /**
   * What the router is actually handed: `borrowAmount` PLUS the margin when that margin is posted
   * in the debt asset, which goes into the same swap (AaveV3Strategies.sol:491). Distinct from
   * `borrowAmount` on purpose — quoting a rate against the borrow alone understates the input by
   * the whole margin, which reads as a rate far better than the market's.
   */
  swapIn: bigint
  /**
   * What the built route says it will return, BEFORE the slippage floor is applied — the
   * aggregator's own `amountOut`. `minOut` is this times `(1 - slippage)`, so the pair of them is
   * "what we expect" against "what the transaction will still accept".
   */
  expectedOut: bigint
  minOut: bigint
  /** What the account becomes, verified against the built route rather than the oracle. */
  projection: OpenProjection
  router: Address
  swapData: Hex
  /** Aggregator name, for display. */
  aggregator: string
  /**
   * What the route costs as a percentage of value put in — the aggregator's own USD figures for
   * both sides, so it folds in price impact, DEX fees and spread. Null when the aggregator did
   * not price both sides. Judge against `PRICE_IMPACT_*` in `swapRoute.ts`.
   */
  priceImpactPercent: number | null
}

const DEBOUNCE_MS = 400

/** Solve, then at most one correction. Pricing is non-linear; a third round buys nothing. */
const MAX_REFINE_ROUNDS = 2

/**
 * `ready` is the gate: approved and delegated, nothing sent. The user is looking at the position
 * with the wallet work already behind them, and the send waits on a second press.
 */
export type OpenStep = 'idle' | 'approving' | 'signing' | 'ready' | 'sending' | 'done' | 'error'

/** What the wallet has already granted, carried from `prepare` to `submit`. */
interface PreparedOpen {
  delegation: StrategiesSig
  /** The exact borrow a fresh or reused SIGNATURE covers. Null when a standing allowance did. */
  signedValue: bigint | null
  /** The on-chain delegation allowance read at prepare time — the ceiling in the null case. */
  standingAllowance: bigint
}

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const)

/** How long a delegation signature stays valid. Long enough to survive a build and inclusion. */
const SIGNATURE_TTL_S = 1800n

/**
 * A value key for an input, so staleness is judged by VALUE rather than object identity.
 *
 * `input` is not guaranteed to be referentially stable — it is whatever the caller passes — so
 * comparing references would treat a caller re-creating an equal object every render as a change
 * on every render, permanently masking a settled preview.
 */
function reserveKey(r: ReserveInfo): string {
  return `${r.address}|${r.decimals}|${r.priceUsd}|${r.ltvBps}|${r.liquidationThresholdBps}`
}
function inputKey(i: LeverageOpenInput): string {
  return [
    i.contract, i.direction, i.marginAsset, i.subject, i.quote,
    i.marginAmount, i.sizedBy, i.supplyAmount, i.borrowAmount, i.maxSupply,
    i.slippageBps, i.marginBalance,
    i.existingCollateralUsd, i.existingDebtUsd, i.existingLtvBps, i.existingLiquidationThresholdBps,
    reserveKey(i.reserves.collateral), reserveKey(i.reserves.debt),
    // Folded in because it changes both the sizing verdict and the projection's LTV inputs, so a
    // preview computed before the reserve config resolved must not survive it arriving.
    i.collateralEnablement === null || i.collateralEnablement === undefined
      ? '-'
      : `${i.collateralEnablement.willCount}:${i.collateralEnablement.reason ?? ''}`,
  ].join('|')
}

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
 * `injected` is a PARTIAL override, not an all-or-nothing swap: a caller stubbing only
 * `signTypedData` still gets the real `writeContract` wired to wagmi underneath. That is also why
 * the wagmi hooks below are called unconditionally — rules of hooks, and the merge needs both.
 */
export function useLeverageOpen(input: LeverageOpenInput | null, injected?: Partial<OpenDeps>) {
  const client = usePublicClient()
  const chainId = useChainId()
  const { address: owner } = useConnection()

  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()

  const [preview, setPreview] = useState<OpenPreview | null>(null)
  const [previewError, setPreviewError] = useState<LeverageError | null>(null)
  // The `inputKey` the two states above were computed for. A mismatch marks them stale — see
  // `stale` below. Deriving staleness this way (rather than an effect clearing them via
  // setState) keeps the effect from calling setState in its own body, while still invalidating
  // the instant `input` changes — no debounce-length window where a stale preview is still live.
  const [previewFor, setPreviewFor] = useState<string | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)
  const [tick, setTick] = useState(0)
  const [step, setStep] = useState<OpenStep>('idle')
  const [txHash, setTxHash] = useState<Hex | undefined>()
  const [execError, setExecError] = useState<string | null>(null)
  const [execRemedy, setExecRemedy] = useState<StrategiesRemedy | null>(null)

  /** Set while a signature is being spent, to stop the preview moving underneath it. */
  const frozen = useRef(false)

  /**
   * What {@link prepare} authorised, held for {@link submit} to spend.
   *
   * A ref rather than state because nothing renders from it and, more to the point, `submit` must
   * read what was actually signed rather than whatever a re-render has since produced.
   */
  const prepared = useRef<PreparedOpen | null>(null)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  /**
   * Clears the record of the last attempt.
   *
   * `step` and `txHash` outlive the modal they were produced in, so without this a second open
   * starts already showing the previous one's receipt — and its Confirm button hidden behind a
   * "done" that belongs to a transaction the user has already seen.
   */
  const reset = useCallback(() => {
    setStep('idle')
    setTxHash(undefined)
    setExecError(null)
    setExecRemedy(null)
    // The grant belongs to the attempt being forgotten. Carrying it into the next one would let a
    // send go out against an authorisation the user took for a position they then walked away
    // from — and `submit`'s coverage check is the only thing that would catch it.
    prepared.current = null
  }, [])

  /**
   * What a held signature would be filed under — chain, owner and the UNDERLYING debt asset.
   *
   * Keyed on the underlying rather than the variable-debt token because the underlying is known
   * from the form alone, while the vDebt address takes two on-chain reads that only `execute`
   * performs. The vDebt address is stored inside the entry instead and verified before reuse.
   */
  const storageKey = (() => {
    if (!input || !owner) return null
    const mode = resolveOpenMode(input.direction, input.marginAsset)
    const { debtAsset } = resolveMode({ mode, volatile: input.subject, stable: input.quote })
    return delegationKey({ chainId, owner, debtAsset })
  })()

  /**
   * Storage is the single copy, re-read rather than mirrored into state.
   *
   * Every write below bumps `storageTick`, which is what makes the read re-run — so there is no
   * second copy to drift, and no effect setting state from a load. It also means a signature
   * taken in another tab is picked up by the next thing that renders here.
   */
  const [storageTick, setStorageTick] = useState(0)
  const held = useMemo(() => {
    // The dependency that does the work: nothing about the READ changes when a signature is taken
    // or dropped, only the bytes behind it, so the tick is what re-runs this.
    void storageTick
    return storageKey ? loadDelegation(browserStorage(), storageKey) : null
  }, [storageKey, storageTick])

  const forget = useCallback(() => {
    if (storageKey) clearDelegation(browserStorage(), storageKey)
    setStorageTick((t) => t + 1)
  }, [storageKey])

  /**
   * Drops the signature the moment it stops being usable.
   *
   * The clock lives HERE rather than in the reuse checks below, which is what keeps those pure:
   * asking `Date.now()` during render makes the pin flip on whichever render happens to straddle
   * the deadline. A timeout fires once, at the deadline, and everything downstream can then treat
   * whatever is held as live. An already-lapsed entry schedules at zero and is gone next tick.
   */
  useEffect(() => {
    if (!held) return
    const now = BigInt(Math.floor(Date.now() / 1000))
    const msLeft = Number(held.deadline - MIN_DELEGATION_REMAINING_S - now) * 1000
    const id = setTimeout(forget, msLeft > 0 ? msLeft : 0)
    return () => clearTimeout(id)
  }, [held, forget])

  /**
   * The borrow the quote must hit, when a held signature is worth keeping.
   *
   * A delegation authorises ONE exact borrow (AaveV3Strategies.sol:287,343), so reusing a
   * signature means pinning the position to the figure it was signed over and re-pricing only the
   * route around it. Without that, every refresh re-solves the borrow, moves it by a wei or more,
   * and invalidates the very signature this cache exists to preserve.
   *
   * Only on the supply path: when the user typed the BORROW there is nothing to solve, so the
   * figure already is whatever they asked for and a pin would be a no-op.
   *
   * The adoption band is measured against the SEEDED borrow — what `solveBorrow` itself starts
   * from — because this decision has to be made before the solve it replaces.
   */
  const pinnedBorrow = (() => {
    if (!input || !held || input.sizedBy !== 'supply') return null
    const { flashAmount, debtMargin } = deriveOpen({
      marginAsset: input.marginAsset,
      marginAmount: input.marginAmount,
      supplyAmount: input.supplyAmount,
    })
    const seed = seedBorrow({
      flashAmount,
      debtMargin,
      slipNum: BPS - input.slippageBps,
      collateralPriceUsd: input.reserves.collateral.priceUsd,
      debtPriceUsd: input.reserves.debt.priceUsd,
      collateralDecimals: input.reserves.collateral.decimals,
      debtDecimals: input.reserves.debt.decimals,
    })
    if (seed === null || !withinAdoptionBand(held.value, seed)) return null
    return held.value
  })()

  /**
   * The quoting effect is keyed on this string, NOT on `input`'s identity.
   *
   * Callers build `input` inline on every render — LeveragePanel does, deliberately — so its
   * identity changes constantly while its values do not. Keying the effect on the object made
   * every render re-quote, and a finished quote calls `setPreview` with a fresh object, which
   * renders, which re-quotes: a self-sustaining loop roughly one debounce plus one round-trip
   * long. `isQuoting` was then true nearly continuously, leaving the Open button perpetually
   * disabled and showing "Pricing…".
   *
   * (A comment here used to claim the React Compiler memoized the caller's object. It is not
   * installed and not configured in vite.config.ts, so nothing was memoizing anything.)
   */
  // The pin is folded in because it changes what the quote is FOR: a preview solved freely and
  // one priced at a pinned borrow are different plans, and switching between them must re-quote.
  const key = input ? `${inputKey(input)}|pin:${pinnedBorrow ?? '-'}` : null
  // Carries the live object into an effect that must not depend on its identity. Every value the
  // effect reads is folded into `key`, so a run always sees an object matching the key it fired
  // for. Synced in its own effect, declared FIRST: effects run in declaration order within a
  // commit, so the quoting effect below always observes the object from this same render.
  const inputRef = useRef(input)
  const pinRef = useRef(pinnedBorrow)
  useEffect(() => {
    inputRef.current = input
    pinRef.current = pinnedBorrow
  })

  useEffect(() => {
    const input = inputRef.current
    const pinned = pinRef.current
    // Frozen: a held signature commits to an exact borrowAmount, so the plan must not move
    // underneath it. Nothing goes stale — `previewFor` still matches `input`, which has not
    // changed either.
    if (!input || !key || frozen.current) return

    let cancelled = false
    const forInput = key

    const timer = setTimeout(async () => {
      setIsQuoting(true)
      setPreviewError(null)
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
        if (cancelled) return
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

        /** Every adapter's quote for a given debt-asset input, best output first. */
        const quoteAll = async (swapIn: bigint): Promise<Candidate[]> => {
          const results = await Promise.all(
            adapters.map(async (a) => {
              try {
                const q = await a.getQuote(
                  fromAsset, toAsset, swapIn.toString(), slippagePercent, chainId,
                )
                return q ? { a, q } : null
              } catch {
                return null
              }
            }),
          )
          return results
            .filter((r): r is Candidate => r !== null)
            .sort((x, y) => (BigInt(y.q.amountOut) > BigInt(x.q.amountOut) ? 1 : -1))
        }

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
          if (cancelled) return
          if (candidates.length === 0) {
            setPreviewError('NO_ROUTE')
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
          if (cancelled) return
          if (candidates.length === 0) {
            setPreviewError('NO_ROUTE')
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
          if (cancelled) return
          if (!solution.ok) {
            setPreviewError(solution.error === 'NO_ROUTE' ? 'NO_ROUTE' : 'QUOTE_FAILED')
            return
          }
          borrowAmount = solution.solved.borrowAmount
        }

        // Build FIRST, then validate what was actually built. The list is best-output-first, so
        // a fallback prices strictly worse than the route the borrow was solved against. The
        // walk is shared with the close flow so the allowlist and calldata checks cannot drift.
        const { selected } = await selectBuildableRoute(candidates, {
          build: (c) => c.a.buildTransaction(c.q, slippagePercent, input.contract, chainId),
          isAllowlisted: (router) => allowed.has(router.toLowerCase()),
          label: (c) => c.a.name,
          cancelled: () => cancelled,
        })
        // A null here can also mean "cancelled mid-build" — check `cancelled` first, or a
        // superseded attempt writes a no-route error that a reverted input would make current.
        if (cancelled) return
        if (!selected) {
          setPreviewError('NO_ROUTE')
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
        if (!cancelled) setPreviewError('QUOTE_FAILED')
      } finally {
        if (!cancelled) {
          setIsQuoting(false)
          setPreviewFor(forInput)
        }
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [key, client, chainId, owner, tick])

  // Masks preview/previewError the instant `input` no longer matches what they were computed
  // for. `execute` and the return value both use these, never the raw state, so nothing
  // downstream can observe a preview belonging to a different input than the one live.
  const stale = key !== previewFor
  const effectivePreview = stale ? null : preview
  const effectivePreviewError = stale ? null : previewError
  const effectiveIsQuoting = stale || isQuoting

  const deps = useCallback(
    (): OpenDeps => ({
      writeContract:
        injected?.writeContract ??
        ((args) => writeContractAsync(args as Parameters<typeof writeContractAsync>[0])),
      signTypedData:
        injected?.signTypedData ??
        ((payload) => signTypedDataAsync(payload as Parameters<typeof signTypedDataAsync>[0])),
    }),
    [injected, writeContractAsync, signTypedDataAsync],
  )

  /**
   * Everything the wallet has to be asked for, before anything irreversible happens on-chain.
   *
   * Split out of the send so the user gets a last look at a position that is already authorised:
   * the approve and the delegation are done, the modal opens, and nothing reaches the pool until
   * they press again. The cost of that ordering is that a cancel at the modal has already spent
   * an approve and a signature — deliberate, and the reason the signature is banked below.
   *
   * Returns whether the wallet granted everything, because the caller opens the confirmation on
   * the strength of it — and `step` is state, which an awaiting caller cannot read back in time.
   */
  const prepare = useCallback(async (): Promise<boolean> => {
    if (!input || !effectivePreview || !client || !owner) return false

    // The delegation signs an exact borrowAmount, so the plan must not move once we start.
    frozen.current = true
    setExecError(null)
    setExecRemedy(null)
    try {
      const chainConfig = getChainConfig(chainId)
      if (!chainConfig) throw new Error('Unsupported chain')
      const dataProvider = await getPoolDataProvider(client, chainId, chainConfig.aave.poolAddressesProvider)
      const { vDebt: variableDebtToken } = await getReserveTokens(
        client, chainId, dataProvider, effectivePreview.debtAsset,
      )

      // 1. Approve the margin, unless the allowance already covers it.
      setStep('approving')
      const allowance = (await client.readContract({
        address: effectivePreview.marginAsset, abi: ERC20_ABI, functionName: 'allowance',
        args: [owner, input.contract],
      })) as bigint
      if (allowance < input.marginAmount) {
        await deps().writeContract({
          address: effectivePreview.marginAsset, abi: ERC20_ABI, functionName: 'approve',
          args: [input.contract, input.marginAmount],
        })
      }

      // 2. Delegate credit, unless a standing delegation already covers this borrow.
      setStep('signing')
      const standing = await getDelegationAllowance(client, variableDebtToken, owner, input.contract)
      let delegation = ZERO_STRATEGIES_SIG
      if (standing < effectivePreview.borrowAmount) {
        // Read either way: the nonce is what proves a held signature was never spent, so it is
        // needed to decide on reuse just as much as it is needed to take a fresh signature.
        const ctx = await getPermitContext(client, variableDebtToken, owner)
        const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
        const need = {
          chainId, owner,
          debtAsset: effectivePreview.debtAsset,
          debtToken: variableDebtToken,
          delegatee: input.contract,
          nonce: ctx.nonce,
          value: effectivePreview.borrowAmount,
          nowSeconds,
        }

        if (held && canReuseDelegation(held, need)) {
          // Nothing to prompt for. This is the retry after a revert or a stale route: the
          // signature was never consumed, so the same one authorises this attempt.
          delegation = toStrategiesSig(held.signature, held.deadline)
        } else {
          const deadline = nowSeconds + SIGNATURE_TTL_S
          const signature = await deps().signTypedData(
            buildCreditDelegation({
              chainId, debtToken: variableDebtToken, debtTokenName: ctx.name,
              delegatee: input.contract, value: effectivePreview.borrowAmount,
              nonce: ctx.nonce, deadline,
            }),
          )
          // Banked BEFORE the send, which is the only ordering that helps: what has to survive is
          // precisely the attempt that fails after this point.
          const fresh: HeldDelegation = {
            chainId, owner,
            debtAsset: need.debtAsset,
            debtToken: need.debtToken,
            delegatee: need.delegatee,
            nonce: need.nonce,
            value: need.value,
            deadline,
            signature,
          }
          saveDelegation(browserStorage(), fresh)
          setStorageTick((t) => t + 1)
          delegation = toStrategiesSig(signature, deadline)
        }
      }

      // Authorised, not opened. What the borrow was authorised FOR is recorded alongside it,
      // because the modal keeps re-pricing from here and `submit` has to know whether the route
      // it ends up sending still falls inside this grant.
      prepared.current = {
        delegation,
        signedValue: standing < effectivePreview.borrowAmount ? effectivePreview.borrowAmount : null,
        standingAllowance: standing,
      }
      setStep('ready')
      return true
    } catch (err) {
      const decoded = decodeStrategiesError(err)
      setExecError(decoded?.message ?? extractRevertMessage(err))
      setExecRemedy(decoded?.remedy ?? null)
      setStep('error')
      return false
    } finally {
      frozen.current = false
      // Re-arm the preview effect now the freeze is lifting. `frozen` is a ref, so clearing it
      // alone does not re-render — a preview left over from before signing could otherwise go
      // stale forever with no input change to prompt a refresh.
      refresh()
    }
  }, [input, effectivePreview, client, owner, chainId, deps, refresh, held])

  /**
   * The send, against whatever route is on screen at the moment it is pressed.
   *
   * The route is deliberately the CURRENT one rather than the one `prepare` saw: the modal
   * re-prices while it is open precisely so the calldata is seconds old, and holding the older
   * route would give that back. The borrow is the part that may not move, so it is checked.
   */
  const submit = useCallback(async () => {
    const authorisation = prepared.current
    // Nothing has been authorised, so a send would revert on the delegation check and cost the
    // gas to find out. The caller is expected to have run `prepare` first.
    if (!authorisation) return
    if (!input || !effectivePreview || !client || !owner) return

    // A delegation signature authorises ONE exact figure (AaveV3Strategies.sol:287,343); a
    // standing allowance authorises anything up to its ceiling. Either way, a borrow outside what
    // was granted reverts — and the pin only holds the figure still while the signature lives, so
    // one timing out mid-modal lands exactly here.
    const covered =
      authorisation.signedValue !== null
        ? effectivePreview.borrowAmount === authorisation.signedValue
        : effectivePreview.borrowAmount <= authorisation.standingAllowance
    if (!covered) {
      setExecError(
        'The route re-priced past the borrow you authorised. Nothing was submitted — re-sign at the new size to continue.',
      )
      setExecRemedy(null)
      setStep('error')
      return
    }

    frozen.current = true
    setExecError(null)
    setExecRemedy(null)
    try {
      setStep('sending')
      const plan = planOpen({
        mode: resolveOpenMode(input.direction, input.marginAsset),
        volatile: input.subject, stable: input.quote,
        flashAmount: effectivePreview.flashAmount, borrowAmount: effectivePreview.borrowAmount,
        marginAmount: input.marginAmount, minOut: effectivePreview.minOut,
        router: effectivePreview.router, swapData: effectivePreview.swapData,
        delegation: authorisation.delegation,
      })
      const hash = await deps().writeContract({
        address: input.contract, abi: aaveV3StrategiesAbi,
        functionName: plan.functionName, args: plan.args,
      })
      setTxHash(hash)
      setStep('done')
      // Submitted, so this signature has done its job. Holding it past that would leave a live
      // grant in storage for a flow that has nothing left to retry, and would let a second
      // transaction be built against a nonce the first one is already spending.
      prepared.current = null
      forget()
    } catch (err) {
      const decoded = decodeStrategiesError(err)
      setExecError(decoded?.message ?? extractRevertMessage(err))
      setExecRemedy(decoded?.remedy ?? null)
      // The authorisation SURVIVES a failed send: the nonce is unspent, so the retry is what the
      // banked signature exists for. Clearing it here would re-prompt for nothing.
      setStep('error')
    } finally {
      frozen.current = false
      refresh()
    }
  }, [input, effectivePreview, client, owner, deps, refresh, forget])

  /**
   * A held signature that authorises exactly the borrow now on screen — what the modal reports as
   * "no wallet prompt needed".
   *
   * Advisory rather than a promise: the nonce is only read inside `execute`, so a delegation that
   * landed from another tab still costs a prompt. It cannot be wrong in the dangerous direction —
   * a signature shown here and then re-prompted for is a mild surprise, whereas one silently
   * reused for a different borrow would not recover the signer at all.
   */
  const reusableSignature =
    held !== null &&
    effectivePreview !== null &&
    held.value === effectivePreview.borrowAmount
      ? { value: held.value, deadline: held.deadline }
      : null

  return {
    preview: effectivePreview,
    previewError: effectivePreviewError,
    isQuoting: effectiveIsQuoting,
    refresh, step, txHash, execError, execRemedy,
    /** Approve and delegate. Prompts the wallet; opens nothing. */
    prepare,
    /** Send what `prepare` authorised, against the route currently on screen. */
    submit,
    /** Forgets the last attempt's step, hash and error — call when a fresh confirmation opens. */
    reset,
    /** Non-null when the next open would spend a signature already taken. */
    reusableSignature,
    /** The borrow the quote is currently pinned to, or null when it is solved freely. */
    pinnedBorrow,
    /** Drop the held signature, unpinning the borrow so the next quote sizes itself again. */
    forgetSignature: forget,
  }
}
