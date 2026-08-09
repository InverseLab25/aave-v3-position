import { LEVERAGE_STEP_BPS, leverageCeilingBps, sliderMax } from '../lib/openPlan'
import { T } from '../styles/theme'

interface OpenPositionFormProps {
  marginStr: string
  onMarginChange: (value: string) => void
  marginBalance: string
  marginSymbol: string
  marginIn: 'collateral' | 'debt'
  onMarginInChange: (value: 'collateral' | 'debt') => void
  collateralSymbol: string
  debtSymbol: string
  leverageBps: bigint
  onLeverageChange: (value: bigint) => void
  ltvBps: bigint
  liquidationThresholdBps: bigint
  dangerEnabled: boolean
  onDangerToggle: (on: boolean) => void
}

const MIN_LEVERAGE_BPS = 10_100n

/**
 * Margin amount, which asset it is posted in, and how much leverage.
 *
 * The slider stops at the health-factor ceiling by default. Past it is the stretch where a
 * modest adverse move liquidates, so reaching it takes an explicit toggle rather than a drag.
 */
export function OpenPositionForm(p: OpenPositionFormProps) {
  const { soft, hard } = leverageCeilingBps({
    ltvBps: p.ltvBps,
    liquidationThresholdBps: p.liquidationThresholdBps,
  })
  const usable = hard !== null
  const max = usable ? sliderMax(soft, hard, p.dangerEnabled) : MIN_LEVERAGE_BPS
  const leverage = (Number(p.leverageBps) / 10000).toFixed(2)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[3] }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm }}>
        <span style={{ color: T.textMuted }}>Margin</span>
        <span style={{ color: T.textMuted }}>max {p.marginBalance} {p.marginSymbol}</span>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: T.space[2],
        border: `1px solid ${T.border}`, borderRadius: T.radius.md, padding: T.space[2],
        background: T.surface,
      }}>
        <input
          value={p.marginStr}
          onChange={(e) => p.onMarginChange(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          aria-label="Margin amount"
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: T.fontSize.md, background: 'transparent' }}
        />
        <span style={{ fontWeight: 600 }}>{p.marginSymbol}</span>
      </div>

      <div style={{ display: 'flex', gap: T.space[2], alignItems: 'center', fontSize: T.fontSize.sm }}>
        <span style={{ color: T.textMuted }}>pay with</span>
        {(['collateral', 'debt'] as const).map((role) => (
          <button
            key={role}
            onClick={() => p.onMarginInChange(role)}
            style={{
              padding: `${T.space[1]} ${T.space[2]}`, borderRadius: T.radius.sm,
              border: `1px solid ${p.marginIn === role ? T.primary : T.border}`,
              background: p.marginIn === role ? T.primary : 'transparent',
              color: p.marginIn === role ? '#fff' : T.text,
              cursor: 'pointer', fontSize: T.fontSize.sm,
            }}
          >
            {role === 'collateral' ? p.collateralSymbol : p.debtSymbol}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm }}>
        <span style={{ color: T.textMuted }}>Leverage</span>
        <span style={{ fontWeight: 600 }}>{leverage}x</span>
      </div>
      <input
        type="range"
        role="slider"
        min={Number(MIN_LEVERAGE_BPS)}
        max={Number(max)}
        step={Number(LEVERAGE_STEP_BPS)}
        value={Number(p.leverageBps)}
        disabled={!usable}
        onChange={(e) => p.onLeverageChange(BigInt(e.target.value))}
        aria-label="Leverage"
      />

      {usable && soft !== null && hard > soft && (
        <label style={{ display: 'flex', gap: T.space[2], fontSize: T.fontSize.sm, color: T.textMuted }}>
          <input
            type="checkbox"
            checked={p.dangerEnabled}
            onChange={(e) => p.onDangerToggle(e.target.checked)}
          />
          Allow leverage above {(Number(soft) / 10000).toFixed(2)}x — closer to liquidation
        </label>
      )}
    </div>
  )
}
