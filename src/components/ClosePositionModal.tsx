import { useState, useEffect, useMemo, type CSSProperties } from 'react'
import { useWriteContract, useConnection, useChainId, useConfig } from 'wagmi'
import { parseUnits, maxUint256, formatGwei } from 'viem'
import { getChainConfig, getStrategiesAddress } from '../config/chains'
import { aavePoolAbi } from '../config/aavev3Abi'
import type { BorrowedAsset, SuppliedAsset } from '../hooks/useAavePositions'
import { extractRevertMessage } from '../utils/errors'
import { useAdjustedGas } from '../hooks/useAdjustedGas'

import { clearQuoteCache } from '../adapters/http'
import type { CloseErrorKind } from '../lib/deleverage'
import { PRICE_IMPACT_HIGH_PERCENT, suggestWiderSlippage } from '../lib/closePlan'
import { simulateAndWrite } from '../utils/contract'
import { ExplorerLink } from './ExplorerLink'
import { Modal } from './Modal'
import { TxOutcomePanel } from './TxOutcome'
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
 * Gas the close costs BESIDES the swap: flash loan, Aave repay, two permits, the aToken pull,
 * the withdraw and the settlement transfers.
 *
 * Measured on a mainnet fork (`forge test --gas-report`): `closePositionWithPermit` peaks at
 * 514k with the swap mocked out, so this is that figure rounded up. The swap itself is added
 * on top from the aggregator's own estimate, which is the only party that knows how many
 * venues the route touches — a large split route can be several million on its own, and a
 * fixed constant was understating it by an order of magnitude.
 */
const CLOSE_OVERHEAD_GAS = 550_000n

/** Fallback swap gas when the aggregator has not quoted one yet. */
const FALLBACK_SWAP_GAS = 350_000n

/**
 * Priority multiplier the close transaction actually pays (see useDeleverageClose). The
 * preview has to use the same one, or it shows a fee that is not the fee being charged.
 */
const CLOSE_PRIORITY_MULTIPLIER = 10n

/** Aave's own repayWithATokens on the same-asset path — an ordinary pool call. */
const SAME_ASSET_REPAY_GAS_LIMIT = 300_000n

/**
 * Pill control sitting inside a text input, matching the MAX button in BorrowRepayModal so
 * the two amount fields in this app read as the same control.
 */
