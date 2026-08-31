import { T } from '../styles/theme'

export interface RouteOffer {
  aggregator: string
  /** The route's output, pre-formatted in the token `symbol` names. */
  amountOut: string
}

interface RoutePickerProps {
  /** Every aggregator that answered, best-first. Nothing is rendered for fewer than two. */
  routes: RouteOffer[]
  /** The token `amountOut` is denominated in. */
  symbol: string
  /** The aggregator the user pinned, or null while the ranking decides. */
  pinned: string | null
  onPin: (aggregator: string | null) => void
  /** Blocks pinning while a quote is in flight, so a click cannot land on a list being replaced. */
  disabled?: boolean
}

/**
 * How much worse than the winner a route is, as a percentage of the winner's output.
 *
 * Read off the display strings rather than the wei, because that is what the row is showing and
 * a difference the user cannot see in the numbers above it is not one worth printing. Null when
 * either side is unparseable or the winner is zero.
 */
function shortfall(best: string, other: string): number | null {
  const b = Number(best)
  const o = Number(other)
  if (!Number.isFinite(b) || !Number.isFinite(o) || b <= 0) return null
  return ((b - o) / b) * 100
}

/**
 * The aggregators that priced this swap, and a way to override which one is used.
 *
 * The ranking picks the best output on its own, so this is not a step in the flow — it is there
 * for the times the best output is not the route the user wants, most often because a cheaper
 * route with a fatter transaction is the one that actually fits in a block. Pinning is therefore
 * a hard override rather than a preference: the pinned route is quoted, sized and built on its
 * own, and if it cannot serve the trade the flow says so instead of quietly reverting to the
 * route that won.
 */
export function RoutePicker({ routes, symbol, pinned, onPin, disabled }: RoutePickerProps) {
  // One route is not a choice, and a picker offering no alternative reads as a setting the user
  // has to understand before continuing.
  if (routes.length < 2) return null

  const best = routes[0]

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: T.space[2],
        fontSize: T.fontSize.sm, padding: T.space[3],
        border: `1px solid ${T.border}`, borderRadius: T.radius.md,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase' }}>
          Routes
        </span>
        {pinned !== null && (
          <button
            type="button"
            onClick={() => onPin(null)}
            disabled={disabled}
            style={{
              background: 'none', border: 'none', padding: 0,
              cursor: disabled ? 'default' : 'pointer',
              color: disabled ? T.textMuted : T.primary,
              fontWeight: 600, fontSize: T.fontSize.xs,
            }}
          >
            Use best
          </button>
        )}
      </div>

      {routes.map((r, i) => {
        // With nothing pinned the ranking's own winner is the one being used, which is the first
        // row by construction.
        const active = pinned === null ? i === 0 : pinned === r.aggregator
        const behind = i === 0 ? null : shortfall(best.amountOut, r.amountOut)
        return (
          <button
            key={r.aggregator}
            type="button"
            onClick={() => onPin(r.aggregator)}
            disabled={disabled}
            aria-pressed={active}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
              gap: T.space[3], width: '100%', textAlign: 'left',
              padding: `${T.space[2]} ${T.space[3]}`,
              border: `1px solid ${active ? T.primary : T.border}`,
              borderRadius: T.radius.md,
              background: active ? T.surfaceAlt : T.surface,
              cursor: disabled ? 'default' : 'pointer',
              fontSize: T.fontSize.sm, color: T.text,
            }}
          >
            <span style={{ fontWeight: active ? 700 : 500 }}>
              {r.aggregator}
              {i === 0 && (
                <span style={{ marginLeft: T.space[2], color: T.success, fontSize: T.fontSize.xs }}>
                  best
                </span>
              )}
            </span>
            <span style={{ color: T.textSubtle, textAlign: 'right' }}>
              {r.amountOut} {symbol}
              {behind !== null && behind > 0 && (
                <span style={{ marginLeft: T.space[2], color: T.textMuted }}>
                  −{behind.toFixed(2)}%
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
