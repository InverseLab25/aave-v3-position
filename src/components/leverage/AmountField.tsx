import { T } from '../../styles/theme'

export interface AssetChoice {
  value: string
  label: string
}

interface AmountFieldProps {
  label: string
  value: string
  onChange: (next: string) => void
  /** The asset the amount is denominated in. Rendered as a select when `choices` is given. */
  symbol: string
  choices?: AssetChoice[]
  selected?: string
  onSelect?: (next: string) => void
  /** Fills the field when MAX is pressed. Hidden when null. */
  max?: string | null
  /** Sub-line under the field: a balance, a ceiling, whatever explains the max. */
  hint?: string
  disabled?: boolean
}

/**
 * One amount row. Used for both inputs the panel has — the margin and the supply — so the two
 * always read and behave the same way.
 */
export function AmountField({
  label, value, onChange, symbol, choices, selected, onSelect, max, hint, disabled,
}: AmountFieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[1] }}>
      <label style={{ fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase' }}>
        {label}
      </label>
      <div style={{
        display: 'flex', alignItems: 'center', gap: T.space[2],
        border: `1px solid ${T.border}`, borderRadius: T.radius.md,
        background: disabled ? T.surfaceAlt : T.surface, padding: `0 ${T.space[2]}`,
      }}>
        <input
          // The visible <label> names the row, not this field — the asset select sits inside the
          // same row. Naming the input explicitly is what makes it addressable at all.
          aria-label={`${label} amount`}
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            // Digits and at most one dot. Rejecting at the keystroke keeps every downstream
            // parse total — nothing further down has to handle "1.2.3" or "abc".
            const next = e.target.value.replace(/[^0-9.]/g, '')
            if ((next.match(/\./g)?.length ?? 0) > 1) return
            onChange(next)
          }}
          style={{
            flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
            padding: `${T.space[3]} 0`, fontSize: T.fontSize.md, color: T.text,
          }}
        />
        {choices && onSelect ? (
          <select
            aria-label={`${label} asset`}
            value={selected}
            onChange={(e) => onSelect(e.target.value)}
            style={{
              border: 'none', background: 'transparent', outline: 'none',
              fontSize: T.fontSize.base, fontWeight: 600, color: T.text, cursor: 'pointer',
            }}
          >
            {choices.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        ) : (
          <span style={{ fontSize: T.fontSize.base, fontWeight: 600, color: T.text }}>{symbol}</span>
        )}
        {max !== null && max !== undefined && (
          <button
            type="button"
            onClick={() => onChange(max)}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: T.primary, fontWeight: 600, fontSize: T.fontSize.xs, padding: T.space[1],
            }}
          >
            MAX
          </button>
        )}
      </div>
      {hint && <div style={{ fontSize: T.fontSize.xs, color: T.textMuted }}>{hint}</div>}
    </div>
  )
}
