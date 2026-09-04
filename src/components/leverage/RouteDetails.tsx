import { useState } from 'react'
import { FlipRateButton } from '../FlipRateButton'
import { formatUnits } from 'viem'
import { T } from '../../styles/theme'
import type { OutBasis } from '../../lib/deleverage'

/** What each rung of `expectedOutcome` means, in the user's terms. */
const BASIS_NOTE: Record<OutBasis, string> = {
  simulated: 'Measured by simulating this exact route against live chain state',
  built: "The aggregator's own figure for the built route — nothing simulated it",
  quoted: "The aggregator's quote — neither simulated nor rebuilt",
}

interface RouteDetailsProps {
  /**
   * What the route is expected to return, in COLLATERAL units, before slippage.
   *
   * Usually the simulation's measurement rather than the aggregator's own claim — see
   * `expectedOutcome` for the ladder and {@link expectedBasis} for which rung this one is.
   */
  expectedOut: bigint
  /**
   * Whose word {@link expectedOut} is on.
   *
   * Shown because the two readings are not equally good and the rate alone cannot say which it
   * is. A simulated figure was measured against live state with router fees already inside it;
   * a built or quoted one is the aggregator's arithmetic about its own route, which nothing
   * checked. The user is deciding whether to sign against this number, so it is worth saying.
   */
  expectedBasis: OutBasis
  /**
   * What the aggregator quoted for this route, in COLLATERAL units, before anything measured it.
   *
   * Shown next to the measured figure rather than instead of it. The gap between the two is the
   * aggregator's own optimism, and it is the only thing on this panel that says whether its
   * numbers can be taken at face value — an aggregator quoting 0.4% over what its route really
   * does is worth seeing before signing, not after.
   */
  quotedOut: bigint
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
 *
 * FIXED width either side of that split, minimum equal to maximum. These rows exist to be read
 * against each other, and a range lets `toLocaleString` trim trailing zeros per value — 2456.7090
 * printed as "2,456.709" directly above 2459.1682 at its full four, which reads as two numbers of
 * different precision rather than as the same rate moved slightly.
 */
function rate(value: number): string {
  return value >= 1
    ? value.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })
    : value.toLocaleString(undefined, { minimumSignificantDigits: 6, maximumSignificantDigits: 6 })
}

function amount(value: bigint, decimals: number, places: number): string {
  return Number(formatUnits(value, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}

function Row({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: T.space[3], alignItems: 'baseline' }}>
      <span style={{ color: T.textMuted }} title={title}>{label}</span>
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
  expectedOut, expectedBasis, quotedOut, minOut, swapIn,
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
  // Only where a measurement actually displaced the quote. On the `built` and `quoted` rungs
  // `expectedOut` IS the quote, and printing it twice under two labels would invent a second
  // source that does not exist.
  const quotedRaw = expectedBasis === 'simulated' ? ratio(quotedOut, perDebt) : null
  const quotedRate = quotedRaw !== null && rate(quotedRaw) !== rate(expected ?? 0) ? quotedRaw : null
  /**
   * How far the measurement landed from the quote, as a percentage of the quote.
   *
   * Signed against the OUTPUT, not against whichever way the rate is currently flipped: a route
   * returning less than quoted is negative however the user is reading the pair. Deriving it
   * from the displayed rate instead would flip its sign with the button.
   */
  const drift =
    quotedRate !== null && quotedOut > 0n
      ? Number(((expectedOut - quotedOut) * 1_000_000n) / quotedOut) / 10_000
      : null
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
        <Row label={expectedBasis === 'simulated' ? 'Simulated rate' : 'Expected rate'} title={BASIS_NOTE[expectedBasis]}>
          <span style={{ color: T.textSubtle }}>
            1 {base} = {rate(expected)} {quoted}
            <FlipRateButton onClick={() => setFlipped(f => !f)} />
          </span>
        </Row>
      )}

      {/* The aggregator's own claim, alongside the measurement, and only when a measurement
          actually replaced it and the two differ enough to print differently. Identical rows
          would read as two sources agreeing when there is only one number. */}
      {expected !== null && quotedRate !== null && (
        <Row
          label="Quoted rate"
          title="What the aggregator said this route would return, before it was simulated"
        >
          <span style={{ color: T.textMuted }}>
            1 {base} = {rate(quotedRate)} {quoted}
            {drift !== null && (
              <span style={{ marginLeft: T.space[2], color: drift < 0 ? T.danger : T.textMuted }}>
                {drift > 0 ? '+' : ''}{drift.toFixed(2)}%
              </span>
            )}
          </span>
        </Row>
      )}

      {/* Only when it is NOT the measured one. Simulated is the normal case and saying so on every
          open would be noise; the other two mean the simulator could not be reached, which the
          user cannot see anywhere else and which makes this rate a weaker promise. */}
      {expected !== null && expectedBasis !== 'simulated' && (
        <div style={{ fontSize: T.fontSize.xs, color: T.textMuted }}>
          Not simulated — this rate is the aggregator's own estimate. The guaranteed rate below is
          still enforced on chain.
        </div>
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
