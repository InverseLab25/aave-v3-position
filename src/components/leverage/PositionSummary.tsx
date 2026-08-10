import { formatUnits } from 'viem'
import type { OpenPreview } from '../../hooks/useLeverageOpen'
import {
  accountStats,
  debtLiquidationPriceUsd,
  type AccountStats,
  type Direction,
  type OpenProjection,
} from '../../lib/leverage'
import { BPS } from '../../lib/strategies-sdk/sizing'
import { PRICE_IMPACT_HIGH_PERCENT } from '../../lib/swapRoute'
import { evaluateHf } from '../../utils/health'
import { computeLiquidationView } from '../../utils/liquidation'
import type { CollateralInput } from '../../utils/liquidation'
import { T } from '../../styles/theme'

interface PositionSummaryProps {
  /** Null until a route answers. Only the route name and price impact need it. */
  preview: OpenPreview | null
  /**
   * What the position becomes. Estimated from oracle prices while the user types, then replaced
   * by the router-verified projection — so every "after" figure is readable from the first
   * keystroke rather than appearing only after a network round trip.
   */
  projection: OpenProjection | null
  isEstimate: boolean
  direction: Direction
  /** The asset the user took a view on — collateral on a long, debt on a short. */
  subjectSymbol: string
  flashAmount: bigint
  collateralSymbol: string
  debtSymbol: string
  collateralDecimals: number
  debtDecimals: number
  collateralPriceUsd: number
  debtPriceUsd: number
  /** The collateral reserve's liquidation threshold as a FRACTION, e.g. 0.83 — not bps. */
  liquidationThreshold: number
  /** The account this lands on top of: per-asset collateral, the 8dp USD totals, and the
   *  weighted parameters Aave judges it by. */
  existingCollateral: CollateralInput[]
  existingCollateralUsd: bigint
  existingDebtUsd: bigint
  existingLtvBps: bigint
  existingLiquidationThresholdBps: bigint
  /** The account's CURRENT holding of each pair leg, for the before-side liquidation price. */
  existingCollateralAmount: bigint
  existingDebtAmount: bigint
}

