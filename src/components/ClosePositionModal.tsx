import { useState, useEffect, useMemo, type CSSProperties } from 'react'
import { useTabVisible } from '../hooks/useTabVisible'
import { FlipRateButton } from './FlipRateButton'
import { useWriteContract, useConnection, useChainId, useConfig } from 'wagmi'
import { parseUnits, maxUint256 } from 'viem'
import { getChainConfig, getStrategiesAddress } from '../config/chains'
import { aavePoolAbi } from '../config/aavev3Abi'
import type { BorrowedAsset, SuppliedAsset } from '../hooks/useAavePositions'
import { extractRevertMessage } from '../utils/errors'
import { healthFactor, evaluateHf } from '../utils/health'

import { clearQuoteCache } from '../adapters/http'
import type { CloseErrorKind } from '../lib/deleverage'
import { PRICE_IMPACT_HIGH_PERCENT, suggestWiderSlippage } from '../lib/closePlan'
import { simulateAndWrite } from '../utils/contract'
import { Modal } from './Modal'
import { TxReport } from './TxReport'
import { RoutePicker, type RouteOffer } from './RoutePicker'
import { SlippageField } from './leverage/SlippageField'
import { T, MODAL_WIDTH } from '../styles/theme'
import { buildTokenMap, positionTokens } from '../lib/tokenMeta'
import { hideTokens } from '../lib/txOutcome'
import { useRecordOutcome } from '../hooks/useRecordOutcome'
import { useDeleverageClose, type ClosePreview } from '../hooks/useDeleverageClose'

const SLIPPAGE_PRESETS = [0.1, 0.5, 1]

/**
 * Default max slippage.
 *
 * 0.5% is KyberSwap's own `DEFAULT_SLIPPAGE` (50 bps), and their `checkRangeSlippage` flags
 * anything below that as too LOW for a volatile pair — "may cause failed transactions in
 * volatile markets". We previously defaulted to 0.1%, which is their floor for a *stable* pair
 * and which measurably cannot be filled at size: a real 200 WETH route books 0.05-0.07% of
 * cost before execution even starts, leaving almost nothing inside a 0.1% band.
 */
const DEFAULT_SLIPPAGE_PERCENT = 0.1

/** Never nudge a user past this in a one-click retry, however wide the failure suggests. */
const SLIPPAGE_SUGGESTION_CAP = 1

// How often the open modal re-quotes. Aggregator quotes go stale within seconds, and the
// router enforces the output floor frozen into its calldata, so a preview that is not
// refreshed stops describing the transaction that would actually be submitted.
/**
 * Gap between one quote settling and the next being requested.
 *
 * This is a REST period, not a period. Actual cadence is roughly
 * `debounce + quote latency + QUOTE_REFRESH_MS`, which self-adjusts: a cheap pair refreshes
 * every ~3.5s, a 200 WETH split route every ~10s. Refreshing faster than a quote takes cannot
 * produce fresher numbers, it only produces more overlapping requests.
 */
const QUOTE_REFRESH_MS = 3000

/**
 * Pill control sitting inside a text input, matching the MAX button in BorrowRepayModal so
 * the two amount fields in this app read as the same control.
 */
const pillButtonStyle = (active: boolean): CSSProperties => ({
  padding: '2px 8px',
  fontSize: T.fontSize.xs,
  fontWeight: 700,
  lineHeight: 1.5,
  color: active ? T.primaryText : T.primary,
  // Transparent rather than a hand-picked tint: the two hexes here were a blue wash and a blue
  // border that exist nowhere in the token set, so they were the only colours on this screen that
  // could not follow a theme change.
  background: active ? T.primary : 'transparent',
  border: `1px solid ${T.border}`,
  borderRadius: T.radius.sm,
  cursor: 'pointer',
})

