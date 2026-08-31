import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useChainId,
  useConnection,
  usePublicClient,
  useSignTypedData,
  useWriteContract,
} from 'wagmi'
import { type Hex } from 'viem'
import { resolveMode, BPS } from '../lib/strategies-sdk'
import { deriveOpen, resolveOpenMode, type LeverageError } from '../lib/leverage'
import { seedBorrow } from '../lib/solveBorrow'
import {
  browserStorage,
  clearDelegation,
  delegationKey,
  loadDelegation,
  MIN_DELEGATION_REMAINING_S,
  withinAdoptionBand,
} from '../lib/delegationCache'
import type { TxOutcome } from '../lib/txOutcome'
import { clearQuoteCache } from '../adapters/http'
import type { QuoteResponse } from '../adapters/types'
import type { StrategiesRemedy } from '../lib/strategiesErrors'
import {
  DEBOUNCE_MS,
  inputKey,
  type LeverageOpenInput,
  type OpenDeps,
  type OpenPreview,
  type OpenStep,
  type PreparedOpen,
  type ReserveInfo,
} from './open/types'
import { runPreview } from './open/preview'
import { prepareOpen, submitOpen } from './open/execute'

// Re-exported so consumers keep importing the flow's vocabulary from the hook itself.
export type { LeverageOpenInput, OpenDeps, OpenPreview, OpenStep, ReserveInfo }


/**
 * `injected` is a PARTIAL override, not an all-or-nothing swap: a caller stubbing only
 * `signTypedData` still gets the real `writeContract` wired to wagmi underneath. That is also why
 * the wagmi hooks below are called unconditionally — rules of hooks, and the merge needs both.
 */
