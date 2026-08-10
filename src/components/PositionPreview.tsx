import { formatUnits } from 'viem'
import type { OpenPreview } from '../hooks/useStrategiesOpen'
import { evaluateHf } from '../utils/health'
import { computeLiquidationView } from '../utils/liquidation'
import type { CollateralInput } from '../utils/liquidation'
import { BPS } from '../lib/strategies-sdk/sizing'
import { PRICE_IMPACT_HIGH_PERCENT } from '../lib/swapRoute'
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
  /**
   * The account this position lands on top of: its collateral PER ASSET, and its debt as an
   * 8dp USD total.
   *
   * These have to describe the same basis `preview.expectedHealthFactorBps` was computed on, and
   * the caller owns keeping them that way — empty and 0n whenever the preview's numbers are the
   * position's deltas alone. An account-wide liquidation price beside a position-only health
   * factor is how this card came to tell a safe user they were already liquidatable.
   *
   * Per asset rather than one aggregate because a fall in the new leg's price moves any existing
   * holding of that same asset with it — see the merge below.
   */
  existingCollateral: CollateralInput[]
  existingDebtUsd: bigint
}

/** bps -> a display double. Amounts stay bigint; only the rendered figure crosses over. */
function fromBps(value: bigint): number {
  return Number(value) / Number(BPS)
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
  existingCollateral, existingDebtUsd,
}: PositionPreviewProps) {
  if (!preview) return null

  const collateralAmount = Number(formatUnits(preview.expectedCollateral, collateralDecimals))
  const debtAmount = Number(formatUnits(preview.expectedDebt, debtDecimals))
  const hf = fromBps(preview.expectedHealthFactorBps)
  const hfLevel = evaluateHf(hf)

  // Copied, not mutated in place: the array belongs to the caller and is re-read every render.
  const collateralRows: CollateralInput[] = existingCollateral.map((row) => ({ ...row }))

  // The new leg MERGES into the existing row for the same asset instead of sitting beside it.
  // Both move together when that asset's price falls, so two rows would hold the existing units
  // at today's price and quote a liquidation price far under the truth — and once those units
  // alone cover the debt, quote none at all. Ratchet exists to lever an existing position,
  // usually in that same asset, so this is the norm there rather than an edge case.
  const sameAsset = collateralRows.find(
    (row) => row.symbol.toUpperCase() === collateralSymbol.toUpperCase(),
  )
  if (sameAsset) {
    // Same reserve, so the row's own price and threshold already describe the new units too.
    sameAsset.amount += collateralAmount
  } else {
    collateralRows.push({
      symbol: collateralSymbol,
      amount: collateralAmount,
      priceUsd: collateralPriceUsd,
      liquidationThreshold,
    })
  }

  // Aave's USD totals are 8dp; `formatUnits` is display-only, and everything downstream here is
  // already the Number-based liquidation model.
  const liquidationView = computeLiquidationView(
    collateralRows,
    debtAmount * debtPriceUsd + Number(formatUnits(existingDebtUsd, 8)),
  )

  const rows: Array<[string, string]> = [
    ['Collateral', `${fmt(preview.expectedCollateral, collateralDecimals, 4)} ${collateralSymbol}`],
    ['Debt', `${fmt(preview.expectedDebt, debtDecimals, 2)} ${debtSymbol}`],
    // Null on the ratchet path: equity added is ~zero, so a ratio would be noise.
    ['Leverage', preview.expectedLeverageBps === null
      ? '—'
      : `${fromBps(preview.expectedLeverageBps).toFixed(2)}x`],
    ['Route', preview.aggregator],
  ]

  const priceImpact = preview.priceImpactPercent
  const priceImpactHigh = priceImpact != null && priceImpact > PRICE_IMPACT_HIGH_PERCENT

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
      {priceImpact != null && (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: T.textMuted }}>Price impact</span>
          <span style={{ fontWeight: 600, color: priceImpactHigh ? T.danger : T.text }}>
            {priceImpact < 0 ? '+' : '−'}{Math.abs(priceImpact).toFixed(2)}%
          </span>
        </div>
      )}
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
