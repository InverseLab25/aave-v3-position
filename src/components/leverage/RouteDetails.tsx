import { formatUnits } from 'viem'
import { T } from '../../styles/theme'

interface RouteDetailsProps {
  /** The aggregator's own `amountOut` for this route, in COLLATERAL units, before slippage. */
  expectedOut: bigint
  /** The floor the contract enforces on the swap, in COLLATERAL units: `expectedOut` less slippage. */
  minOut: bigint
  /**
   * What the swap spends, in DEBT units — the router's FULL input. On the debt-margin path that
   * is the borrow plus the posted margin, not the borrow alone; passing the borrow here quotes a
   * rate against a fraction of the input and flatters it by however much margin was posted.
   */
  swapIn: bigint
  collateralSymbol: string
  debtSymbol: string
  collateralDecimals: number
  debtDecimals: number
  /** The tolerance separating `expectedOut` from `minOut`, for labelling the guaranteed row. */
  slippageBps: bigint
}

/**
 * Rates are quoted as debt-per-collateral in BOTH rows, so expected and guaranteed are directly
 * comparable — the whole point is the gap between them, which is the slippage tolerance and
 * nothing else. A pair like USDC/WETH lands well below 1, where two decimals would print "0.00",
 * so the precision follows the magnitude rather than being fixed.
 */
function rate(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: value >= 1 ? 2 : 6,
  })
}

function amount(value: bigint, decimals: number, places: number): string {
  return Number(formatUnits(value, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space[3], alignItems: 'baseline' }}>
      <span style={{ color: T.textMuted }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  )
}

/**
 * What the swap leg of the open commits to: what goes in, what the route expects to return, and
 * the floor the transaction will still accept.
 *
 * The aggregator's name lives in PositionSummary's "Route" row and is deliberately not repeated
 * here.
 */
export function RouteDetails({
  expectedOut, minOut, swapIn,
  collateralSymbol, debtSymbol, collateralDecimals, debtDecimals,
  slippageBps,
}: RouteDetailsProps) {
  // Both sides are display-scale by this point, so float division is accurate enough for a
  // quoted rate — and nothing downstream spends these numbers.
  const inUnits = Number(formatUnits(swapIn, debtDecimals))
  const rateFor = (out: bigint): number | null => {
    const outUnits = Number(formatUnits(out, collateralDecimals))
    return outUnits > 0 ? inUnits / outUnits : null
  }
  // Both rows come off the same route, so the only thing separating them is the slippage
  // tolerance — which is the comparison worth showing. An external mark (Aave's oracle) used to
  // sit in the second row, and it answered a different question: it moved for reasons that had
  // nothing to do with this swap, so the gap between the two was never purely slippage.
  const expected = rateFor(expectedOut)
  const guaranteed = rateFor(minOut)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: T.space[2],
      fontSize: T.fontSize.sm, padding: T.space[3],
      border: `1px solid ${T.border}`, borderRadius: T.radius.md,
    }}>
      <div style={{ fontSize: T.fontSize.xs, color: T.textMuted, textTransform: 'uppercase' }}>Route</div>

      {expected !== null && (
        <Row label="Swapping">
          <span style={{ color: T.textSubtle }}>
            {amount(swapIn, debtDecimals, 4)} {debtSymbol} → {amount(expectedOut, collateralDecimals, 4)}{' '}
            {collateralSymbol} (min {amount(minOut, collateralDecimals, 4)})
          </span>
        </Row>
      )}

      {expected !== null && (
        <Row label="Expected rate">
          <span style={{ color: T.textSubtle }}>
            1 {collateralSymbol} = {rate(expected)} {debtSymbol}
          </span>
        </Row>
      )}

      {/* The floor, not the estimate: this is the rate the transaction reverts below, so it is the
          one worth committing to memory before signing. */}
      {guaranteed !== null && (
        <Row label={`Guaranteed rate (-${Number(slippageBps) / 100}%)`}>
          <span style={{ fontWeight: 600 }}>
            1 {collateralSymbol} = {rate(guaranteed)} {debtSymbol}
          </span>
        </Row>
      )}
    </div>
  )
}
