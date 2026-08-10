import type { LiquidationRow, LiquidationView } from '../utils/liquidation'
import { T } from '../styles/theme'

interface LiquidationPriceBlockProps {
  view: LiquidationView
  isModal?: boolean
}

type PricedRow = LiquidationRow & { liquidationPriceUsd: number }

export function LiquidationPriceBlock({ view, isModal }: LiquidationPriceBlockProps) {
  // An asset that cannot liquidate the position on its own has no price to attribute, and the
  // row is labelled by the position, not by the asset — so the word "None" there reads as an
  // affirmative "this position cannot be liquidated". Drop the row rather than claim that.
  const priced = view.rows.filter((row): row is PricedRow => row.liquidationPriceUsd !== null)
  // The correlated figure survives every row being unattributable on its own: assets that only
  // liquidate the position TOGETHER are exactly the case it exists to quote.
  const drop = view.rows.length > 1 ? view.marketWideDropPct : null
  if (priced.length === 0 && drop === null) return null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: T.space[3]
      }}
    >
      {priced.map(row => (
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
              {priced.length > 1 ? `Liquidation price (${row.symbol})` : 'Liquidation price'}
            </span>
            <span className="info-row-value" style={{ fontSize: isModal ? T.fontSize.base : '1.25rem' }}>
              ${row.liquidationPriceUsd.toFixed(2)}
            </span>
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