function fmt(amount: bigint, decimals: number, places: number): string {
  return Number(formatUnits(amount, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}

function usd(amount: bigint): string {
  return `$${Number(formatUnits(amount, 8)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function price(value: number | null): string | null {
  return value === null
    ? null
    : `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function bpsX(value: bigint | null): string | null {
  return value === null ? null : `${(Number(value) / Number(BPS)).toFixed(2)}x`
}

function bpsPct(value: bigint | null): string | null {
  return value === null ? null : `${(Number(value) / 100).toFixed(2)}%`
}

/**
 * One metric, as `current → after`.
 *
 * The arrow only appears once there is an "after" to show, so the card reads as a plain summary
 * of what the account is until the user has typed enough to change it.
 */
function DeltaRow({
  label, before, after, afterTone,
}: {
  label: string
  before: string | null
  after: string | null
  afterTone?: string
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space[3], alignItems: 'baseline' }}>
      <span style={{ color: T.textMuted }}>{label}</span>
      <span style={{ display: 'flex', gap: T.space[2], alignItems: 'baseline', textAlign: 'right' }}>
        <span style={{ color: after ? T.textSubtle : T.text, fontWeight: after ? 400 : 600 }}>
          {before ?? '—'}
        </span>
        {after && (
          <span style={{ fontWeight: 600, color: afterTone ?? T.primary }}>
            → {after}
          </span>
        )}
      </span>
    </div>
  )
}

function hfTone(healthFactorBps: bigint | null): string | undefined {
  if (healthFactorBps === null) return undefined
  const level = evaluateHf(Number(healthFactorBps) / Number(BPS)).level
  return level === 'ok' ? T.success : level === 'warn' ? T.warning : T.danger
}

function hfText(healthFactorBps: bigint | null): string | null {
  if (healthFactorBps === null) return null
  const hf = Number(healthFactorBps) / Number(BPS)
  return hf > 100 ? '∞' : hf.toFixed(2)
}

/**
 * What the account is, and what this transaction would make it.
 *
 * Every row is a before-and-after pair, because on the boost path the absolute numbers say very
 * little — the change is the entire point. The same treatment on a fresh open costs nothing: the
 * "before" column simply reads as zeros or dashes.
 *
 * The liquidation price is direction-aware, because the two directions are liquidated by
 * opposite moves. On a long the subject asset is the collateral and a FALL liquidates, which is
 * what `computeLiquidationView` solves — and it merges the new leg into any existing holding of
 * the same asset, since both fall together. On a short the subject is the debt and a RISE
 * liquidates; no collateral-side solve can express that, so `debtLiquidationPriceUsd` does it.
 */
export function PositionSummary({
  preview, projection, isEstimate, direction, subjectSymbol, flashAmount,
  collateralSymbol, debtSymbol, collateralDecimals, debtDecimals,
  collateralPriceUsd, debtPriceUsd, liquidationThreshold,
  existingCollateral, existingCollateralUsd, existingDebtUsd,
  existingLtvBps, existingLiquidationThresholdBps,
  existingCollateralAmount, existingDebtAmount,
}: PositionSummaryProps) {
  const before: AccountStats = accountStats({
    collateralUsd: existingCollateralUsd,
    debtUsd: existingDebtUsd,
    ltvBps: existingLtvBps,
    liquidationThresholdBps: existingLiquidationThresholdBps,
  })
  const after: AccountStats | null = projection
    ? accountStats({
        collateralUsd: projection.totalCollateralUsd,
        debtUsd: projection.totalDebtUsd,
        ltvBps: projection.avgLtvBps,
        liquidationThresholdBps: projection.avgLiquidationThresholdBps,
      })
    : null

  /**
   * The subject asset's liquidation price for a given position size. Used for both columns, so
   * the two are solved the same way and a change between them is a real change.
   */
  const liquidationPrice = (
    collateralAmount: bigint,
    debtAmount: bigint,
    liquidationThresholdBps: bigint,
    otherCollateralUsd: bigint,
    otherDebtUsd: bigint,
  ): number | null => {
    if (direction === 'short') {
      const solved = debtLiquidationPriceUsd({
        collateralAmount, debtAmount,
        collateralPriceUsd: BigInt(Math.round(collateralPriceUsd * 1e8)),
        collateralDecimals, debtDecimals,
        liquidationThresholdBps,
        existingCollateralUsd: otherCollateralUsd,
        existingDebtUsd: otherDebtUsd,
      })
      return solved === null ? null : Number(formatUnits(solved, 8))
    }
    // Long: solved across the merged collateral rows, so an existing holding of the same asset
    // is priced as the single position it actually is rather than as two that fall separately.
    const rows: CollateralInput[] = existingCollateral.map((r) => ({ ...r }))
    const amount = Number(formatUnits(collateralAmount, collateralDecimals))
    const sameAsset = rows.find((r) => r.symbol.toUpperCase() === collateralSymbol.toUpperCase())
    if (sameAsset) sameAsset.amount = amount
    else rows.push({ symbol: collateralSymbol, amount, priceUsd: collateralPriceUsd, liquidationThreshold })
    const debtUsd = Number(formatUnits(debtAmount, debtDecimals)) * debtPriceUsd
      + Number(formatUnits(otherDebtUsd, 8))
    return computeLiquidationView(rows, debtUsd).rows
      .find((r) => r.symbol.toUpperCase() === collateralSymbol.toUpperCase())
      ?.liquidationPriceUsd ?? null
  }

  // "Other" is whatever is NOT the pair leg being priced — the rest of the account, which the
  // solve holds at today's value while the subject's price moves.
  const otherCollateralUsd = existingCollateralUsd
    - BigInt(Math.round(Number(formatUnits(existingCollateralAmount, collateralDecimals)) * collateralPriceUsd * 1e8))
  const otherDebtUsd = existingDebtUsd
    - BigInt(Math.round(Number(formatUnits(existingDebtAmount, debtDecimals)) * debtPriceUsd * 1e8))

  const liqBefore = liquidationPrice(
    existingCollateralAmount, existingDebtAmount,
    existingLiquidationThresholdBps,
    otherCollateralUsd > 0n ? otherCollateralUsd : 0n,
    otherDebtUsd > 0n ? otherDebtUsd : 0n,
  )
  const liqAfter = projection
    ? liquidationPrice(
        existingCollateralAmount + projection.expectedCollateral,
        existingDebtAmount + projection.expectedDebt,
        projection.avgLiquidationThresholdBps,
        otherCollateralUsd > 0n ? otherCollateralUsd : 0n,
        otherDebtUsd > 0n ? otherDebtUsd : 0n,
      )
    : null

  const subjectPriceUsd = direction === 'long' ? collateralPriceUsd : debtPriceUsd
  const bufferPct = liqAfter !== null && subjectPriceUsd > 0 ? liqAfter / subjectPriceUsd - 1 : null

  const priceImpact = preview?.priceImpactPercent
  const priceImpactHigh = priceImpact != null && priceImpact > PRICE_IMPACT_HIGH_PERCENT

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: T.space[2],
      padding: T.space[3], background: T.bg,
      border: `1px solid ${T.border}`, borderRadius: T.radius.lg, fontSize: T.fontSize.base,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase' }}>
        <span>Position</span>
        <span>{isEstimate && projection ? 'estimated' : 'now → after'}</span>
      </div>

      <DeltaRow
        label="Supplied"
        before={`${fmt(existingCollateralAmount, collateralDecimals, 4)} ${collateralSymbol}`}
        after={projection
          ? `${fmt(existingCollateralAmount + projection.expectedCollateral, collateralDecimals, 4)} ${collateralSymbol}`
          : null}
      />
      <DeltaRow
        label="Borrowed"
        before={`${fmt(existingDebtAmount, debtDecimals, 4)} ${debtSymbol}`}
        after={projection
          ? `${fmt(existingDebtAmount + projection.expectedDebt, debtDecimals, 4)} ${debtSymbol}`
          : null}
      />
      <DeltaRow label="Exposure" before={bpsX(before.leverageBps) ?? '1.00x'} after={bpsX(after?.leverageBps ?? null)} />

      <div style={{ borderTop: `1px solid ${T.border}`, margin: `${T.space[1]} 0` }} />

      <DeltaRow
        label="Health factor"
        before={hfText(before.healthFactorBps) ?? '∞'}
        after={after ? hfText(after.healthFactorBps) : null}
        afterTone={hfTone(after?.healthFactorBps ?? null)}
      />
      <DeltaRow
        label={`${subjectSymbol} liquidation price`}
        before={price(liqBefore) ?? 'None'}
        after={price(liqAfter)}
      />
      {bufferPct !== null && (
        <div style={{ fontSize: T.fontSize.xs, color: T.textMuted, textAlign: 'right' }}>
          {direction === 'long' ? 'Falls' : 'Rises'} {Math.abs(bufferPct * 100).toFixed(1)}% from
          here to liquidate
        </div>
      )}
      <DeltaRow
        label="Borrow power used"
        before={bpsPct(before.borrowPowerUsedBps) ?? '0.00%'}
        after={after ? bpsPct(after.borrowPowerUsedBps) : null}
      />
      <DeltaRow
        label="Left to borrow"
        before={usd(before.leftToBorrowUsd)}
        after={after ? usd(after.leftToBorrowUsd) : null}
      />

      <div style={{ borderTop: `1px solid ${T.border}`, margin: `${T.space[1]} 0` }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space[3] }}>
        <span style={{ color: T.textMuted }}>Flash loan</span>
        <span style={{ fontWeight: 600 }}>
          {flashAmount > 0n ? `${fmt(flashAmount, collateralDecimals, 4)} ${collateralSymbol}` : '—'}
        </span>
      </div>
      {preview && (
        <>
          {priceImpact != null && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space[3] }}>
              <span style={{ color: T.textMuted }}>Price impact</span>
              <span style={{ fontWeight: 600, color: priceImpactHigh ? T.danger : T.text }}>
                {priceImpact < 0 ? '+' : '−'}{Math.abs(priceImpact).toFixed(2)}%
              </span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space[3] }}>
            <span style={{ color: T.textMuted }}>Route</span>
            <span style={{ fontWeight: 600 }}>{preview.aggregator}</span>
          </div>
        </>
      )}
    </div>
  )
}
