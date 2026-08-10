import { formatGwei } from 'viem'
import type { LiquidationView } from '../utils/liquidation'
import { hasLiquidationRowsToShow } from '../utils/liquidation'
import { LiquidationPriceBlock } from './LiquidationPriceBlock'
import { T, infoCardStyle, labelStyle } from '../styles/theme'

interface GasInfoCardProps {
  maxFee?: bigint
  maxPriority?: bigint
  estimatedFeeUsd?: number
  currentHealthFactor?: string
  newHealthFactor?: string
  liquidationView?: LiquidationView
}

const hfColor = (hf: string) =>
  Number(hf) < 1.1 ? T.danger : Number(hf) < 1.5 ? T.warning : T.success

/**
 * GasInfoCard — the shared "Health Factor + Estimated Gas" card used by the
 * Aave supply / borrow / repay / withdraw modals. Renders nothing until it has
 * either a health factor to show or fee data.
 */
export function GasInfoCard({ maxFee, maxPriority, estimatedFeeUsd = 0, currentHealthFactor, newHealthFactor, liquidationView }: GasInfoCardProps) {
  const showHealth = !!newHealthFactor
  const showGas = !!maxFee && !!maxPriority
  if (!showHealth && !showGas && !liquidationView) return null

  return (
    <div style={infoCardStyle}>
      {showHealth && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: liquidationView && hasLiquidationRowsToShow(liquidationView) ? T.space[2] : T.space[4], fontSize: T.fontSize.base, fontWeight: 500, color: T.text }}>
          <span>Health Factor</span>
          <span style={{ color: hfColor(newHealthFactor!), fontFamily: T.font.mono, fontWeight: 700, fontSize: T.fontSize.xl }}>
            {currentHealthFactor} → {newHealthFactor}
          </span>
        </div>
      )}
      {liquidationView && hasLiquidationRowsToShow(liquidationView) && (
        <div style={{ marginBottom: T.space[4] }}>
          <LiquidationPriceBlock view={liquidationView} isModal />
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
