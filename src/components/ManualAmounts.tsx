import { T } from '../styles/theme'

interface ManualAmountsProps {
  supplyStr: string
  onSupplyChange: (value: string) => void
  collateralSymbol: string
  debtSymbol: string
  /** `supply - margin`, pre-formatted. Null before both amounts parse. */
  flashDisplay: string | null
  /** Pre-formatted. Null until the amounts imply one. */
  borrowDisplay: string | null
  /** True while `borrowDisplay` is the oracle's estimate rather than a solved, routed figure. */
  borrowIsEstimate: boolean
  /** Validation copy from `manualOpenErrorMessage`, already formatted. */
  message: string | null
}

/**
 * How much lands in the pool, and what that implies.
 *
 * Only the supply is typed. The flash is the gap between it and the margin, and the borrow is
 * whatever the router needs to repay that flash — asking the user for either invites a
 * combination that reverts, which is exactly what `solveBorrow` exists to make impossible.
 * They are shown, not edited, because the numbers are what a user checks before signing.
 *
 * The value stays a string all the way up to the parent: a half-typed "2." is not a bigint, and
 * parsing here would either throw on every keystroke or quietly round what the user meant.
 */
export function ManualAmounts(p: ManualAmountsProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[3] }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[1] }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm }}>
          <span style={{ color: T.textMuted }}>Supply</span>
          <span style={{ color: T.textMuted }}>goes to the pool</span>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: T.space[2],
          border: `1px solid ${T.border}`, borderRadius: T.radius.md, padding: T.space[2],
          background: T.surface,
        }}>
          <input
            value={p.supplyStr}
            onChange={(e) => p.onSupplyChange(e.target.value)}
            inputMode="decimal"
            placeholder="0.0"
            aria-label="Supply amount"
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: T.fontSize.md, background: 'transparent' }}
          />
          <span style={{ fontWeight: 600 }}>{p.collateralSymbol}</span>
        </div>
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: T.space[1],
        padding: T.space[2], background: T.bg,
        border: `1px solid ${T.border}`, borderRadius: T.radius.md, fontSize: T.fontSize.sm,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: T.textMuted }}>Flash from Morpho</span>
          <span style={{ fontWeight: 600 }}>
            {p.flashDisplay === null ? '—' : `${p.flashDisplay} ${p.collateralSymbol}`}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: T.textMuted }}>
            Borrow from Aave{p.borrowDisplay !== null && p.borrowIsEstimate ? ' (estimate)' : ''}
          </span>
          <span style={{ fontWeight: 600, color: p.borrowIsEstimate ? T.textMuted : T.text }}>
            {p.borrowDisplay === null ? '—' : `${p.borrowDisplay} ${p.debtSymbol}`}
          </span>
        </div>
      </div>

      {p.message && (
        <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>{p.message}</div>
      )}
    </div>
  )
}
