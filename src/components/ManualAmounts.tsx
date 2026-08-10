import { T } from '../styles/theme'

interface ManualAmountsProps {
  borrowStr: string
  onBorrowChange: (value: string) => void
  flashStr: string
  onFlashChange: (value: string) => void
  debtSymbol: string
  collateralSymbol: string
  /** Validation copy from `manualOpenErrorMessage`, already formatted. */
  message: string | null
}

/**
 * The two amounts the derived path normally solves for.
 *
 * Values stay strings all the way up to the parent: a half-typed "2." is not a bigint, and
 * parsing here would either throw on every keystroke or quietly round what the user meant.
 */
export function ManualAmounts(p: ManualAmountsProps) {
  const field = (
    label: string,
    hint: string,
    value: string,
    onChange: (v: string) => void,
    symbol: string,
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[1] }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm }}>
        <span style={{ color: T.textMuted }}>{label}</span>
        <span style={{ color: T.textMuted }}>{hint}</span>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: T.space[2],
        border: `1px solid ${T.border}`, borderRadius: T.radius.md, padding: T.space[2],
        background: T.surface,
      }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          aria-label={label}
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: T.fontSize.md, background: 'transparent' }}
        />
        <span style={{ fontWeight: 600 }}>{symbol}</span>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[3] }}>
      {field('Debt amount', 'borrow from Aave', p.borrowStr, p.onBorrowChange, p.debtSymbol)}
      {field('Flash amount', 'flash from Morpho', p.flashStr, p.onFlashChange, p.collateralSymbol)}

      {p.message && (
        <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>{p.message}</div>
      )}
    </div>
  )
}
