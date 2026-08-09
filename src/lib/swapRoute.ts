/**
 * Route-quality helpers that do not depend on the direction of the trade.
 *
 * Extracted from closePlan.ts so the open flow can share them rather than growing a second
 * copy that drifts. closePlan.ts re-exports all of these, so its consumers are unaffected.
 */

/**
 * How far the executing route may fall below the one the user reviewed, in percent.
 *
 * Matches KyberSwap's own "Accept new amount" trigger. Our close re-quotes after the
 * signature, so without this a route that degraded several percent would still be submitted
 * silently — it clears the debt on a well-covered position, so no other check catches it.
 */
export const MAX_OUTPUT_DEGRADATION_PERCENT = -1

/** Route gives up this much value → warn. KyberSwap's `isHigh`. */
export const PRICE_IMPACT_HIGH_PERCENT = 2

/** Route gives up this much → refuse. KyberSwap blocks here outside degen mode. */
export const PRICE_IMPACT_BLOCK_PERCENT = 10

/**
 * What the route costs, as a percentage of the value put in.
 *
 * Derived from the aggregator's own USD figures for the two sides, so it includes price
 * impact, DEX fees and the spread — everything between "what I put in" and "what I get".
 * Positive means value lost. Null when either side is unpriced.
 */
export function routeCostPercent(amountInUsd?: string, amountOutUsd?: string): number | null {
  const inUsd = Number(amountInUsd)
  const outUsd = Number(amountOutUsd)
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd) || inUsd <= 0) return null
  return ((inUsd - outUsd) / inUsd) * 100
}

/**
 * Whether a revert or simulation failure is the aggregator saying "your slippage is too tight".
 *
 * KyberSwap's router reverts with `Return amount is not enough`; its API reports the same
 * condition with messages containing `min` or `smaller`. Their own interface matches on
 * exactly these three substrings before offering a wider tolerance, so we do too.
 */
export function isSlippageShapedFailure(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('enough') || m.includes('min') || m.includes('smaller')
}

/**
 * A slippage worth retrying at, in percent, or null if there is nothing sensible to suggest.
 *
 * Steps up through the presets the UI already offers rather than inventing a number, and
 * refuses to suggest beyond `cap` — a tolerance nobody should be nudged into accepting.
 */
export function suggestWiderSlippage(
  currentPercent: number,
  presets: readonly number[],
  cap: number,
): number | null {
  const next = [...presets].sort((a, b) => a - b).find((p) => p > currentPercent && p <= cap)
  return next ?? null
}
