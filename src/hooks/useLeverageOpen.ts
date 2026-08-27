import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useChainId,
  useConnection,
  usePublicClient,
  useSignTypedData,
  useWriteContract,
} from 'wagmi'
import { type Hex } from 'viem'
import {
  getDelegationAllowance,
  getPermitContext,
  resolveMode,
  planOpen,
  buildCreditDelegation,
  toStrategiesSig,
  ZERO_STRATEGIES_SIG,
  aaveV3StrategiesAbi,
  BPS,
} from '../lib/strategies-sdk'
import { deriveOpen, resolveOpenMode, type LeverageError } from '../lib/leverage'
import { seedBorrow } from '../lib/solveBorrow'
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
import type { TxOutcome } from '../lib/txOutcome'
import { RECEIPT_TIMEOUT_MS, settleTransaction } from '../lib/settle'
import { clearQuoteCache } from '../adapters/http'
import { getChainConfig } from '../config/chains'
import { adjustedFees, pinnedGasLimit } from '../utils/gas'
import { getPoolDataProvider, getReserveTokens } from '../lib/aaveStatics'
import { decodeStrategiesError } from '../lib/strategiesErrors'
import type { StrategiesRemedy } from '../lib/strategiesErrors'
import { extractRevertMessage } from '../utils/errors'
import {
  DEBOUNCE_MS,
  ERC20_ABI,
  SIGNATURE_TTL_S,
  inputKey,
  type LeverageOpenInput,
  type OpenDeps,
  type OpenPreview,
  type OpenStep,
  type PreparedOpen,
  type ReserveInfo,
} from './open/types'
import { runPreview } from './open/preview'

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

    const timer = setTimeout(async () => {
      await runPreview({
        input, pinned, forInput, client, chainId, owner,
        cancelled: () => cancelled,
        setIsQuoting, setPreviewError, setPreview, setPreviewFor,
      })
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
    setSettleNote(null)
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
        const approveGas = await pinnedGasLimit(
          () =>
            client.estimateContractGas({
              address: effectivePreview.marginAsset, abi: ERC20_ABI, functionName: 'approve',
              args: [input.contract, input.marginAmount], account: owner,
            }),
          { chainId, label: 'approve' },
        )
        await deps().writeContract({
          address: effectivePreview.marginAsset, abi: ERC20_ABI, functionName: 'approve',
          args: [input.contract, input.marginAmount], gas: approveGas,
          ...(await adjustedFees(client)),
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
            // The tolerance this was signed under, so a later edit to it is judged against the
            // seed it was adopted at rather than against one the edit itself moved.
            slippageBps: input.slippageBps,
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
    setSettleNote(null)
    /** The hash, once there is one — read outside the block so the receipt can be waited on. */
    let sent: Hex | undefined
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
      // Estimated here, never left to the wallet: an unpinned limit on a flash-loan open is an
      // out-of-gas revert with the margin already approved and the delegation already spent.
      // A failed estimate throws before the write, and `prepared.current` is only cleared after
      // a successful send — so the signature survives and a retry costs no new prompt.
      const openGas = await pinnedGasLimit(
        () =>
          client.estimateContractGas({
            address: input.contract, abi: aaveV3StrategiesAbi,
            functionName: plan.functionName, args: plan.args, account: owner,
          } as Parameters<typeof client.estimateContractGas>[0]),
        { chainId, label: 'open' },
      )
      const hash = await deps().writeContract({
        address: input.contract, abi: aaveV3StrategiesAbi,
        functionName: plan.functionName, args: plan.args, gas: openGas,
        ...(await adjustedFees(client)),
      })
      sent = hash
      currentSend.current = hash
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

    // Read AFTER the block above, not inside it: `step` is already 'done' and the preview already
    // unfrozen, so a receipt that takes a block — or never comes — holds nothing else up. A
    // failure here is not a failed open, so it never reaches `execError`.
    if (!sent || !client || !owner) return
    const settlement = await settleTransaction({
      client,
      hash: sent,
      wallet: owner,
      // The swap funds the collateral leg: borrowed debt in, collateral out.
      pair: { srcToken: effectivePreview.debtAsset, dstToken: effectivePreview.collateral },
      expectedOut: effectivePreview.expectedOut,
      minOut: effectivePreview.minOut,
      // Abandoned while this was in flight. Whatever it says belongs to a screen that is gone.
      isCurrent: () => currentSend.current === sent,
    })

    switch (settlement.kind) {
      case 'settled':
        setOutcome(settlement.outcome)
        return
      // `step` went to 'done' on submission, which is all that was known then. The receipt knows
      // better: an included-and-reverted open holds no position, and leaving "done" on screen
      // tells the user the opposite of what the chain says.
      case 'reverted':
        setExecError('The open reverted on chain, so no position was opened. Nothing was spent but gas.')
        setStep('error')
        return
      // The two below are NOT errors, and must not be shown as ones: the transaction is submitted
      // either way, and calling it a failure would send the user to re-open a position they may
      // hold. But saying nothing was worse — this flow used to catch both in one empty block, so a
      // user whose receipt never arrived got no explanation of any kind. They are reported as
      // notes, and `step` stays where it was.
      case 'timeout':
        setSettleNote(
          `No receipt after ${RECEIPT_TIMEOUT_MS / 60000} minutes. It may still land — check the explorer before retrying.`,
        )
        return
      case 'unreadable':
        setSettleNote(
          `Could not read the receipt: ${settlement.detail}. The open was submitted — check the explorer before retrying.`,
        )
        return
      case 'abandoned':
        return
    }
  }, [input, effectivePreview, client, owner, chainId, deps, refresh, forget])

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