export function useLeverageOpen(input: LeverageOpenInput | null, injected?: Partial<OpenDeps>) {
  const client = usePublicClient()
  const chainId = useChainId()
  const { address: owner } = useConnection()

  const { mutateAsync: writeContractAsync } = useWriteContract()
  const { mutateAsync: signTypedDataAsync } = useSignTypedData()

  const [preview, setPreview] = useState<OpenPreview | null>(null)
  const [previewError, setPreviewError] = useState<LeverageError | null>(null)
  // The `inputKey` the two states above were computed for. A mismatch marks them stale — see
  // `stale` below. Deriving staleness this way (rather than an effect clearing them via
  // setState) keeps the effect from calling setState in its own body, while still invalidating
  // the instant `input` changes — no debounce-length window where a stale preview is still live.
  const [previewFor, setPreviewFor] = useState<string | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)
  const [tick, setTick] = useState(0)
  /** Why the last run found no usable route. Empty unless `previewError` is NO_ROUTE. */
  const [rejected, setRejected] = useState<string[]>([])
  /** Every aggregator that priced the last run, best-first. What the route picker lists. */
  const [routes, setRoutes] = useState<QuoteResponse[]>([])
  const [step, setStep] = useState<OpenStep>('idle')
  const [txHash, setTxHash] = useState<Hex | undefined>()
  const [execError, setExecError] = useState<string | null>(null)
  /** What the last open actually did, read off its receipt. Null until one lands. */
  const [outcome, setOutcome] = useState<TxOutcome | null>(null)
  const [execRemedy, setExecRemedy] = useState<StrategiesRemedy | null>(null)
  /**
   * Something worth saying about the receipt that is NOT a failure.
   *
   * Separate from `execError` on purpose. A timeout or an unreadable receipt leaves a submitted
   * transaction whose fate is unknown, and putting that in the error channel would tell a user the
   * open failed when it may well have succeeded.
   */
  const [settleNote, setSettleNote] = useState<string | null>(null)

  /** Set while a signature is being spent, to stop the preview moving underneath it. */
  const frozen = useRef(false)

  /**
   * What {@link prepare} authorised, held for {@link submit} to spend.
   *
   * A ref rather than state because nothing renders from it and, more to the point, `submit` must
   * read what was actually signed rather than whatever a re-render has since produced.
   */
  const prepared = useRef<PreparedOpen | null>(null)

  /**
   * The send this screen is currently about.
   *
   * The receipt read outlives `submit` by design, so by the time one resolves the user may have
   * abandoned that attempt and started another. A receipt for anything but the current hash is
   * not ours to report: it would caption this attempt with the last one's numbers, and the
   * history — filed against whatever hash is on screen — would pair the two.
   */
  const currentSend = useRef<Hex | null>(null)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  /**
   * Refresh as a USER means it — the same re-quote, with the reuse window dropped first.
   *
   * Distinct from {@link refresh} because their callers want opposite things. The confirm modal
   * polls every 3 seconds against a 4-second reuse window, and that overlap is deliberate: it
   * keeps a modal left open from spending an aggregator's rate limit on prices that have not
   * moved. Someone PRESSING refresh is asking for exactly what that window withholds, so for them
   * the cache is dropped and the next pass goes to the network.
   */
  const hardRefresh = useCallback(() => {
    clearQuoteCache()
    setTick((t) => t + 1)
  }, [])

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
    setSettleNote(null)
    setOutcome(null)
    currentSend.current = null
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
      // The tolerance the SIGNATURE was taken at, not the one on screen. `seedBorrow` divides by
      // `1 − slippage`, so re-seeding at a freshly widened tolerance moves the seed by roughly
      // the change itself — 0.1% to 2% moves it ~1.9%, past the band — and drops the pin on the
      // strength of an edit the user made precisely because they wanted to keep the position.
      // The band is here to catch the ORACLE drifting away from a signed size, and the oracle is
      // not what moved. Older entries recorded no tolerance and fall back to the current one.
      slipNum: BPS - (held.slippageBps ?? input.slippageBps),
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
    // Superseded quotes are stopped, not merely ignored. `cancelled` already keeps a stale run
    // from writing state, but the requests behind it carried on to the end — spending the
    // aggregator's rate limit on prices for a form the user has already typed past. The close
    // flow has always aborted for this reason; this is the same thing on the open side.
    const controller = new AbortController()

    const timer = setTimeout(async () => {
      await runPreview({
        input, pinned, forInput, client, chainId, owner,
        cancelled: () => cancelled,
        signal: controller.signal,
        setIsQuoting, setPreviewError, setPreview, setPreviewFor, setRejected, setRoutes,
      })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      controller.abort()
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
   */  // The context is built inside each callback rather than shared: a shared builder would have to
  // join both dependency sets, and each would then re-create on a change only the other cares about.
  const prepare = useCallback(
    () => prepareOpen({
        input, effectivePreview, client, owner, chainId, deps, refresh, held, prepared, frozen,
        setStep, setExecError, setExecRemedy, setSettleNote, setStorageTick,
      }),
    [input, effectivePreview, client, owner, chainId, deps, refresh, held],
  )

  /**
   * The send, against whatever route is on screen at the moment it is pressed.
   *
   * The route is deliberately the CURRENT one rather than the one `prepare` saw: the modal
   * re-prices while it is open precisely so the calldata is seconds old, and holding the older
   * route would give that back. The borrow is the part that may not move, so it is checked.
   */
  const submit = useCallback(
    () => submitOpen({
        input, effectivePreview, client, owner, chainId, deps, refresh, forget, prepared, frozen,
        currentSend, setStep, setTxHash, setOutcome, setExecError, setExecRemedy, setSettleNote,
      }),
    [input, effectivePreview, client, owner, chainId, deps, refresh, forget],
  )

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
    /** Why each candidate route was unusable — feeds the NO_ROUTE message. */
    rejected,
    /**
     * The aggregators that answered, best-first. Masked with the preview: a list belonging to
     * inputs the user has already edited past would invite them to pin a price that is gone.
     */
    routes: stale ? [] : routes,
    isQuoting: effectiveIsQuoting,
    refresh,
    /** Refresh on the user's behalf: drops the reuse window, then re-quotes. */
    hardRefresh,
    step, txHash, execError, execRemedy,
    /** A submitted open whose receipt never arrived, or could not be read. Not a failure. */
    settleNote,
    /** Approve and delegate. Prompts the wallet; opens nothing. */
    prepare,
    /** Send what `prepare` authorised, against the route currently on screen. */
    submit,
    /** Forgets the last attempt's step, hash and error — call when a fresh confirmation opens. */
    reset,
    /** What the open settled at, once its receipt is in. Null until then, and after a reset. */
    outcome,
    /** Non-null when the next open would spend a signature already taken. */
    reusableSignature,
    /** The borrow the quote is currently pinned to, or null when it is solved freely. */
    pinnedBorrow,
    /** Drop the held signature, unpinning the borrow so the next quote sizes itself again. */
    forgetSignature: forget,
  }
}
