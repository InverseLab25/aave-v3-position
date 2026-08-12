/**
 * The last look before a leveraged position is opened, and the only place its route is kept fresh.
 *
 * The panel quotes once per change to the form and then stops, which is right for a form — but it
 * meant the route in `preview.swapData` could be minutes old by the time Open was pressed, and an
 * aggregator's calldata does not survive that. The open reverted, the hook's `finally` re-quoted,
 * and the next press worked: the "click it two or three times" failure. Nothing is submitted from
 * the panel any more. It is submitted from here, against a route re-priced seconds ago.
 */
import { useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import type { OpenPreview, OpenStep } from '../../hooks/useLeverageOpen'
import type { OpenProjection } from '../../lib/leverage'
import { PRICE_IMPACT_HIGH_PERCENT } from '../../lib/swapRoute'
import { ExplorerLink } from '../ExplorerLink'
import { RouteDetails } from './RouteDetails'
import { T } from '../../styles/theme'

/**
 * Rest between one quote settling and the next being requested — NOT a fixed interval.
 *
 * Same reasoning as the close modal: a route at size takes seconds to compute, so a timer that
 * fires regardless launches quotes that overlap the one still running, and they queue up on the
 * slowest endpoint in the app. Waiting for the current one to settle keeps exactly one in flight.
 */
const QUOTE_REFRESH_MS = 3000

interface ConfirmLeverageModalProps {
  /** "Open long WETH" / "Boost long WETH" — the same label the panel's button carries. */
  title: string
  /** What the wallet puts in, formatted with its symbol. Null on the boost path, which posts none. */
  marginLine: string | null
  /** What the position gains, and what funds it. Formatted by the panel, which owns the decimals. */
  supplyLine: string
  borrowLine: string

  preview: OpenPreview | null
  /** Router-verified when there is a preview; the panel's oracle estimate before that. */
  projection: OpenProjection | null
  isQuoting: boolean
  /** Why there is no usable preview, already turned into a sentence by the panel. */
  previewMessage: string | null
  /**
   * The pinned borrow no longer prices — offer to drop the held signature and re-size, since
   * nothing else in the modal can clear it.
   */
  showResign: boolean

  priceImpactBlocked: boolean
  slippageBps: bigint
  collateralSymbol: string
  debtSymbol: string
  collateralDecimals: number
  debtDecimals: number

  step: OpenStep
  execError: string | null
  /** What to do about `execError`, when the decoded revert suggests something. */
  remedyHint: string | null
  txHash: `0x${string}` | undefined
  chainId: number

  /** Set when confirming would spend a signature already taken — so no wallet prompt is coming. */
  reusableSignature: { value: bigint; deadline: bigint } | null

  onRefresh: () => void
  onResign: () => void
  onConfirm: () => void
  onClose: () => void
}

function formatHealthFactor(bps: bigint): string {
  // Aave reports an account with no debt as uint256 max, and anything above 1000x is either that
  // or near enough to it that a number reads as less honest than the symbol.
  if (bps > 10_000_000n) return '∞'
  return (Number(bps) / 10000).toFixed(2)
}

export function ConfirmLeverageModal({
  title, marginLine, supplyLine, borrowLine,
  preview, projection, isQuoting, previewMessage, showResign,
  priceImpactBlocked, slippageBps,
  collateralSymbol, debtSymbol, collateralDecimals, debtDecimals,
  step, execError, remedyHint, txHash, chainId,
  reusableSignature, onRefresh, onResign, onConfirm, onClose,
}: ConfirmLeverageModalProps) {
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000))

  const busy = step === 'approving' || step === 'signing' || step === 'sending'
  const done = step === 'done'

  // Re-quote on a cadence so what is confirmed is what was just priced. Paused while the wallet
  // has the transaction: a quote landing mid-flow moves the figures under the user, and the
  // signature has committed to the borrow anyway. Stopped once it lands — there is nothing left
  // to price, and a refresh would only spend rate-limit budget.
  useEffect(() => {
    if (busy || done || isQuoting) return
    const id = setTimeout(onRefresh, QUOTE_REFRESH_MS)
    return () => clearTimeout(id)
  }, [busy, done, isQuoting, onRefresh])

  // Only ticks while a signature is held, and only inside the callback — never as a render effect.
  useEffect(() => {
    if (!reusableSignature) return
    const id = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [reusableSignature])

  const secondsLeft = reusableSignature
    ? Math.max(0, Number(reusableSignature.deadline) - nowSeconds)
    : 0

  const impact = preview?.priceImpactPercent ?? null

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h2>{title}</h2>
        </div>

        <div className="modal-body">
          <div className="info-row">
            <span className="info-row-label">You supply</span>
            <span className="info-row-value">{supplyLine}</span>
          </div>
          {marginLine && (
            <div className="info-row">
              <span className="info-row-label">From your wallet</span>
              <span className="info-row-value">{marginLine}</span>
            </div>
          )}
          <div className="info-row">
            <span className="info-row-label">You borrow</span>
            <span className="info-row-value" style={{ color: T.danger }}>{borrowLine}</span>
          </div>
          {projection && (
            <div className="info-row">
              <span className="info-row-label">Health factor after</span>
              <span className="info-row-value">
                {formatHealthFactor(projection.expectedHealthFactorBps)}
              </span>
            </div>
          )}

          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginTop: T.space[4], marginBottom: T.space[2],
          }}>
            <h4 style={{ margin: 0, fontSize: T.fontSize.sm }}>Route</h4>
            <button
              onClick={onRefresh}
              disabled={isQuoting || busy}
              className="btn-ghost"
              title="Re-price this route now"
              style={{
                fontSize: T.fontSize.xs, padding: '3px 8px',
                cursor: isQuoting || busy ? 'default' : 'pointer', opacity: isQuoting || busy ? 0.6 : 1,
              }}
            >
              ↻ {isQuoting ? 'Pricing…' : 'Refresh'}
            </button>
          </div>

          {preview ? (
            <>
              <div className="info-row">
                <span className="info-row-label">Via</span>
                <span className="info-row-value">{preview.aggregator}</span>
              </div>
              <RouteDetails
                expectedOut={preview.expectedOut}
                minOut={preview.minOut}
                swapIn={preview.swapIn}
                collateralSymbol={collateralSymbol}
                debtSymbol={debtSymbol}
                collateralDecimals={collateralDecimals}
                debtDecimals={debtDecimals}
                slippageBps={slippageBps}
              />
              {impact != null && (
                <div className="info-row">
                  <span className="info-row-label">Price impact &amp; fees</span>
                  <span
                    className="info-row-value"
                    style={{ color: impact > PRICE_IMPACT_HIGH_PERCENT ? T.danger : undefined }}
                  >
                    {impact < 0 ? '+' : '−'}{Math.abs(impact).toFixed(3)}%
                  </span>
                </div>
              )}
            </>
          ) : isQuoting ? (
            <div style={{ fontSize: T.fontSize.sm, color: T.textMuted }}>Pricing the route…</div>
          ) : (
            <div className="alert alert-warning" style={{ margin: 0 }}>
              <span style={{ fontSize: T.fontSize.sm }}>
                {previewMessage ?? 'No route available for this pair right now.'}
              </span>
            </div>
          )}

          {/* The pinned borrow is what the held signature authorises, so a route that has moved
              past it cannot be fixed by waiting — the signature has to go. */}
          {showResign && (
            <div className="alert alert-warning" style={{ marginTop: T.space[4] }}>
              <div style={{ fontSize: T.fontSize.sm }}>
                <strong style={{ display: 'block', marginBottom: '2px' }}>
                  The route moved past your signed size
                </strong>
                Nothing was submitted. Re-signing sizes the borrow to the current route.
                <button onClick={onResign} className="btn-ghost" style={{ marginLeft: T.space[2] }}>
                  Re-sign at the new size
                </button>
              </div>
            </div>
          )}

          {reusableSignature && !done && (
            <div className="alert alert-success" style={{ marginTop: T.space[4] }}>
              <span style={{ fontSize: T.fontSize.sm }}>
                🔑 Delegation already signed for{' '}
                <strong>{formatUnits(reusableSignature.value, debtDecimals)} {debtSymbol}</strong>
                {' '}— valid for{' '}
                <strong>
                  {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
                </strong>
                . Confirming submits with no further wallet prompt.
              </span>
            </div>
          )}

          {priceImpactBlocked && (
            <div style={{ marginTop: T.space[4], fontSize: T.fontSize.sm, color: T.danger }}>
              This route would give up {impact?.toFixed(2)}% of the position to price impact — too
              much to submit. Wait for deeper liquidity or supply less.
            </div>
          )}

          <div style={{ marginTop: T.space[4], fontSize: T.fontSize.sm, color: T.textMuted }}>
            {(['approving', 'signing', 'sending'] as const).map((s, i) => (
              <span
                key={s}
                style={{ fontWeight: step === s ? 700 : 400, color: step === s ? T.text : T.textMuted }}
              >
                {i > 0 && ' · '}
                {s === 'approving' ? 'approve' : s === 'signing' ? 'sign' : 'send'}
              </span>
            ))}
          </div>

          {execError && (
            <div style={{ marginTop: T.space[3], fontSize: T.fontSize.sm, color: T.danger }}>
              {execError}
              {remedyHint && <span style={{ color: T.textMuted }}> {remedyHint}</span>}
            </div>
          )}

          {done && txHash && (
            <div style={{ marginTop: T.space[4] }}>
              <ExplorerLink hash={txHash} chainId={chainId} />
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary" style={{ flex: 1, padding: '10px' }}>
            {done ? 'Done' : 'Cancel'}
          </button>
          {!done && (
            <button
              onClick={onConfirm}
              disabled={!preview || isQuoting || busy || priceImpactBlocked}
              className="btn-primary"
              style={{ flex: 1, padding: '10px' }}
            >
              {busy ? 'Processing…' : isQuoting ? 'Pricing…' : 'Confirm'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
