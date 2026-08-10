import type { LiquidationView } from '../utils/liquidation'
import { hasLiquidationRowsToShow } from '../utils/liquidation'
import { T } from '../styles/theme'

interface LiquidationPriceBlockProps {
  view: LiquidationView
  isModal?: boolean
}

export function LiquidationPriceBlock({ view, isModal }: LiquidationPriceBlockProps) {
  if (!hasLiquidationRowsToShow(view)) return null

  // With more than one row the label is symbol-qualified ("Liquidation price (USDC)"), so a null
  // row is still attributed — "USDC alone cannot liquidate you" — and worth stating as "None".
  // With a single row the label is bare ("Liquidation price"), unattributed to any asset, so a
  // null there would read as "this position cannot be liquidated" — drop it instead.
  const isMultiRow = view.rows.length > 1
  const rows = isMultiRow ? view.rows : view.rows.filter(row => row.liquidationPriceUsd !== null)
  // The correlated figure survives every row being unattributable on its own: assets that only
  // liquidate the position TOGETHER are exactly the case it exists to quote.
  const drop = isMultiRow ? view.marketWideDropPct : null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: T.space[3]
      }}
    >
      {rows.map(row => (
          <div key={row.symbol} className="info-row" style={{ fontSize: T.fontSize.sm, padding: 0, paddingBottom: T.space[1] }}>
            <span className="info-row-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {!isModal && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="16" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
              )}
              {/* Every row carries the same label, so once there is more than one the symbol is
                  what tells them apart — in the modal too, where the preview card can now show
                  a row per collateral asset. */}
              {isMultiRow ? `Liquidation price (${row.symbol})` : 'Liquidation price'}
            </span>
            {row.liquidationPriceUsd === null ? (
              <span className="info-row-value text-muted" style={{ fontWeight: 400, fontSize: T.fontSize.sm }}>
                None
              </span>
            ) : (
              <span className="info-row-value" style={{ fontSize: isModal ? T.fontSize.base : '1.25rem' }}>
                ${row.liquidationPriceUsd.toFixed(2)}
              </span>
            )}
          </div>
      ))}

      {drop !== null && (
         <div className="info-row" style={{ fontSize: T.fontSize.sm, padding: 0, paddingBottom: T.space[1] }}>
            <span className="info-row-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {!isModal && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="16" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
              )}
              Market-wide drop
            </span>
            <span className="info-row-value" style={{ fontSize: isModal ? T.fontSize.base : '1.25rem' }}>
              {(drop * 100).toFixed(1)}%
            </span>
         </div>
      )}
    </div>
  )
}