// Trim a full-precision formatUnits string to something readable in the UI.
const formatAmount = (s: string): string => {
  const n = Number(s)
  if (n === 0) return '0'
  if (n > 0 && n < 0.0001) return n.toExponential(2)
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

interface ClosePositionModalProps {
  borrowedAsset: BorrowedAsset
  suppliedAssets: SuppliedAsset[]
  /**
   * Whether the tab holding this modal is the one on screen. False stops quoting.
   *
   * AavePosition is hidden with `display: none` rather than unmounted when the user leaves it, so
   * without this an open modal keeps re-pricing behind another tab — and a close quote is the
   * slowest call in the app, repeating every three seconds.
   */
  active?: boolean
  /**
   * The whole account, not just this pair — Aave's health factor is account-wide, and a partial
   * close is the only path here that can leave one behind. Default 0 so a caller that has not
   * threaded them through gets no projection rather than a wrong one; `evaluateHf` reads the
   * resulting non-finite figure as "unknown" and falls back to the on-chain revert.
   */
  collateralUsd?: number
  debtUsd?: number
  /** Account-wide liquidation threshold as a fraction, e.g. 0.83. */
  liquidationThreshold?: number
  onClose: () => void
}

export function ClosePositionModal({
  borrowedAsset,
  suppliedAssets,
  active,
  collateralUsd = 0,
  debtUsd = 0,
  liquidationThreshold = 0,
  onClose,
}: ClosePositionModalProps) {
  const { address } = useConnection()
  const chainId = useChainId()
  const [selectedCollateral, setSelectedCollateral] = useState<SuppliedAsset | null>(suppliedAssets[0] ?? null)
  const [amountStr, setAmountStr] = useState<string>('')
  const [isMax, setIsMax] = useState<boolean>(false)
  const [slippage, setSlippage] = useState<number>(DEFAULT_SLIPPAGE_PERCENT)

  const [step, setStep] = useState<number>(0)
  const [logs, setLogs] = useState<string[]>([])
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  /** A close/repay has landed and the form has been reset for it. Cleared on the next attempt. */
  const [isComplete, setIsComplete] = useState<boolean>(false)

  const [preview, setPreview] = useState<ClosePreview | null>(null)
  /**
   * The aggregator the user pinned in the route list, or null while the ranking decides. Held
   * across re-quotes on purpose — a pin overrides the ranking until it is taken off.
   */
  const [pinnedRoute, setPinnedRoute] = useState<string | null>(null)
  /** Why the preview could not be produced — paused contract, empty router allowlist, etc. */
  const [previewError, setPreviewError] = useState<{ kind: CloseErrorKind; message: string } | null>(null)
  /**
   * How much collateral to swap. Empty means "only what the debt needs" (the automatic
   * sizing). Setting it higher converts the surplus into the debt asset and sends it to the
   * wallet, which is the point when the collateral is expected to fall.
   */
  const [collateralInStr, setCollateralInStr] = useState<string>('')
  const [isCollateralMax, setIsCollateralMax] = useState<boolean>(false)
  /**
   * How much debt to repay. Empty means the whole thing. Anything smaller is a partial close:
   * the position stays open with less debt and less collateral behind it.
   */
  const [debtInStr, setDebtInStr] = useState<string>('')
  const [isDebtMax, setIsDebtMax] = useState<boolean>(false)
  const [isQuoting, setIsQuoting] = useState<boolean>(false)
  const [refreshTick, setRefreshTick] = useState<number>(0)
  /**
   * Unix seconds until the held permit expires, or null when none is held. Drives the
   * two-step flow: the first press captures the approval, the second submits with it.
   */
  const [signedUntil, setSignedUntil] = useState<number | null>(null)
  /** Last close failed because the tolerance was too tight — offer a wider one. */
  const [slippageTooTight, setSlippageTooTight] = useState<boolean>(false)
  /** Advanced by the countdown below; `secondsLeft` is derived from it during render. */
  // Quoting stops when nobody is looking: the in-app tab from `active`, the browser window from
  // `useTabVisible`. Either one pauses it; coming back re-quotes, because a price taken before
  // the user looked away is worse than none — it looks current.
  // Called unconditionally, then combined. Folding it into the `||` short-circuits the hook away
  // whenever `active` is false, which changes the hook order between renders.
  const tabVisible = useTabVisible()
  const paused = active === false || !tabVisible

  /**
   * The priced field, stored WITH the pair it was priced for.
   *
   * Kept out of `preview` deliberately. A run that finds nothing buildable returns no preview at
   * all, and the roster used to go down with it — leaving the user reading "pick another route"
   * with nothing to pick from. The list was priced for this same pair seconds ago and a failed
   * re-quote does not unprice it, so it stands until the pair itself moves.
   *
   * The pin and the slippage are deliberately NOT in the key: neither changes who priced the
   * pair, and the aggregators' `amountOut` is pre-slippage.
   */
  const [quotedRoutes, setQuotedRoutes] = useState<{ pair: string; list: RouteOffer[] }>(
    { pair: '', list: [] },
  )

  /** Which end of the pair is quoted as 1. Shared by both rate rows — see the note there. */
  const [rateFlipped, setRateFlipped] = useState(false)
  const [nowSeconds, setNowSeconds] = useState<number>(() => Math.floor(Date.now() / 1000))

  const { mutateAsync: writeContractAsync } = useWriteContract()
  const config = useConfig()
  const {
    preview: quotePreview,
    close: closePosition,
    step: closeStep,
    outcome: closeOutcome,
    execError: closeExecError,
    settleNote: closeSettleNote,
    clearOutcome,
    clearSignatures,
    warmup,
  } = useDeleverageClose()
  const chainConfig = getChainConfig(chainId)
  const poolAddress = chainConfig?.aave?.poolAddress as `0x${string}`

  // MAX resolves on-chain to the live aToken balance rather than to this formatted number,
  // so a full swap is exact and cannot be left a wei short by display rounding.
  const collateralIn: bigint | 'all' | undefined = isCollateralMax
    ? 'all'
    : collateralInStr && selectedCollateral
      ? (() => {
          try {
            const parsed = parseUnits(collateralInStr, selectedCollateral.decimals)
            return parsed > 0n ? parsed : undefined
          } catch {
            return undefined
          }
        })()
      : undefined

  // Same reasoning as MAX above: `'all'` resolves to the live variable-debt balance on chain,
  // so a full repay is never left a wei short by a rounded display number.
  const debtIn: bigint | 'all' | undefined = isDebtMax
    ? 'all'
    : debtInStr
      ? (() => {
          try {
            const parsed = parseUnits(debtInStr, borrowedAsset.decimals)
            return parsed > 0n ? parsed : undefined
          } catch {
            return undefined
          }
        })()
      : undefined

  const secondsLeft = signedUntil === null ? 0 : Math.max(0, signedUntil - nowSeconds)

  /** How to format the tokens a receipt can name: the two underlyings this screen is about. */
  const outcomeTokens = useMemo(
    () => buildTokenMap([borrowedAsset, selectedCollateral]),
    [borrowedAsset, selectedCollateral],
  )

  /** The aToken and variable-debt rows, which belong to the position rather than to the wallet. */
  const hiddenTokens = useMemo(
    () => positionTokens([borrowedAsset, selectedCollateral]),
    [borrowedAsset, selectedCollateral],
  )

  // Filtered once, so the panel and the history row report the same thing.
  const settled = useMemo(() => hideTokens(closeOutcome, hiddenTokens), [closeOutcome, hiddenTokens])

  // Same history the leverage panel writes to: one wallet, one list, whichever flow produced it.
  useRecordOutcome({
    outcome: settled, tokens: outcomeTokens, hash: txHash, chainId, wallet: address, kind: 'close',
  })

  /**
   * What the ROUTE ROSTER depends on: the pair and the size, and nothing else.
   *
   * The pin and the slippage are left out deliberately. Neither changes who priced the pair, and
   * an aggregator's `amountOut` is pre-slippage — so keying on them would blank the picker the
   * moment someone clicked a row in it.
   */
  const routesPairKey = [
    selectedCollateral?.underlyingAsset, borrowedAsset.underlyingAsset, collateralIn, debtIn,
  ].join('|')

  const isSameAsset =
    selectedCollateral?.underlyingAsset?.toLowerCase() === borrowedAsset.underlyingAsset.toLowerCase()
  const closeAvailable = getStrategiesAddress(chainId) !== null

  // Fetch the sized-swap preview (real router numbers) whenever the inputs change.
  // The reset is done inside the async body so we never call setState synchronously
  // in the effect (avoids cascading renders).
  useEffect(() => {
    const shouldQuote = !isSameAsset && closeAvailable && !!selectedCollateral
    // Returned BEFORE anything is scheduled or cleared. `shouldQuote` false means there is
    // nothing to price and the stale preview must go; paused means the same question is still
    // live and its last answer is worth keeping on screen until we can ask again.
    if (paused) return

    let isMounted = true
    // Superseded quotes are aborted, not merely ignored. A route at size takes several seconds
    // to compute, so an abandoned one left running keeps consuming the slowest endpoint in the
    // app on behalf of a result nobody will read.
    const controller = new AbortController()
    const run = async () => {
      if (!shouldQuote) {
        // Also clears the in-flight flag: a quote aborted by this very effect re-running
        // cannot clear it (its `isMounted` is already false), so without this the flag stays
        // true and the self-scheduling refresh — which only arms while idle — never rearms.
        if (isMounted) { setPreview(null); setPreviewError(null); setIsQuoting(false) }
        return
      }
      setIsQuoting(true)
      try {
        const p = await quotePreview({
          collateral: selectedCollateral,
          debtAsset: borrowedAsset,
          slippagePercent: slippage,
          collateralIn,
          debtIn,
          preferredAggregator: pinnedRoute ?? undefined,
          signal: controller.signal,
        })
        if (isMounted) {
          setPreview(p.preview)
          setPreviewError(p.error)
          // Only when this run actually priced something. A failed one leaves the last roster
          // standing rather than replacing it with nothing.
          if (p.preview) setQuotedRoutes({ pair: routesPairKey, list: p.preview.routes })
        }
      } finally {
        if (isMounted) setIsQuoting(false)
      }
    }

    // Debounce slightly if the user rapidly changes collateral or slippage.
    const timeout = setTimeout(run, 300)
    return () => {
      isMounted = false
      clearTimeout(timeout)
      controller.abort()
    }
  }, [selectedCollateral, borrowedAsset, slippage, collateralIn, debtIn, pinnedRoute, isSameAsset, closeAvailable, quotePreview, refreshTick, paused, routesPairKey])

  // Ticks only while an approval is held. Everything it writes happens inside the interval
  // callback, so the countdown never sets state as a render side effect.
  useEffect(() => {
    if (signedUntil === null) return
    const id = setInterval(() => {
      const now = Math.floor(Date.now() / 1000)
      // Once it lapses the held signature is worthless, so stop offering to submit with it.
      if (now >= signedUntil) {
        setSignedUntil(null)
        clearSignatures()
      } else {
        setNowSeconds(now)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [signedUntil, clearSignatures])

  // A signature must never outlive the modal that took it.
  useEffect(() => () => clearSignatures(), [clearSignatures])

  // Resolve Aave's immutable wiring as soon as the modal opens, so the first preview is one
  // batch rather than a three-deep waterfall. Runs ahead of the preview's 300ms debounce.
  useEffect(() => {
    if (isSameAsset || !closeAvailable || !selectedCollateral) return
    void warmup({ collateral: selectedCollateral, debtAsset: borrowedAsset })
  }, [selectedCollateral, borrowedAsset, isSameAsset, closeAvailable, warmup])

  // Only estimate once there's something to act on: an entered amount for the
  // same-asset repay, or an available one-click close for the cross-asset path.
  // The two paths cost very different amounts and are sent at different priorities, so the
  // preview has to follow whichever one is actually in play.
  // The swap dominates a cross-asset close and its cost is route-dependent, so take the
  // aggregator's estimate when there is one rather than assuming a fixed total.
  const log = (msg: string) => setLogs((prev) => [...prev, msg])

  // Clear the inputs and the quote once an action lands. Without this every gate on the
  // Execute button is still satisfied afterwards — `amountStr` still holds the repaid
  // amount, `preview` still holds a quote for debt that no longer exists, and the effect
  // never re-runs because none of its deps changed — so the button re-enables and a second
  // click costs two more permit signatures before reverting on-chain. The tx hash and the
  // logs are deliberately kept: they are the record of what just happened.
  const resetForm = () => {
    setAmountStr('')
    setIsMax(false)
    setCollateralInStr('')
    setIsCollateralMax(false)
    setDebtInStr('')
    setIsDebtMax(false)
    setSignedUntil(null)
    setPreview(null)
    setPreviewError(null)
    setIsComplete(true)
  }

  const executeClose = async () => {
    if (!address || !selectedCollateral || !poolAddress) return

    // A hash or log lines carried over from a previous attempt would read as belonging to
    // this one. The cross-asset path's logs live in the hook, which clears them itself.
    setIsComplete(false)
    setTxHash(undefined)
    setLogs([])
    setSlippageTooTight(false)

    if (isSameAsset) {
      if (!amountStr) return
      try {
        setStep(1)
        const amountParsed = parseUnits(amountStr, borrowedAsset.decimals)
        const finalAmount = isMax ? maxUint256 : amountParsed
        log(`Simulating repayWithATokens for ${isMax ? 'MAX' : amountStr} ${borrowedAsset.symbol}…`)
        const hash = await simulateAndWrite(config, writeContractAsync, {
          chainId,
          address: poolAddress,
          abi: aavePoolAbi,
          functionName: 'repayWithATokens',
          args: [borrowedAsset.underlyingAsset, finalAmount, 2n],
        })
        setTxHash(hash)
        log(`Transaction submitted! Hash: ${hash}`)
        setStep(2)
        resetForm()
      } catch (e) {
        log(`Error: ${extractRevertMessage(e)}`)
        setStep(0)
      }
      return
    }

    // Cross-asset: one-transaction close via the deleverager contract.
    if (!closeAvailable) return
    const result = await closePosition({
      collateral: selectedCollateral,
      debtAsset: borrowedAsset,
      slippagePercent: slippage,
      collateralIn,
      debtIn,
      // Same pin the preview was priced under, or the user signs for a route they were never
      // shown — `close()` re-plans from scratch and would otherwise take the ranking's winner.
      preferredAggregator: pinnedRoute ?? undefined,
    })
    if (result.hash) setTxHash(result.hash as `0x${string}`)
    if (result.status === 'signed') {
      // Nothing submitted yet — the approval is banked and the quote stays on screen for
      // one more look. The next press spends it without another wallet prompt.
      setSignedUntil(result.signatureExpiresAt ?? null)
      setStep(0)
      return
    }
    if (result.status === 'success') {
      setSignedUntil(null)
      setStep(2)
      resetForm()
    } else {
      // Did not land — either it failed outright, or no receipt arrived and it is unresolved.
      // The hook has already dropped the stale quote; pull a fresh one now rather than leaving
      // the user looking at numbers that have just been disproved. Its log line says which case
      // this was, and whether there is a hash worth checking on an explorer.
      //
      // The held signature survives, so the next press needs no wallet prompt — including after
      // a receipt timeout, which PERMIT_TTL_S is explicitly sized to outlast. What decides it is
      // the aToken nonce, and a transaction that never landed did not spend it.
      //
      // Should the permit expire anyway, re-signing is safe for the same reason: the nonce has
      // not advanced, so whichever transaction lands first consumes it and the other reverts
      // inside `permit` rather than closing the position twice.
      setStep(0)
      setSlippageTooTight(result.slippageTooTight === true)
      setRefreshTick((t) => t + 1)
    }
  }

  // Cross-asset progress comes from the hook; same-asset uses local logs.
  /**
   * The same-asset path runs from this component rather than the hook, so its failure is decoded
   * here. Its progress is not reported at all: a plain pool call has one wait and the button
   * already says "Processing…".
   */
  const sameAssetError = (() => {
    const last = logs[logs.length - 1] ?? ''
    return last.startsWith('Error:') ? last.slice('Error:'.length).trim() : null
  })()
  /** Any of the three waits: either wallet prompt, or the transaction itself. */
  const isProcessing = isSameAsset
    ? step === 1
    : closeStep === 'permit' || closeStep === 'revoke' || closeStep === 'sending'

  // Re-quote on a cadence, because a close plan cannot be carried forward — the router freezes
  // its output floor into the calldata at build time, so a preview left sitting stops
  // describing what would actually execute.
  //
  // Self-scheduling, NOT a fixed interval. A quote for a large position takes 4-8s (a 200 WETH
  // route is 27kB of split-route data); a 3s interval fires while the previous one is still in
  // flight. Those overlapping runs pile up on the slowest endpoint in the app, and — because a
  // superseded run is barred from clearing `isQuoting` by its own `isMounted` guard — none of
  // them ever clears it. `canExecute` reads that flag, so on a large position the button was
  // unclickable except by luck. Waiting for the current quote to settle before timing the next
  // keeps exactly one in flight and lets the flag fall to false between refreshes.
  //
  // Paused while a close is running: a re-quote landing mid-flow would move the figures under
  // the user and spend rate-limit budget the execution path needs.
  //
  // Held while the tab is hidden. Browsers throttle a background timer rather than stopping it,
  // so left alone this keeps asking the slowest endpoint in the app for prices nobody can see,
  // roughly once a minute, for as long as the modal stays open. The re-quote is re-armed the
  // moment the tab is looked at again — which is also the first moment a stale price could be
  // read — so nothing is lost by holding it.
  useEffect(() => {
    if (isSameAsset || !closeAvailable || !selectedCollateral) return
    if (isProcessing || isQuoting) return

    const requote = () => {
      clearQuoteCache()
      setRefreshTick((t) => t + 1)
    }
    const visible = () => !paused && document.visibilityState === 'visible'
    const id = visible() ? setTimeout(requote, QUOTE_REFRESH_MS) : undefined
    const onVisibilityChange = () => {
      if (visible()) requote()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearTimeout(id)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [isSameAsset, closeAvailable, selectedCollateral, isProcessing, isQuoting, refreshTick, paused])
  /**
   * Where a partial close leaves the account's health factor.
   *
   * A full close ends with no debt, so there is nothing to be liquidated against and the
   * projection is trivially infinite. A partial is the case that matters: it sells collateral
   * and repays debt in whatever proportion the user picked, and those two do not have to move
   * together. Aave checks the result inside the aToken's `finalizeTransfer`, which means an
   * unguarded plan reverts in the wallet AFTER two signatures — so it has to be caught here.
   *
   * Only the chosen collateral leaves the position, so it is that asset's threshold that comes
   * out of the weighted numerator, not the account-wide average. Same shape as WithdrawModal.
   */
  const projectedHf = useMemo(() => {
    if (isSameAsset || !preview || !selectedCollateral) return '∞'
    const soldUsd = Number(preview.collateralSwapped) * Number(selectedCollateral.priceInUsd ?? 0)
    const repaidUsd = Number(preview.debtRepaid) * Number(borrowedAsset.priceInUsd ?? 0)
    const assetLt = selectedCollateral.liquidationThreshold || 0
    return healthFactor(
      collateralUsd * liquidationThreshold - soldUsd * assetLt,
      debtUsd - repaidUsd,
    )
  }, [
    isSameAsset, preview, selectedCollateral, borrowedAsset,
    collateralUsd, debtUsd, liquidationThreshold,
  ])
  const hfGuard = evaluateHf(projectedHf)

  const canExecute = isSameAsset
    ? !!amountStr && parseFloat(amountStr) > 0
    // `guaranteed` gates execution too: close() refuses a route whose guaranteed
    // output falls below the debt, so the button must not invite the click.
    // NOT gated on `isQuoting`. The modal re-prices every three seconds, so gating on it killed
    // the button for the duration of each one and a press landing in that window did nothing.
    // What a press acts on is the preview currently on screen, and `preview` being non-null is
    // exactly the condition for one existing. The first quote is covered anyway — there is no
    // preview until it lands.
    : closeAvailable && preview?.covered === true && preview?.guaranteed === true
      && hfGuard.level !== 'block'

  return (
    <Modal
      title="Close Borrow Position"
      onClose={onClose}
      maxWidth={MODAL_WIDTH.confirm}
      // A close in flight owns the screen until its receipt lands. Dismissing it with a stray
      // click outside is how a user loses the only report that their debt was repaid.
      dismissable={!isProcessing}
      // Passed to the shell rather than rendered as a child. As a child it landed INSIDE
      // `.modal-body`, so the buttons carried the body's padding on top of the footer's own and
      // sat inset from every line above them.
      footer={
        <>
            <button
              onClick={() => {
                clearSignatures()
                onClose()
              }}
              className="btn-secondary"
              style={{ flex: 1, padding: '10px' }}
            >
              {isComplete ? 'Done' : 'Cancel'}
            </button>
            {/* Gone once it has landed, as the open's is. It used to stay live and offer to close
                again: a second attempt spends the same permit nonce and reverts, but not before
                asking the user for another signature to find that out. */}
            {!isComplete && (
              <button
                onClick={executeClose}
                disabled={isProcessing || !canExecute}
                className="btn-primary"
                style={{ flex: 1, padding: '10px' }}
              >
                {isProcessing
                  ? 'Processing…'
                  // Only while nothing has been priced yet. A re-quote over an existing preview
                  // shows itself in the ↻ control above, not by taking the action away.
                  : !preview && isQuoting
                    ? 'Pricing…'
                    : isSameAsset || signedUntil !== null
                      ? // The word the open uses for the press that sends.
                        'Confirm'
                      : // Two, not one: a withdrawal permit and the revoke that follows it at the
                        // next nonce. "Sign Approval" understated what the wallet was about to ask.
                        'Sign 2 approvals'}
              </button>
            )}
        </>
      }
    >
        <div>
          <div className="info-row" style={{ marginBottom: borrowedAsset.priceInUsd != null ? T.space[2] : T.space[4] }}>
            <span className="info-row-label">Debt to Close</span>
            {/* No size override. `.info-row` already sets the scale every other row on both
                screens uses, and lifting one value to `lg` made this line shout over the numbers
                a user is actually comparing against it. The colour is enough emphasis. */}
            <span className="info-row-value" style={{ color: T.danger }}>
              {borrowedAsset.amount.toFixed(4)} {borrowedAsset.symbol}
            </span>
          </div>
          {borrowedAsset.priceInUsd != null && (
            <div className="info-row" style={{ marginBottom: T.space[4] }}>
              <span className="info-row-label">{borrowedAsset.symbol} Price</span>
              <span className="info-row-value">
                ${Number(borrowedAsset.priceInUsd).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                <span style={{ color: T.textMuted, fontWeight: 400 }}>
                  {' · ≈ $'}
                  {(borrowedAsset.amount * Number(borrowedAsset.priceInUsd)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </span>
            </div>
          )}

          <div style={{ marginBottom: T.space[5] }}>
            <label style={{ display: 'block', fontSize: T.fontSize.sm, color: T.textMuted, marginBottom: T.space[2], fontWeight: 500 }}>
              Select Collateral to Use
            </label>
            <select
              className="input"
              value={selectedCollateral?.underlyingAsset || ''}
              onChange={(e) => {
                // The settled panel belongs to the pair it was produced for. Carried across a
                // change of collateral it captions the new pair with the old one's numbers.
                clearOutcome()
                setSelectedCollateral(suppliedAssets.find((a) => a.underlyingAsset === e.target.value) ?? null)
              }}
              style={{ appearance: 'none', backgroundImage: 'url("data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%2364748b%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px top 50%', backgroundSize: '10px auto' }}
            >
              {suppliedAssets.map((asset, i) => (
                <option key={i} value={asset.underlyingAsset}>
                  {asset.symbol} ({asset.amount.toFixed(4)} Available)
                </option>
              ))}
            </select>
          </div>

          {isSameAsset ? (
            <div style={{ marginBottom: T.space[5] }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm, color: T.textMuted, marginBottom: T.space[2], fontWeight: 500 }}>
                <span>Amount to Repay (in {borrowedAsset.symbol})</span>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setAmountStr(borrowedAsset.amount.toFixed(borrowedAsset.decimals))
                    setIsMax(true)
                  }}
                  style={{ fontSize: T.fontSize.xs, padding: '2px 6px', background: T.primary, color: T.primaryText, borderRadius: T.radius.sm }}
                >
                  MAX
                </button>
              </label>
              <input
                type="number"
                className="input"
                value={amountStr}
                onChange={(e) => {
                  setAmountStr(e.target.value)
                  setIsMax(false)
                }}
                placeholder="0.00"
              />
            </div>
          ) : (
            <>
            <div style={{ marginBottom: T.space[5] }}>
              <label style={{ display: 'block', fontSize: T.fontSize.sm, color: T.textMuted, marginBottom: T.space[2], fontWeight: 500 }}>
                Debt to Repay ({borrowedAsset.symbol})
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type="number"
                  step="any"
                  className="input"
                  value={debtInStr}
                  onChange={(e) => {
                    setDebtInStr(e.target.value)
                    setIsDebtMax(false)
                  }}
                  placeholder={`${formatAmount(String(borrowedAsset.amount))} (whole debt)`}
                  style={{ paddingRight: debtInStr ? '124px' : '62px' }}
                />
                <div style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: '6px' }}>
                  {debtInStr && (
                    <button
                      aria-label="Repay RESET"
                      onClick={() => {
                        setDebtInStr('')
                        setIsDebtMax(false)
                      }}
                      style={pillButtonStyle(false)}
                    >
                      RESET
                    </button>
                  )}
                  <button
                    aria-label="Repay MAX"
                    onClick={() => {
                      setIsDebtMax(true)
                      setDebtInStr(String(borrowedAsset.amount))
                    }}
                    style={pillButtonStyle(isDebtMax)}
                  >
                    MAX
                  </button>
                </div>
              </div>
              <p style={{ fontSize: T.fontSize.xs, marginTop: '6px', marginBottom: 0, opacity: 0.7, lineHeight: 1.4 }}>
                Repay less than the whole debt to keep the position open at lower leverage. Only
                the collateral that repay needs is sold. Leave this empty and set the collateral
                amount below instead, and whatever that collateral sells for becomes the
                repayment.
              </p>
            </div>

            <div style={{ marginBottom: T.space[5] }}>
              <label style={{ display: 'block', fontSize: T.fontSize.sm, color: T.textMuted, marginBottom: T.space[2], fontWeight: 500 }}>
                Collateral to Swap ({selectedCollateral?.symbol})
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  type="number"
                  step="any"
                  className="input"
                  value={collateralInStr}
                  onChange={(e) => {
                    setCollateralInStr(e.target.value)
                    setIsCollateralMax(false)
                  }}
                  placeholder={
                    preview
                      ? `${formatAmount(preview.collateralSwapped)} (only what the repay needs)`
                      : 'Auto'
                  }
                  // Room for the pills sitting inside the field; Reset only takes space when shown.
                  style={{ paddingRight: collateralInStr ? '124px' : '62px' }}
                />
                <div style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', display: 'flex', gap: '6px' }}>
                  {/* Only meaningful once an override exists — otherwise it resets to what is
                      already there, which reads as a broken control. */}
                  {collateralInStr && (
                    <button
                      onClick={() => {
                        setCollateralInStr('')
                        setIsCollateralMax(false)
                      }}
                      style={pillButtonStyle(false)}
                    >
                      RESET
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setIsCollateralMax(true)
                      setCollateralInStr(selectedCollateral ? String(selectedCollateral.amount) : '')
                    }}
                    style={pillButtonStyle(isCollateralMax)}
                  >
                    MAX
                  </button>
                </div>
              </div>
            </div>

            {/* The shared control, not a second copy of it. The hand-styled version here
                disagreed with the open's on padding, colour and weight, and clamped nothing where
                this one enforces a ceiling. */}
            <div style={{ marginBottom: T.space[5] }}>
              <SlippageField
                percent={slippage}
                onChange={setSlippage}
                ariaLabel="Close max slippage percent"
                disabled={isProcessing}
              />
            </div>

            </>
          )}

          {/*
            Once the action has landed the quote has been cleared, and an empty quote panel
            renders as "no swap route available" — which reads as a failure directly under a
            successful transaction. Show what actually happened instead.
          */}
          {isComplete && (
            <div className="alert alert-success" style={{ marginBottom: T.space[5] }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span>✅</span>
                <span style={{ fontSize: T.fontSize.sm }}>
                  {isSameAsset
                    ? `Repayment submitted. Your ${borrowedAsset.symbol} position will update once it confirms.`
                    : debtIn !== undefined && debtIn !== 'all'
                      ? `Repayment submitted. The rest of your ${borrowedAsset.symbol} debt stays open, backed by the ${selectedCollateral?.symbol} you did not swap.`
                      : `Position closed. Your ${borrowedAsset.symbol} debt is repaid and the unswapped ${selectedCollateral?.symbol} stays supplied in Aave.`}
                </span>
              </div>
            </div>
          )}

          {slippageTooTight && !isComplete && (() => {
            const suggestion = suggestWiderSlippage(slippage, SLIPPAGE_PRESETS, SLIPPAGE_SUGGESTION_CAP)
            return (
              <div className="alert alert-warning" style={{ marginBottom: T.space[5] }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                  <span>⚠️</span>
                  <div style={{ fontSize: T.fontSize.sm }}>
                    <strong style={{ display: 'block', marginBottom: '2px' }}>
                      Max slippage is too tight for this route
                    </strong>
                    The swap could not be filled within {slippage}%. Nothing was submitted.
                    {suggestion !== null && (
                      <button
                        onClick={() => {
                          setSlippage(suggestion)
                          setSlippageTooTight(false)
                        }}
                        style={{ ...pillButtonStyle(false), marginLeft: '8px' }}
                      >
                        Use {suggestion}%
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })()}

          {signedUntil !== null && !isComplete && (
            <div className="alert alert-success" style={{ marginBottom: T.space[5] }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span>🔑</span>
                <span style={{ fontSize: T.fontSize.sm }}>
                  Approval signed — valid for{' '}
                  <strong>
                    {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
                  </strong>
                  . The numbers below keep refreshing; press <strong>Execute Close</strong> when you are
                  happy and it submits with no further wallet prompt.
                </span>
              </div>
            </div>
          )}

          {!isSameAsset && hfGuard.message && !isComplete && (
            <div
              className={hfGuard.level === 'block' ? 'alert alert-warning' : 'alert'}
              style={{ marginBottom: T.space[5] }}
            >
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span>{hfGuard.level === 'block' ? '⛔' : '⚠️'}</span>
                <span style={{ fontSize: T.fontSize.sm }}>{hfGuard.message}</span>
              </div>
            </div>
          )}

          {!isSameAsset && closeAvailable && !isComplete && (
            <div style={{ marginBottom: T.space[5] }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                marginTop: T.space[4], marginBottom: T.space[2],
              }}>
                <h4 style={{ margin: 0, fontSize: T.fontSize.sm }}>Estimated Output</h4>
                <button
                  // Refresh exists to get prices newer than the ones on screen, so it has to
                  // drop the quote-reuse window as well as re-run the effect.
                  onClick={() => {
                    clearQuoteCache()
                    setRefreshTick((t) => t + 1)
                  }}
                  disabled={isQuoting}
                  className="btn-ghost"
                  title="Re-fetch the latest quote and prices"
                  style={{
                    fontSize: T.fontSize.xs, padding: '3px 8px',
                    cursor: isQuoting ? 'default' : 'pointer', opacity: isQuoting ? 0.6 : 1,
                  }}
                >
                  ↻ {isQuoting ? 'Pricing…' : 'Refresh'}
                </button>
              </div>
              {/* Above the numbers, because pinning re-prices every one of them. Renders nothing
                  until more than one aggregator has answered. */}
              {quotedRoutes.pair === routesPairKey && (
                <div style={{ marginBottom: T.space[3] }}>
                  <RoutePicker
                    routes={quotedRoutes.list}
                    symbol={borrowedAsset.symbol}
                    pinned={pinnedRoute}
                    onPin={setPinnedRoute}
                    disabled={isQuoting}
                  />
                </div>
              )}
              {preview && preview.covered ? (
                <div style={{
                  padding: T.space[3], background: T.surfaceAlt,
                  border: `1px solid ${T.border}`, borderRadius: T.radius.md,
                }}>
                  <div className="info-row">
                    <span className="info-row-label">Collateral in (to swap)</span>
                    <span className="info-row-value">{formatAmount(preview.collateralSwapped)} {preview.collateralSymbol}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-row-label">Debt to repay</span>
                    <span className="info-row-value">{formatAmount(preview.debtRepaid)} {preview.debtSymbol}</span>
                  </div>
                  {Number(preview.debtRemaining) > 0 && (
                    <div className="info-row">
                      <span className="info-row-label" style={{ fontWeight: 600 }}>Still owed after this</span>
                      <span className="info-row-value" style={{ color: T.danger, fontWeight: 600 }}>
                        {formatAmount(preview.debtRemaining)} {preview.debtSymbol}
                      </span>
                    </div>
                  )}
                  <div className="info-row">
                    <span className="info-row-label">Min debt out (router)</span>
                    <span className="info-row-value" style={{ color: preview.guaranteed ? T.success : T.danger }}>
                      {formatAmount(preview.minDebtOut)} {preview.debtSymbol}
                    </span>
                  </div>
                  {Number(preview.debtReturned) > 0 && (
                    <div className="info-row">
                      <span className="info-row-label" style={{ fontWeight: 600 }}>
                        Sent to your wallet (est.)
                      </span>
                      <span className="info-row-value" style={{ color: T.success, fontWeight: 600 }}>
                        {formatAmount(preview.debtReturned)} {preview.debtSymbol}
                      </span>
                    </div>
                  )}
                  <div className="info-row">
                    <span className="info-row-label" style={{ fontWeight: 600 }}>Stays supplied in Aave (est.)</span>
                    <span className="info-row-value" style={{ color: T.success, fontWeight: 600 }}>
                      {formatAmount(preview.collateralKeptSupplied)} {preview.collateralSymbol}
                      {preview.collateralKeptSuppliedUsd != null ? ` (~$${preview.collateralKeptSuppliedUsd.toFixed(2)})` : ''}
                    </span>
                  </div>
                  {preview.routeCostPercent != null && (
                    <div className="info-row">
                      <span className="info-row-label">Price impact &amp; fees</span>
                      <span
                        className="info-row-value"
                        style={{
                          color:
                            preview.routeCostPercent > PRICE_IMPACT_HIGH_PERCENT
                              ? T.danger
                              : undefined,
                        }}
                      >
                        {preview.routeCostPercent < 0 ? '+' : '−'}
                        {Math.abs(preview.routeCostPercent).toFixed(3)}%
                      </span>
                    </div>
                  )}
                  {/* ONE control for both rows. Un-inverted a worse fill is a SMALLER number and
                      inverted it is a LARGER one, so a guaranteed row that flipped on its own
                      would show the worse of the two rates as the better-looking figure sitting
                      directly under the expected one. */}
                  {preview.rate != null && (
                    <div className="info-row">
                      <span className="info-row-label">Expected rate</span>
                      <span className="info-row-value">
                        {(() => {
                          const r = rateFlipped ? preview.rate.inverse : preview.rate
                          return `1 ${r.unit} = ${formatAmount(r.rate)} ${r.quote}`
                        })()}
                        <FlipRateButton onClick={() => setRateFlipped(!rateFlipped)} />
                      </span>
                    </div>
                  )}
                  {preview.guaranteedRate != null && (
                    <div className="info-row">
                      <span className="info-row-label">
                        Guaranteed rate ({slippage}%)
                      </span>
                      <span className="info-row-value">
                        {(() => {
                          const r = rateFlipped
                            ? preview.guaranteedRate.inverse
                            : preview.guaranteedRate
                          return `1 ${r.unit} = ${formatAmount(r.rate)} ${r.quote}`
                        })()}
                      </span>
                    </div>
                  )}
                  {!preview.guaranteed && (
                    <div style={{ marginTop: '10px', fontSize: T.fontSize.xs, color: T.danger, lineHeight: 1.4 }}>
                      ⚠️ At {slippage}% slippage the router only guarantees {formatAmount(preview.minDebtOut)} {preview.debtSymbol}, short of the {formatAmount(preview.debtRequired)} {preview.debtSymbol} needed to cover your {formatAmount(preview.debtRepaid)} {preview.debtSymbol} debt plus the interest accruing before this lands. Closing is blocked so you don't sign for a swap that would revert on-chain — lower the slippage to guarantee it.
                    </div>
                  )}
                  {/* Only for a hand-chosen amount, which is the case that needs explaining: the
                      surplus coming back to the wallet is not stated anywhere else. The automatic
                      case is described by the numbers above it and needs no prose. */}
                  {collateralIn !== undefined && (
                    <p style={{ fontSize: T.fontSize.xs, marginTop: '10px', marginBottom: 0, opacity: 0.7, lineHeight: 1.4 }}>
                      {debtIn === undefined
                        ? `You chose how much ${preview.collateralSymbol} to swap, and the repay above is what the router guarantees it sells for — anything it fills above that comes back to your wallet as ${preview.debtSymbol}. The ${preview.collateralSymbol} you did not swap stays supplied in Aave.`
                        : `You chose how much ${preview.collateralSymbol} to swap. The repay is taken first and the surplus is sent to your wallet as ${preview.debtSymbol}; any ${preview.collateralSymbol} you did not swap stays supplied in Aave.`}{' '}
                      Estimated from your live balances.
                    </p>
                  )}
                </div>
              ) : preview && !preview.covered ? (
                <div className="alert alert-warning" style={{ margin: 0 }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                    <span>⚠️</span>
                    <span style={{ fontSize: T.fontSize.sm }}>
                      {collateralIn === undefined
                        ? 'Collateral won’t cover the debt — the position is underwater. Try a different collateral.'
                        : 'That much collateral won’t cover the repay amount you asked for. Sell more of it, ask to repay less, or clear the repay amount and let the swap decide it.'}
                    </span>
                  </div>
                </div>
              ) : isQuoting ? (
                <div style={{ padding: '14px', backgroundColor: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radius.md, fontSize: T.fontSize.sm, color: T.textMuted }}>
                  Calculating your output…
                </div>
              ) : previewError ? (
                // A deployment-level problem (paused, empty router allowlist, unsupported
                // network) is not fixable by picking different collateral, so it must not
                // render as "no route for this pair" — that sends users round in circles.
                // The heading says which kind of problem this is; the message says what.
                <div className="alert alert-warning" style={{ margin: 0 }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                    <span>⚠️</span>
                    <div style={{ fontSize: T.fontSize.sm }}>
                      <strong style={{ display: 'block', marginBottom: '2px' }}>
                        {previewError.kind === 'deployment'
                          ? 'One-click close is unavailable right now'
                          : previewError.kind === 'wallet'
                            ? 'Wallet not connected'
                            : previewError.kind === 'aggregator'
                              ? 'Could not reach the price aggregator'
                              : 'This pair cannot be closed'}
                      </strong>
                      {previewError.message}
                      {previewError.kind === 'deployment' && (
                        <span style={{ display: 'block', marginTop: '4px', opacity: 0.8 }}>
                          Choosing different collateral will not help — this affects the whole deployment.
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '14px', backgroundColor: T.surfaceAlt, border: `1px solid ${T.border}`, borderRadius: T.radius.md, fontSize: T.fontSize.sm, color: T.textMuted }}>
                  No swap route available for this pair right now.
                </div>
              )}
            </div>
          )}

          {/* The tail both transaction screens end with, in the order both used. Shared with the
              open so the two cannot drift apart again — see TxReport.

              The close needs two signatures, a withdrawal permit and the revoke that follows it at
              the next nonce, and then the transaction. A single "Processing…" could not tell a
              wallet that had not surfaced its second prompt from a send already in flight. The
              same-asset path runs a plain pool call, so it has nothing to enumerate. */}
          <TxReport
            steps={
              isSameAsset || isComplete
                ? []
                : [
                    {
                      label: 'withdraw',
                      done: signedUntil !== null || closeStep === 'sending',
                      active: closeStep === 'permit',
                    },
                    {
                      label: 'revoke',
                      done: signedUntil !== null || closeStep === 'sending',
                      active: closeStep === 'revoke',
                    },
                    { label: 'swap', done: false, active: closeStep === 'sending' },
                  ]
            }
            // The latest line, not the whole run: the full log rendered as a scrolling monospace
            // list, which reads as debug output in the middle of a transaction screen.
            // A decoded failure and a not-a-failure, exactly as the open reports them. The log
            // array is not shown at all: "Requesting permit signature (1 of 2)…" and
            // "Tx submitted: 0x…" are a record of the flow, not something a user acts on, and the
            // progress line above already says which wait they are in.
            error={isSameAsset ? sameAssetError : closeExecError}
            note={isSameAsset ? null : closeSettleNote}
            outcome={settled}
            outcomeTokens={outcomeTokens}
            txHash={txHash}
            chainId={chainId}
          />
        </div>

    </Modal>
  )
}
