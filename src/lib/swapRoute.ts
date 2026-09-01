/**
 * Route-quality helpers that do not depend on the direction of the trade.
 *
 * Extracted from closePlan.ts so the open flow can share them rather than growing a second
 * copy that drifts. closePlan.ts re-exports all of these, so its consumers are unaffected.
 */
import { quoteRate } from './deleverage'

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

/**
 * Symbol lists, deliberately, and only to choose a DEFAULT DIRECTION.
 *
 * `isVolatilePrice` classifies on price and is the right tool where a wrong answer costs money —
 * see `utils/liquidation`. Here a wrong answer costs a reader one glance, and no price is on hand
 * anyway: the callers have two symbols and two amounts, nothing more.
 */
const STABLES = ['USDC', 'USDT', 'DAI', 'USDS', 'FRAX', 'LUSD', 'USDE']
const MAJORS = ['WETH', 'ETH', 'WBTC', 'CBBTC', 'WSTETH', 'CBETH', 'RETH', 'WEETH']

const has = (list: readonly string[], symbol: string) => list.includes(symbol.toUpperCase())

/**
 * Whether a rate for this pair reads better the other way round.
 *
 * A rate has two readings and only one of them is legible: "1 WETH = 2,444 USDC" against
 * "1 USDC = 0.000409 WETH". Which one that is depends on the PAIR, not on the direction the swap
 * happens to run — a close selling USDC for WETH is still a trade about the price of WETH.
 *
 * Lives here rather than in RateLine so the settled panel, the close modal and the history row
 * cannot state the same fill three different ways.
 */
export function preferInverted(srcSymbol: string, dstSymbol: string): boolean {
  return has(STABLES, srcSymbol) || has(MAJORS, dstSymbol)
}

/** A fill stated as a price: "1 `unit` = `rate` `quote`". */
export interface Reading {
  unit: string
  quote: string
  rate: string
}

export interface StatedRate extends Reading {
  /**
   * The same fact read from the other end, for a flip control.
   *
   * Carried rather than left to the UI to derive: inverting the rounded `rate` rounds twice, and
   * the toggle would then disagree with itself. Both come off the amounts, once.
   */
  inverse: Reading
}

/**
 * One fill stated as a price, in whichever direction is legible.
 *
 * Both directions are computed from the AMOUNTS. Inverting an already-rounded rate rounds twice
 * before the divide, which is what once turned a 0.000532989 fill into 1,879.6992 instead of
 * 1,876.2123.
 *
 * Callers wanting two rates for the same swap — an expected fill and the floor under it — pass
 * the same symbols to both calls, so the pair decides one direction for both and the two lines
 * stay comparable. That matters more than it sounds: un-inverted a worse fill is a SMALLER
 * number, inverted it is a larger one, and a "worst rate" that moved the wrong way would read as
 * the better of the two.
 *
 * Null when either leg is zero — that has no ratio in either direction, and leaving it to
 * `quoteRate`'s divisor guard would report the other direction as a flat zero.
 */
export function statedRate(o: {
  srcSymbol: string
  dstSymbol: string
  srcDecimals: number
  dstDecimals: number
  /** What went in, in `srcSymbol` units. */
  spentAmount: bigint
  /** What came back, in `dstSymbol` units. */
  returnAmount: bigint
}): StatedRate | null {
  if (o.spentAmount <= 0n || o.returnAmount <= 0n) return null

  const perSrc = quoteRate(o.returnAmount, o.spentAmount, o.srcDecimals, o.dstDecimals)
  const perDst = quoteRate(o.spentAmount, o.returnAmount, o.dstDecimals, o.srcDecimals)
  if (perSrc === null || perDst === null) return null

  const asSrc: Reading = { unit: o.srcSymbol, quote: o.dstSymbol, rate: perSrc }
  const asDst: Reading = { unit: o.dstSymbol, quote: o.srcSymbol, rate: perDst }
  return preferInverted(o.srcSymbol, o.dstSymbol)
    ? { ...asDst, inverse: asSrc }
    : { ...asSrc, inverse: asDst }
}
