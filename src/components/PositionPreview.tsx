import { formatUnits } from 'viem'
import type { OpenPreview } from '../hooks/useStrategiesOpen'
import { evaluateHf } from '../utils/health'
import { computeLiquidationView } from '../utils/liquidation'
import { LiquidationPriceBlock } from './LiquidationPriceBlock'
import { T } from '../styles/theme'

interface PositionPreviewProps {
  preview: OpenPreview | null
  collateralSymbol: string
  debtSymbol: string
  collateralDecimals: number
  debtDecimals: number
  collateralPriceUsd: number
  debtPriceUsd: number
  /** The collateral reserve's liquidation threshold as a FRACTION, e.g. 0.83 — not bps. */
  liquidationThreshold: number
}

function fmt(amount: bigint, decimals: number, places: number): string {
  return Number(formatUnits(amount, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}

/**
 * What the position becomes if this opens.
 *
 * Liquidation price and health-factor colouring come from the shared utils rather than being
 * recomputed — one owner each, so the portfolio and this preview can never disagree.
 */
export function PositionPreview({
  preview, collateralSymbol, debtSymbol,
  collateralDecimals, debtDecimals, collateralPriceUsd, debtPriceUsd, liquidationThreshold,
}: PositionPreviewProps) {
  if (!preview) return null

  const collateralAmount = Number(formatUnits(preview.expectedCollateral, collateralDecimals))
  const debtAmount = Number(formatUnits(preview.expectedDebt, debtDecimals))
  const hf = Number(preview.expectedHealthFactorBps) / 10000
  const hfLevel = evaluateHf(hf)

  // computeLiquidationView takes POSITIONAL args — a collateral array and the debt in USD.
  // `liquidationThreshold` is load-bearing here: it is what turns collateral into the weighted
  // value the liquidation price solves against, so it must be the reserve's real fraction.
  const liquidationView = computeLiquidationView(
    [{
      symbol: collateralSymbol,
      amount: collateralAmount,
      priceUsd: collateralPriceUsd,
      liquidationThreshold,
    }],
    debtAmount * debtPriceUsd,
  )

  const rows: Array<[string, string]> = [
    ['Collateral', `${fmt(preview.expectedCollateral, collateralDecimals, 4)} ${collateralSymbol}`],
    ['Debt', `${fmt(preview.expectedDebt, debtDecimals, 2)} ${debtSymbol}`],
    ['Leverage', `${(Number(preview.expectedLeverageBps) / 10000).toFixed(2)}x`],
    ['Route', preview.aggregator],
  ]

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: T.space[2],
      padding: T.space[3], background: T.bg,
      border: `1px solid ${T.border}`, borderRadius: T.radius.lg,
      fontSize: T.fontSize.base,
    }}>
      <div style={{ fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase' }}>
        You will end up with
      </div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: T.textMuted }}>{label}</span>
          <span style={{ fontWeight: 600 }}>{value}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: T.textMuted }}>Health factor</span>
        <span style={{ fontWeight: 600, color: hfLevel.level === 'ok' ? T.success : hfLevel.level === 'warn' ? T.warning : T.danger }}>
          {hf.toFixed(2)}
        </span>
      </div>
      <LiquidationPriceBlock view={liquidationView} isModal />
    </div>
  )
}
