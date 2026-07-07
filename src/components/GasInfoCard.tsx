import { formatGwei } from 'viem'
import { T, infoCardStyle, labelStyle } from '../styles/theme'

interface GasInfoCardProps {
  maxFee?: bigint
  maxPriority?: bigint
  estimatedFeeUsd?: number
  /** Show the "current → new" health-factor row (omit for supply-only flows without a position). */
  currentHealthFactor?: string
  newHealthFactor?: string
}

const hfColor = (hf: string) =>
  Number(hf) < 1.1 ? T.danger : Number(hf) < 1.5 ? T.warning : T.success

/**
 * GasInfoCard — the shared "Health Factor + Estimated Gas" card used by the
 * Aave supply / borrow / repay / withdraw modals. Renders nothing until it has
 * either a health factor to show or fee data.
 */
export function GasInfoCard({ maxFee, maxPriority, estimatedFeeUsd = 0, currentHealthFactor, newHealthFactor }: GasInfoCardProps) {
  const showHealth = !!newHealthFactor
  const showGas = !!maxFee && !!maxPriority
  if (!showHealth && !showGas) return null

  return (
    <div style={infoCardStyle}>
      {showHealth && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: T.space[4], fontSize: T.fontSize.base, fontWeight: 500, color: T.text }}>
          <span>Health Factor</span>
          <span style={{ color: hfColor(newHealthFactor!), fontFamily: T.font.mono, fontWeight: 700, fontSize: T.fontSize.xl }}>
            {currentHealthFactor} → {newHealthFactor}
          </span>
        </div>
      )}
      {showGas && (
        <>
          <div style={{ ...labelStyle, display: 'flex', justifyContent: 'space-between', marginBottom: T.space[2] }}>
            <span>Estimated Gas</span>
            {estimatedFeeUsd > 0 && <span style={{ color: T.text, fontWeight: 700, fontSize: T.fontSize.base }}>~${estimatedFeeUsd.toFixed(2)}</span>}
          </div>
          <div style={{ display: 'flex', gap: T.space[6], fontSize: T.fontSize.sm }}>
            <span style={{ color: T.textMuted }}>Max fee: <strong style={{ color: T.text, fontFamily: T.font.mono }}>{Number(formatGwei(maxFee!)).toFixed(2)} Gwei</strong></span>
            <span style={{ color: T.textMuted }}>Priority: <strong style={{ color: T.text, fontFamily: T.font.mono }}>{Number(formatGwei(maxPriority!)).toFixed(2)} Gwei</strong></span>
          </div>
        </>
      )}
    </div>
  )
}
