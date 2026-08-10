import type { Direction } from '../../lib/leverage'
import { T } from '../../styles/theme'

export interface PairOption {
  address: `0x${string}`
  symbol: string
}

/**
 * A position the account already holds, offered as a boost target.
 *
 * `direction`, `subject` and `quote` are precomputed so selecting one configures the whole form
 * — the roles have to come out as (collateral = what is supplied, debt = what is borrowed), and
 * the naming has to come out as a long or short on the volatile leg.
 */
export interface BoostPosition {
  key: string
  label: string
  direction: Direction
  subject: `0x${string}`
  quote: `0x${string}`
}

/** Long and short open against new equity; boost levers what the account already has. */
export type LeverageTab = Direction | 'boost'

interface PairPickerProps {
  tab: LeverageTab
  onTabChange: (next: LeverageTab) => void
  /** Why boost is unavailable, if it is. Shown as the tab's tooltip. */
  boostDisabledReason: string | null
  options: PairOption[]
  subject: `0x${string}` | undefined
  quote: `0x${string}` | undefined
  onSubjectChange: (next: `0x${string}`) => void
  onQuoteChange: (next: `0x${string}`) => void
  /** Boost picks a position it already holds rather than a pair — it adds no new equity, so
   *  there is nothing to open against except something already there. */
  positions: BoostPosition[]
  selectedPosition: string | undefined
  onPositionChange: (key: string) => void
  /** What the account holds on that position, for context under the select. */
  positionNote: string | null
}

/** Labels are spelled out rather than CSS-capitalized — `text-transform` leaves the accessible
 *  name lowercase, so a screen reader and a test both see "long" where the eye sees "Long". */
const TABS: Array<{ key: LeverageTab; label: string }> = [
  { key: 'long', label: 'Long' },
  { key: 'short', label: 'Short' },
  { key: 'boost', label: 'Boost' },
]

const selectStyle: React.CSSProperties = {
  border: `1px solid ${T.border}`, borderRadius: T.radius.md, background: T.surface,
  padding: `${T.space[2]} ${T.space[2]}`, fontSize: T.fontSize.base, fontWeight: 600,
  color: T.text, cursor: 'pointer',
}

/**
 * Direction, then what it applies to.
 *
 * Long and short pick a pair: the user says what they are taking a view on and what they are
 * pricing it against, and which leg ends up as collateral falls out of the direction — see
 * `resolveRoles`. Boost picks an existing position instead, because it adds no new equity and
 * so has nothing to open against except something already there.
 */
export function PairPicker({
  tab, onTabChange, boostDisabledReason,
  options, subject, quote, onSubjectChange, onQuoteChange,
  positions, selectedPosition, onPositionChange, positionNote,
}: PairPickerProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[3] }}>
      <div style={{ display: 'flex', gap: T.space[1], background: T.surfaceAlt, padding: T.space[1], borderRadius: T.radius.md }}>
        {TABS.map((t) => {
          const disabled = t.key === 'boost' && boostDisabledReason !== null
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              disabled={disabled}
              title={disabled ? boostDisabledReason ?? undefined : undefined}
              onClick={() => onTabChange(t.key)}
              style={{
                flex: 1, padding: T.space[2], borderRadius: T.radius.sm, border: 'none',
                cursor: disabled ? 'not-allowed' : 'pointer',
                fontWeight: 600, fontSize: T.fontSize.base,
                opacity: disabled ? 0.45 : 1,
                background: tab === t.key ? T.surface : 'transparent',
                color: tab === t.key ? T.text : T.textMuted,
                boxShadow: tab === t.key ? T.shadow.sm : 'none',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'boost' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[1] }}>
          <label style={{ fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase' }}>
            Position
          </label>
          <select
            aria-label="Position"
            value={selectedPosition ?? ''}
            onChange={(e) => onPositionChange(e.target.value)}
            style={{ ...selectStyle, width: '100%' }}
          >
            {positions.map((p) => (
              <option key={p.key} value={p.key}>{p.label}</option>
            ))}
          </select>
          {positionNote && (
            <div style={{ fontSize: T.fontSize.xs, color: T.textMuted }}>{positionNote}</div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: T.space[2], flexWrap: 'wrap' }}>
          <select
            aria-label="Asset"
            value={subject ?? ''}
            onChange={(e) => onSubjectChange(e.target.value as `0x${string}`)}
            style={selectStyle}
          >
            {options.map((o) => (
              <option key={o.address} value={o.address}>{o.symbol}</option>
            ))}
          </select>
          <span style={{ fontSize: T.fontSize.sm, color: T.textMuted }}>against</span>
          <select
            aria-label="Quote asset"
            value={quote ?? ''}
            onChange={(e) => onQuoteChange(e.target.value as `0x${string}`)}
            style={selectStyle}
          >
            {options.map((o) => (
              <option key={o.address} value={o.address}>{o.symbol}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
