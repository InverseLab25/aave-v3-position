import { useState } from 'react'
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
 * Precision follows the magnitude. A pair quoted in the thousands is already past what anyone
 * reads at four decimals, while its inverse lands near 0.0005, where four decimals is nothing at
 * all — enough to print the expected and guaranteed rows as the same string and hide the very gap
 * the two rows exist to show. Below 1 the precision is counted in significant digits instead.
 */
function rate(value: number): string {
  return value >= 1
    ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : value.toLocaleString(undefined, { minimumSignificantDigits: 4, maximumSignificantDigits: 6 })
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

/** Reads the same rate from the other end of the pair — which side is quoted as 1, nothing more. */
function FlipButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Flip rate direction"
      style={{
        background: 'none', border: 'none', padding: 0, marginLeft: T.space[2],
        cursor: 'pointer', color: T.textMuted, fontSize: T.fontSize.sm, lineHeight: 1,
      }}
    >
      ⇄
    </button>
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
  const [flipped, setFlipped] = useState(false)

  // Both sides are display-scale by this point, so float division is accurate enough for a
  // quoted rate — and nothing downstream spends these numbers.
  const inUnits = Number(formatUnits(swapIn, debtDecimals))
  const ratio = (out: bigint, perDebt: boolean): number | null => {
    const outUnits = Number(formatUnits(out, collateralDecimals))
    if (inUnits <= 0 || outUnits <= 0) return null
    return perDebt ? outUnits / inUnits : inUnits / outUnits
  }

  // A rate is the same fact read from either end, but only one end is legible: "1 WETH = 1,890.36
  // USDC" is the number a trader recognises, and 0.000529 is that same number nobody can read. So
  // the default is whichever orientation puts the expected rate at or above 1, and the flip is
  // there for anyone who wants the other one.
  const naturalPerDebt = (ratio(expectedOut, true) ?? 0) >= 1
  const perDebt = flipped ? !naturalPerDebt : naturalPerDebt

  const base = perDebt ? debtSymbol : collateralSymbol
  const quoted = perDebt ? collateralSymbol : debtSymbol

  // Both rows come off the same route, so the only thing separating them is the slippage
  // tolerance — which is the comparison worth showing. An external mark (Aave's oracle) used to
  // sit in the second row, and it answered a different question: it moved for reasons that had
  // nothing to do with this swap, so the gap between the two was never purely slippage.
  const expected = ratio(expectedOut, perDebt)
  const guaranteed = ratio(minOut, perDebt)
  // Slippage cuts the collateral the swap returns, so it drags a collateral-per-debt quote down
  // and pushes its inverse up. The sign tracks the orientation rather than always claiming a
  // decrease, which would read as a contradiction against the number right next to it.
  const sign = perDebt ? '-' : '+'

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
            1 {base} = {rate(expected)} {quoted}
            <FlipButton onClick={() => setFlipped(f => !f)} />
          </span>
        </Row>
      )}

      {/* The floor, not the estimate: this is the rate the transaction reverts below, so it is the
          one worth committing to memory before signing. */}
      {guaranteed !== null && (
        <Row label={`Guaranteed rate (${sign}${Number(slippageBps) / 100}%)`}>
          <span style={{ fontWeight: 600 }}>
            1 {base} = {rate(guaranteed)} {quoted}
          </span>
        </Row>
      )}
    </div>
  )
}