const pillButtonStyle = (active: boolean): CSSProperties => ({
  padding: '2px 8px',
  fontSize: 'var(--text-xs)',
  fontWeight: 700,
  lineHeight: 1.5,
  color: active ? 'var(--color-primary-text)' : 'var(--color-primary)',
  background: active ? 'var(--color-primary)' : '#eff6ff',
  border: '1px solid #bfdbfe',
  borderRadius: 'var(--radius-sm)',
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
  /** Native token price, for costing the gas estimate. Zero hides the USD figure. */
  ethPriceUsd: number
  onClose: () => void
}

export function ClosePositionModal({
  borrowedAsset,
  suppliedAssets,
  ethPriceUsd,
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
  /** Why the preview could not be produced — paused contract, empty router allowlist, etc. */
  const [previewError, setPreviewError] = useState<{ kind: CloseErrorKind; message: string } | null>(null)
  /**
   * How much collateral to swap. Empty means "only what the debt needs" (the automatic
   * sizing). Setting it higher converts the surplus into the debt asset and sends it to the
   * wallet, which is the point when the collateral is expected to fall.
   */
  const [collateralInStr, setCollateralInStr] = useState<string>('')
  const [isCollateralMax, setIsCollateralMax] = useState<boolean>(false)
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
  const [nowSeconds, setNowSeconds] = useState<number>(() => Math.floor(Date.now() / 1000))

  const { mutateAsync: writeContractAsync } = useWriteContract()
  const config = useConfig()
  const {
    preview: quotePreview,
    close: closePosition,
    logs: closeLogs,
    step: closeStep,
    outcome: closeOutcome,
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

  const isSameAsset =
    selectedCollateral?.underlyingAsset?.toLowerCase() === borrowedAsset.underlyingAsset.toLowerCase()
  const closeAvailable = getStrategiesAddress(chainId) !== null

  // Fetch the sized-swap preview (real router numbers) whenever the inputs change.
  // The reset is done inside the async body so we never call setState synchronously
  // in the effect (avoids cascading renders).
  useEffect(() => {
    const shouldQuote = !isSameAsset && closeAvailable && !!selectedCollateral

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
          signal: controller.signal,
        })
        if (isMounted) { setPreview(p.preview); setPreviewError(p.error) }
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
  }, [selectedCollateral, borrowedAsset, slippage, collateralIn, isSameAsset, closeAvailable, quotePreview, refreshTick])

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
  const swapGas = (() => {
    if (!preview?.swapGasEstimate) return FALLBACK_SWAP_GAS
    try {
      const g = BigInt(preview.swapGasEstimate)
      return g > 0n ? g : FALLBACK_SWAP_GAS
    } catch {
      return FALLBACK_SWAP_GAS
    }
  })()

  const { maxFee: uiMaxFee, maxPriority: uiMaxPriority, estimatedFeeUsd } = useAdjustedGas(
    isSameAsset ? SAME_ASSET_REPAY_GAS_LIMIT : CLOSE_OVERHEAD_GAS + swapGas,
    ethPriceUsd,
    isSameAsset ? parseFloat(amountStr) > 0 : closeAvailable,
    isSameAsset ? 1n : CLOSE_PRIORITY_MULTIPLIER,
  )

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
  const shownLogs = isSameAsset ? logs : closeLogs
  const isProcessing = isSameAsset ? step === 1 : closeStep === 'running'

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
  useEffect(() => {
    if (isSameAsset || !closeAvailable || !selectedCollateral) return
    if (isProcessing || isQuoting) return
    const id = setTimeout(() => {
      clearQuoteCache()
      setRefreshTick((t) => t + 1)
    }, QUOTE_REFRESH_MS)
    return () => clearTimeout(id)
  }, [isSameAsset, closeAvailable, selectedCollateral, isProcessing, isQuoting, refreshTick])
  const canExecute = isSameAsset
    ? !!amountStr && parseFloat(amountStr) > 0
    // `guaranteed` gates execution too: close() refuses a route whose guaranteed
    // output falls below the debt, so the button must not invite the click.
    : closeAvailable && !isQuoting && preview?.covered === true && preview?.guaranteed === true

  return (
    <Modal
      title="Close Borrow Position"
      onClose={onClose}
      // A close in flight owns the screen until its receipt lands. Dismissing it with a stray
      // click outside is how a user loses the only report that their debt was repaid.
      dismissable={!isProcessing}
    >
        <div>
          <div className="info-row" style={{ marginBottom: borrowedAsset.priceInUsd != null ? 'var(--space-2)' : 'var(--space-4)' }}>
            <span className="info-row-label">Debt to Close</span>
            <span className="info-row-value" style={{ fontSize: 'var(--text-lg)', color: 'var(--color-danger)' }}>
              {borrowedAsset.amount.toFixed(4)} {borrowedAsset.symbol}
            </span>
          </div>
          {borrowedAsset.priceInUsd != null && (
            <div className="info-row" style={{ marginBottom: 'var(--space-4)' }}>
              <span className="info-row-label">{borrowedAsset.symbol} Price</span>
              <span className="info-row-value">
                ${Number(borrowedAsset.priceInUsd).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>
                  {' · ≈ $'}
                  {(borrowedAsset.amount * Number(borrowedAsset.priceInUsd)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              </span>
            </div>
          )}

          <div style={{ marginBottom: 'var(--space-5)' }}>
            <label style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)', fontWeight: 500 }}>
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
            <div style={{ marginBottom: 'var(--space-5)' }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)', fontWeight: 500 }}>
                <span>Amount to Repay (in {borrowedAsset.symbol})</span>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setAmountStr(borrowedAsset.amount.toFixed(borrowedAsset.decimals))
                    setIsMax(true)
                  }}
                  style={{ fontSize: 'var(--text-xs)', padding: '2px 6px', background: 'var(--color-primary)', color: 'var(--color-primary-text)', borderRadius: 'var(--radius-sm)' }}
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
            <div style={{ marginBottom: 'var(--space-5)' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)', fontWeight: 500 }}>
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
                    preview ? `${formatAmount(preview.collateralSwapped)} (only what the debt needs)` : 'Auto'
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

            <div style={{ marginBottom: 'var(--space-5)' }}>
              <label style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)', fontWeight: 500 }}>
                Max Slippage
              </label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {SLIPPAGE_PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setSlippage(p)}
                    style={{
                      padding: '6px 14px',
                      border: `1px solid var(--color-border)`,
                      borderRadius: 'var(--radius-md)',
                      background: slippage === p ? 'var(--color-primary)' : 'var(--color-surface-alt)',
                      color: slippage === p ? 'var(--color-primary-text)' : 'var(--color-text)',
                      cursor: 'pointer',
                      fontWeight: slippage === p ? 600 : 400,
                      transition: 'var(--transition)'
                    }}
                  >
                    {p}%
                  </button>
                ))}
                <div style={{ position: 'relative', flex: 1, marginLeft: '8px' }}>
                  <input
                    type="number"
                    step="any"
                    className="input"
                    value={slippage}
                    onChange={(e) => setSlippage(Math.max(0, parseFloat(e.target.value) || 0))}
                    style={{ paddingRight: '24px' }}
                  />
                  <span style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', pointerEvents: 'none' }}>
                    %
                  </span>
                </div>
              </div>
            </div>
            </>
          )}

          <div className={isSameAsset || closeAvailable ? "alert alert-success" : "alert alert-warning"} style={{ marginBottom: 'var(--space-5)' }}>
            <h4 style={{ margin: '0 0 8px 0', fontSize: 'var(--text-sm)', color: 'inherit' }}>Execution Path</h4>
            {isSameAsset ? (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span>✅</span>
                <span style={{ fontSize: 'var(--text-sm)' }}>Native Aave <strong>repayWithATokens</strong> (Zero Fees, 1 Transaction)</span>
              </div>
            ) : closeAvailable ? (
              <div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                  {isQuoting ? <span>⏳</span> : <span>✅</span>}
                  <span style={{ fontSize: 'var(--text-sm)' }}>
                    One transaction — Morpho Blue zero-fee flash loan{' '}
                    {preview ? <strong>(via {preview.aggregator})</strong> : isQuoting ? <span style={{ opacity: 0.7 }}>(Finding best route...)</span> : ''}
                  </span>
                </div>
                <p style={{ fontSize: 'var(--text-xs)', marginTop: '8px', marginBottom: 0, opacity: 0.85, lineHeight: 1.4 }}>
                  {collateralIn === undefined
                    ? `Swaps only enough ${selectedCollateral?.symbol ?? ''} to repay ${borrowedAsset.amount.toFixed(4)} ${borrowedAsset.symbol}.`
                    : `Swaps the ${selectedCollateral?.symbol ?? ''} amount you chose; anything beyond the debt comes back as ${borrowedAsset.symbol}.`}{' '}
                  Nothing is requested until you press Execute — then your wallet asks for{' '}
                  <strong>two signatures and one transaction</strong>.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span>⚠️</span>
                <span style={{ fontSize: 'var(--text-sm)' }}>One-click close is not available on this network yet.</span>
              </div>
            )}
          </div>

          {/*
            Once the action has landed the quote has been cleared, and an empty quote panel
            renders as "no swap route available" — which reads as a failure directly under a
            successful transaction. Show what actually happened instead.
          */}
          {isComplete && (
            <div className="alert alert-success" style={{ marginBottom: 'var(--space-5)' }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span>✅</span>
                <span style={{ fontSize: 'var(--text-sm)' }}>
                  {isSameAsset
                    ? `Repayment submitted. Your ${borrowedAsset.symbol} position will update once it confirms.`
                    : `Position closed. Your ${borrowedAsset.symbol} debt is repaid and the unswapped ${selectedCollateral?.symbol} stays supplied in Aave.`}
                </span>
              </div>
            </div>
          )}

          {slippageTooTight && !isComplete && (() => {
            const suggestion = suggestWiderSlippage(slippage, SLIPPAGE_PRESETS, SLIPPAGE_SUGGESTION_CAP)
            return (
              <div className="alert alert-warning" style={{ marginBottom: 'var(--space-5)' }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                  <span>⚠️</span>
                  <div style={{ fontSize: 'var(--text-sm)' }}>
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
            <div className="alert alert-success" style={{ marginBottom: 'var(--space-5)' }}>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <span>🔑</span>
                <span style={{ fontSize: 'var(--text-sm)' }}>
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

          {!isSameAsset && closeAvailable && !isComplete && (
            <div style={{ marginBottom: 'var(--space-5)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Estimated Output</h4>
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
                  style={{ fontSize: 'var(--text-xs)', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: '4px', cursor: isQuoting ? 'default' : 'pointer', opacity: isQuoting ? 0.6 : 1 }}
                >
                  <span>↻</span> {isQuoting ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
              {preview && preview.covered ? (
                <div style={{ padding: '14px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
                  <div className="info-row">
                    <span className="info-row-label">Collateral in (to swap)</span>
                    <span className="info-row-value">{formatAmount(preview.collateralSwapped)} {preview.collateralSymbol}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-row-label">Debt to repay</span>
                    <span className="info-row-value">{formatAmount(preview.debtRepaid)} {preview.debtSymbol}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-row-label">Min debt out (router)</span>
                    <span className="info-row-value" style={{ color: preview.guaranteed ? 'var(--color-success)' : 'var(--color-danger)' }}>
                      {formatAmount(preview.minDebtOut)} {preview.debtSymbol}
                    </span>
                  </div>
                  {Number(preview.debtReturned) > 0 && (
                    <div className="info-row">
                      <span className="info-row-label" style={{ fontWeight: 600 }}>
                        Sent to your wallet (est.)
                      </span>
                      <span className="info-row-value" style={{ color: 'var(--color-success)', fontWeight: 600 }}>
                        {formatAmount(preview.debtReturned)} {preview.debtSymbol}
                      </span>
                    </div>
                  )}
                  <div className="info-row">
                    <span className="info-row-label" style={{ fontWeight: 600 }}>Stays supplied in Aave (est.)</span>
                    <span className="info-row-value" style={{ color: 'var(--color-success)', fontWeight: 600 }}>
                      {formatAmount(preview.collateralKeptSupplied)} {preview.collateralSymbol}
                      {preview.collateralKeptSuppliedUsd != null ? ` (~$${preview.collateralKeptSuppliedUsd.toFixed(2)})` : ''}
                    </span>
                  </div>
                  <div className="info-row">
                    <span className="info-row-label">Route</span>
                    <span className="info-row-value">{preview.aggregator}</span>
                  </div>
                  {preview.routeCostPercent != null && (
                    <div className="info-row">
                      <span className="info-row-label">Price impact &amp; fees</span>
                      <span
                        className="info-row-value"
                        style={{
                          color:
                            preview.routeCostPercent > PRICE_IMPACT_HIGH_PERCENT
                              ? 'var(--color-danger)'
                              : undefined,
                        }}
                      >
                        {preview.routeCostPercent < 0 ? '+' : '−'}
                        {Math.abs(preview.routeCostPercent).toFixed(3)}%
                      </span>
                    </div>
                  )}
                  {preview.rate != null && (
                    <div className="info-row">
                      <span className="info-row-label">Rate</span>
                      <span className="info-row-value">
                        1 {preview.collateralSymbol} = {formatAmount(preview.rate)}{' '}
                        {preview.debtSymbol}
                      </span>
                    </div>
                  )}
                  {preview.guaranteedRate != null && (
                    <div className="info-row">
                      <span className="info-row-label">
                        Worst rate at {slippage}%
                      </span>
                      <span className="info-row-value">
                        1 {preview.collateralSymbol} = {formatAmount(preview.guaranteedRate)}{' '}
                        {preview.debtSymbol}
                      </span>
                    </div>
                  )}
                  {!preview.guaranteed && (
                    <div style={{ marginTop: '10px', fontSize: 'var(--text-xs)', color: 'var(--color-danger)', lineHeight: 1.4 }}>
                      ⚠️ At {slippage}% slippage the router only guarantees {formatAmount(preview.minDebtOut)} {preview.debtSymbol}, short of the {formatAmount(preview.debtRequired)} {preview.debtSymbol} needed to cover your {formatAmount(preview.debtRepaid)} {preview.debtSymbol} debt plus the interest accruing before this lands. Closing is blocked so you don't sign for a swap that would revert on-chain — lower the slippage to guarantee it.
                    </div>
                  )}
                  <p style={{ fontSize: 'var(--text-xs)', marginTop: '10px', marginBottom: 0, opacity: 0.7, lineHeight: 1.4 }}>
                    {collateralIn === undefined
                      ? `Only enough ${preview.collateralSymbol} is swapped for the router's guaranteed output to repay the debt at ${slippage}% slippage; the rest stays supplied in Aave.`
                      : `You chose how much ${preview.collateralSymbol} to swap. The debt is repaid first and the surplus is sent to your wallet as ${preview.debtSymbol}; any ${preview.collateralSymbol} you did not swap stays supplied in Aave.`}{' '}
                    Estimated from your live balances.
                  </p>
                </div>
              ) : preview && !preview.covered ? (
                <div className="alert alert-warning" style={{ margin: 0 }}>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                    <span>⚠️</span>
                    <span style={{ fontSize: 'var(--text-sm)' }}>
                      {collateralIn === undefined
                        ? 'Collateral won’t cover the debt — the position is underwater. Try a different collateral.'
                        : 'That much collateral won’t cover the debt. Increase the amount, or clear it to let the swap size itself.'}
                    </span>
                  </div>
                </div>
              ) : isQuoting ? (
                <div style={{ padding: '14px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
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
                    <div style={{ fontSize: 'var(--text-sm)' }}>
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
                <div style={{ padding: '14px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
                  No swap route available for this pair right now.
                </div>
              )}
            </div>
          )}

          {uiMaxFee && uiMaxPriority && (
            <div style={{ padding: '12px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
              {estimatedFeeUsd > 0 && (
                <div className="info-row">
                  <span className="info-row-label" style={{ fontWeight: 600 }}>Network Fee (Estimated)</span>
                  <span className="info-row-value" style={{ fontWeight: 600 }}>
                    ~${estimatedFeeUsd.toFixed(2)}
                  </span>
                </div>
              )}
              <div className="info-row">
                <span className="info-row-label">Max Fee (Estimated)</span>
                <span className="info-row-value">{Number(formatGwei(uiMaxFee)).toFixed(2)} Gwei</span>
              </div>
              <div className="info-row">
                <span className="info-row-label">Max Priority Fee</span>
                <span className="info-row-value">{Number(formatGwei(uiMaxPriority)).toFixed(2)} Gwei</span>
              </div>
            </div>
          )}

          {shownLogs.length > 0 && (
            <div style={{ marginTop: 'var(--space-5)', padding: '12px', backgroundColor: 'var(--color-surface-alt)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)', borderRadius: 'var(--radius-md)', fontSize: '12px', fontFamily: 'var(--font-mono)', maxHeight: '150px', overflowY: 'auto' }}>
              {shownLogs.map((l, i) => (
                <div key={i} style={{ marginBottom: '4px' }}>{l}</div>
              ))}
            </div>
          )}

          {/* What the close settled at, read off its own receipt — the only figures on this
              screen that are not forecasts. */}
          <TxOutcomePanel outcome={settled} tokens={outcomeTokens} />

          {txHash && (
            <div style={{ marginTop: 'var(--space-5)' }}>
              <ExplorerLink hash={txHash} chainId={chainId} />
            </div>
          )}
        </div>

        <div className="modal-footer">
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
          <button
            onClick={executeClose}
            disabled={isProcessing || !canExecute}
            className="btn-primary"
            style={{ flex: 1, padding: '10px' }}
          >
            {isProcessing
              ? 'Processing…'
              : isSameAsset || signedUntil !== null
                ? 'Execute Close'
                : 'Sign Approval'}
          </button>
        </div>
    </Modal>
  )
}
