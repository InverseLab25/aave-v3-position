import type { LiquidationRow, LiquidationView } from '../utils/liquidation'
import { T } from '../styles/theme'

interface LiquidationPriceBlockProps {
  view: LiquidationView
  isEModeEnabled: boolean
}

/** Fraction of the bar filled: closer to liquidation renders fuller. */
function fillFraction(bufferPct: number): number {
  return Math.min(1, Math.max(0, 1 - Math.abs(bufferPct)))
}

/** Under a 15% cushion is danger, under 30% is warning, otherwise calm. */
function bufferColor(bufferPct: number): string {
  const cushion = Math.abs(bufferPct)
  if (cushion < 0.15) return T.danger
  if (cushion < 0.30) return T.warning
  return T.textMuted
}

function Row({ row }: { row: LiquidationRow }) {
  const isUnliquidatable = row.liquidationPriceUsd === null

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(60px, 1fr) minmax(90px, 1.2fr) minmax(90px, 1.2fr) auto',
        gap: T.space[3],
        alignItems: 'center',
        padding: `${T.space[2]} 0`,
        fontSize: T.fontSize.base,
      }}
    >
      <span style={{ fontWeight: 600 }}>{row.symbol}</span>

      {isUnliquidatable ? (
        <span
          className="text-muted"
          style={{ gridColumn: '2 / -1', fontSize: T.fontSize.sm }}
          title="Your other collateral already covers the debt, so this asset could fall to zero without liquidating you."
        >
          — can't liquidate you alone
        </span>
      ) : (
        <>
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            ${row.liquidationPriceUsd!.toFixed(2)}
          </span>
          <span className="text-muted" style={{ fontSize: T.fontSize.sm, fontVariantNumeric: 'tabular-nums' }}>
            now ${row.currentPriceUsd.toFixed(2)}
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: T.space[2],
              color: bufferColor(row.bufferPct!),
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {(row.bufferPct! * 100).toFixed(1)}%
            <span
              aria-hidden="true"
              style={{
                width: '56px',
                height: '4px',
                borderRadius: T.radius.sm,
                background: T.surfaceAlt,
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  display: 'block',
                  width: `${fillFraction(row.bufferPct!) * 100}%`,
                  height: '100%',
                  background: bufferColor(row.bufferPct!),
                }}
              />
            </span>
          </span>
        </>
      )}
    </div>
  )
}

/**
 * LiquidationPriceBlock — the collateral prices at which this position liquidates.
 *
 * Each row assumes every OTHER asset's price holds, which is the convention Aave's
 * own UI uses. The market-wide line covers the correlated case that per-asset rows
 * understate, and only appears when it says something the rows do not.
 */
export function LiquidationPriceBlock({ view, isEModeEnabled }: LiquidationPriceBlockProps) {
  if (view.rows.length === 0) return null

  return (
    <div
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: T.radius.lg,
        padding: `${T.space[3]} ${T.space[4]}`,
        marginTop: T.space[4],
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: T.space[3],
          flexWrap: 'wrap',
          marginBottom: T.space[2],
        }}
      >
        <span style={{ fontSize: T.fontSize.xs, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: T.textMuted }}>
          Liquidation price
        </span>
        <span className="text-muted" style={{ fontSize: T.fontSize.xs }}>
          each assumes other prices hold
        </span>
      </div>

      {view.rows.map(row => <Row key={row.symbol} row={row} />)}

      {view.marketWideDropPct !== null && (
        <div
          style={{
            borderTop: `1px solid ${T.border}`,
            marginTop: T.space[2],
            paddingTop: T.space[2],
            fontSize: T.fontSize.sm,
            color: T.textMuted,
          }}
        >
          Market-wide: all collateral falling together liquidates you at{' '}
          <strong style={{ color: bufferColor(view.marketWideDropPct) }}>
            {(view.marketWideDropPct * 100).toFixed(1)}%
          </strong>
        </div>
      )}

      {isEModeEnabled && (
        <div
          style={{
            marginTop: T.space[2],
            fontSize: T.fontSize.xs,
            color: T.warning,
          }}
        >
          E-Mode is on — these prices use standard thresholds, so they are conservative
          and will not line up exactly with your health factor.
        </div>
      )}
    </div>
  )
}
