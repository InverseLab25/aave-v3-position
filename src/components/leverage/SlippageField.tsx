/**
 * The tolerance separating the route's expected output from the floor the contract enforces.
 *
 * Lives in two places on purpose. The panel sets it while sizing the position; the confirm modal
 * sets it against the route about to be sent, which is where a user actually finds out the
 * tolerance was too tight. One component so the presets, the clamping and the 0% warning cannot
 * drift between them.
 */
import { T } from '../../styles/theme'
import { MAX_SLIPPAGE_PERCENT, SLIPPAGE_PRESETS, toSlippageBps } from './slippage'

interface SlippageFieldProps {
  percent: number
  onChange: (percent: number) => void
  /**
   * Distinct per instance: the panel and the modal are mounted together, and two controls
   * answering to one name are ambiguous to a screen reader and to a test alike.
   */
  ariaLabel: string
  /** Set while the transaction is with the wallet — re-pricing then moves a signed floor. */
  disabled?: boolean
}

export function SlippageField({ percent, onChange, ariaLabel, disabled = false }: SlippageFieldProps) {
  const bps = toSlippageBps(percent)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[2] }}>
      <label style={{ fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase' }}>
        Max slippage
      </label>
      <div style={{ display: 'flex', gap: T.space[2], alignItems: 'center' }}>
        {SLIPPAGE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            disabled={disabled}
            style={{
              padding: `${T.space[1]} ${T.space[3]}`,
              border: `1px solid ${T.border}`,
              borderRadius: T.radius.md,
              background: percent === p ? T.primary : 'transparent',
              color: percent === p ? '#fff' : T.text,
              fontWeight: percent === p ? 600 : 400,
              cursor: disabled ? 'default' : 'pointer',
              opacity: disabled ? 0.6 : 1,
              fontSize: T.fontSize.sm,
            }}
          >
            {p}%
          </button>
        ))}
        <input
          type="number"
          step="any"
          min={0}
          max={MAX_SLIPPAGE_PERCENT}
          aria-label={ariaLabel}
          value={percent}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{
            flex: 1, minWidth: 0, padding: T.space[2],
            border: `1px solid ${T.border}`, borderRadius: T.radius.md,
            background: 'transparent', color: T.text, fontSize: T.fontSize.sm,
            opacity: disabled ? 0.6 : 1,
          }}
        />
      </div>
      {/* A cleared or nonsensical field reads as 0%, which means "no tolerance" and reverts on any
          move at all. Say so rather than letting an empty box look like a default. */}
      {bps === 0n && (
        <div style={{ fontSize: T.fontSize.xs, color: T.warning }}>
          0% leaves no room for the price to move — the open will revert unless the route fills
          exactly.
        </div>
      )}
    </div>
  )
}
