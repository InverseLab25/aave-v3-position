import type { LiquidationView } from '../utils/liquidation'
import { T } from '../styles/theme'

interface LiquidationPriceBlockProps {
  view: LiquidationView
  isModal?: boolean
}


export function LiquidationPriceBlock({ view, isModal }: LiquidationPriceBlockProps) {
  if (view.rows.length === 0) return null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: T.space[3]
      }}
    >
      {view.rows.map(row => {
        const isUnliquidatable = row.liquidationPriceUsd === null
        return (
          <div key={row.symbol} className="info-row" style={{ fontSize: T.fontSize.sm, padding: 0, paddingBottom: T.space[1] }}>
            <span className="info-row-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {!isModal && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="16" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
              )}
              {isModal ? 'Liquidation price' : `Liquidation price ${view.rows.length > 1 ? `(${row.symbol})` : ''}`}
            </span>
            {isUnliquidatable ? (
              <span className="info-row-value text-muted" style={{ fontWeight: 400, fontSize: T.fontSize.sm }}>
                None
              </span>
            ) : (
              <span className="info-row-value" style={{ fontSize: isModal ? T.fontSize.base : '1.25rem' }}>
                ${row.liquidationPriceUsd!.toFixed(2)}
              </span>
            )}
          </div>
        )
      })}
      
      {view.marketWideDropPct !== null && view.rows.length > 1 && (
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
              {(view.marketWideDropPct * 100).toFixed(1)}%
            </span>
         </div>
      )}
    </div>
  )
}
