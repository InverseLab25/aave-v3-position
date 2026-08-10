import { formatUnits } from 'viem'
import type { OpenPreview } from '../hooks/useStrategiesOpen'
import { evaluateHf } from '../utils/health'
import { computeLiquidationView } from '../utils/liquidation'
import type { CollateralInput } from '../utils/liquidation'
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
  /** `getUserAccountData` totals, 8dp USD — what this position is being added to. */
  existingCollateralUsd: bigint
  existingDebtUsd: bigint
  /** The ACCOUNT's weighted liquidation threshold as a FRACTION — what the existing collateral
   *  above is already weighted at. */
  existingLiquidationThreshold: number
}

/**
 * Row symbol for the existing account, aggregated. Never displayed: it participates in the
 * liquidation maths (it covers debt) but has no price of its own to quote.
 */
const EXISTING_ROW = '__existing__'

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
  existingCollateralUsd, existingDebtUsd, existingLiquidationThreshold,
}: PositionPreviewProps) {
  if (!preview) return null

  const collateralAmount = Number(formatUnits(preview.expectedCollateral, collateralDecimals))
  const debtAmount = Number(formatUnits(preview.expectedDebt, debtDecimals))
  const hf = Number(preview.expectedHealthFactorBps) / 10000
  const hfLevel = evaluateHf(hf)

  // Every number on this card has to sit on ONE basis. `expectedHealthFactorBps` is account-wide
  // (it folds the existing position in), so the liquidation price must be too — solving it
  // against the position's deltas alone told a comfortably safe user, on the ratchet path, that
  // they were already liquidatable.
  //
  // Aave's USD totals are 8dp; `formatUnits` is display-only, and everything downstream here is
  // already the Number-based liquidation model.
  const existingCollUsd = Number(formatUnits(existingCollateralUsd, 8))
  const existingDebtUsdNum = Number(formatUnits(existingDebtUsd, 8))

  // computeLiquidationView takes POSITIONAL args — a collateral array and the debt in USD.
  // `liquidationThreshold` is load-bearing here: it is what turns collateral into the weighted
  // value the liquidation price solves against, so it must be the reserve's real fraction.
  const collateralRows: CollateralInput[] = [{
    symbol: collateralSymbol,
    amount: collateralAmount,
    priceUsd: collateralPriceUsd,
    liquidationThreshold,
  }]
  if (existingCollUsd > 0) {
    // The existing account enters as one aggregate at its account-wide threshold. Priced at $1
    // per unit, so `amount` is its USD value and its weighted contribution comes out exact — and
    // so `isVolatilePrice` reads a portfolio (which has no single price to fall) as stable and
    // keeps it out of the market-wide-drop figure.
    collateralRows.push({
      symbol: EXISTING_ROW,
      amount: existingCollUsd,
      priceUsd: 1,
      liquidationThreshold: existingLiquidationThreshold,
    })
  }

  const view = computeLiquidationView(
    collateralRows,
    debtAmount * debtPriceUsd + existingDebtUsdNum,
  )
  const liquidationView = { ...view, rows: view.rows.filter((r) => r.symbol !== EXISTING_ROW) }

  const rows: Array<[string, string]> = [
    ['Collateral', `${fmt(preview.expectedCollateral, collateralDecimals, 4)} ${collateralSymbol}`],
    ['Debt', `${fmt(preview.expectedDebt, debtDecimals, 2)} ${debtSymbol}`],
    // Null on the ratchet path: equity added is ~zero, so a ratio would be noise.
    ['Leverage', preview.expectedLeverageBps === null
      ? '—'
      : `${(Number(preview.expectedLeverageBps) / 10000).toFixed(2)}x`],
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
