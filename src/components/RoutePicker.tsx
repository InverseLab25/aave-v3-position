import { T } from '../styles/theme'

export interface RouteOffer {
  aggregator: string
  /** The route's output as the aggregator QUOTED it, pre-formatted in the token `symbol` names. */
  amountOut: string
  /**
   * What the route was MEASURED to return, simulated against live state. Absent when nothing
   * measured it.
   *
   * Shown alongside the quote rather than in place of it: the gap between the two is the only
   * thing on screen that says whether an aggregator's own number can be taken at face value.
   */
  measuredOut?: string
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
        // Compared on the MEASURED figures wherever both have one. Measuring a winner against a
        // runner-up's quote compares the aggregators' honesty rather than the routes, and the
        // percentage would move when nobody's price had.
        const shown = r.measuredOut ?? r.amountOut
        const behind = i === 0 ? null : shortfall(best.measuredOut ?? best.amountOut, shown)
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
              {shown} {symbol}
              {behind !== null && behind > 0 && (
                <span style={{ marginLeft: T.space[2], color: T.textMuted }}>
                  −{behind.toFixed(2)}%
                </span>
              )}
              {/* The aggregator's own claim, kept next to the measurement rather than replaced by
                  it. The gap is the only thing here that says whether that claim can be taken at
                  face value. Absent when nothing measured the route — the quote is then already
                  the figure above, and repeating it would read as agreement between two sources
                  when there is only one. */}
              {r.measuredOut !== undefined && (
                <span
                  style={{
                    display: 'block', color: T.textMuted, fontSize: T.fontSize.xs,
                  }}
                  title="What the aggregator quoted, before simulation"
                >
                  quoted {r.amountOut}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
