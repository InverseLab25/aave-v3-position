import type { QuoteResponse } from '../adapters/types'
import { CloseError } from './deleverage'
import { ceilDiv } from './strategies-sdk/sizing'


/**
 * Headroom over what a price says is needed (0.3%), on the oracle seed and on the re-size alike.
 *
 * A price is only exact at the size it was sampled at: a larger swap pays more impact, and the
 * oracle knows nothing about the DEX spread at all. Nudging the size up trades a little
 * over-swapping for a quote that clears `needed` first time. Kept small — every basis point
 * here is collateral converted that did not need to be.
 */
const SEED_MARGIN_BPS = 30n

/**
 * How far over the buy-price size a sample may land and still be taken as it is (twice the margin).
 *
 * A right-sized oracle seed is worth keeping: it is one call, and the figure the user has been
 * looking at. Past this the sample over-swaps, and re-sizing keeps collateral supplied that
 * did not need to be sold.
 */
const SEED_TOLERANCE_BPS = 2n * SEED_MARGIN_BPS

/**
 * A swap size estimated from oracle prices, in collateral wei. Costs no network call.
 *
 * Inverts the same relation sizing solves for: the collateral whose value, after slippage,
 * covers `needed` of the debt token. Prices are passed already scaled to a common integer
 * precision, so the scale cancels in the ratio and the whole thing stays in bigint.
 *
 * Returns undefined when either price is missing or zero — the caller then falls back to
 * measuring the price with a quote.
 */
export function oracleSeed({
  needed,
  slipNum,
  collateralDecimals,
  debtDecimals,
  collateralPrice,
  debtPrice,
}: {
  needed: bigint
  slipNum: bigint
  collateralDecimals: number
  debtDecimals: number
  collateralPrice: bigint
  debtPrice: bigint
}): bigint | undefined {
  if (collateralPrice <= 0n || debtPrice <= 0n || slipNum <= 0n) return undefined
  const numerator =
    needed * debtPrice * 10n ** BigInt(collateralDecimals) * 10000n * (10000n + SEED_MARGIN_BPS)
  const denominator = 10n ** BigInt(debtDecimals) * collateralPrice * slipNum * 10000n
  const seed = ceilDiv(numerator, denominator)
  return seed > 0n ? seed : undefined
}

interface SizeSwapInput {
  /** Total collateral available to the user, in wei. */
  collAmount: bigint
  /** Live debt to repay, in wei. */
  debt: bigint
  /** Debt plus accrual headroom — what the router's GUARANTEED output must clear. */
  needed: bigint
  /** 10000 − slippageBps. */
  slipNum: bigint
  /**
   * Ranked quotes for a given input size, best first; empty when nothing routes. Injected
   * so the sizing algorithm can be exercised without a network, an adapter, or a wallet.
   */
  quoteAt: (amountIn: bigint) => Promise<QuoteResponse[]>
  /**
   * A swap size chosen by the user. When set, the estimate-and-refine loop is skipped
   * entirely — there is nothing to solve for, so this amount is quoted once and checked.
   *
   * Swapping MORE than the debt requires is a deliberate use: the contract repays the flash
   * loan and forwards the surplus debt token to the user, so overriding upwards converts
   * collateral to the debt asset in the same transaction as the close.
   */
  fixedIn?: bigint
  /**
   * A starting guess for the swap size, from a source that costs nothing — the Aave oracle
   * prices already carried on both assets.
   *
   * Without it, the size has to be backed out of a quote for the ENTIRE collateral, which is
   * a second network call on every single refresh. With it, the common case is one call:
   * quote the seed, confirm it clears `needed`, done. The probe is still issued if the seed
   * turns out to be short, so an oracle that disagrees with the route costs a round rather
   * than a wrong answer.
   */
  seedIn?: bigint
  /**
   * The output a quote is sized on. Defaults to the quote's own `amountOut`; a caller holding a
   * measurement passes that instead, so the buy price is what the route really pays, not what
   * it claims.
   */
  outOf?: (quote: QuoteResponse) => bigint
}

interface SizeSwapResult {
  /** Collateral fed to the swap. Always equal to `best.amountIn`. */
  requiredIn: bigint
  best: QuoteResponse
  ranked: QuoteResponse[]
  /** Collateral can repay the debt at all (not underwater). */
  covered: boolean
  expectedOut: bigint
  /** What the router contractually guarantees: expectedOut × (1 − slippage). */
  minDebtOut: bigint
  /** Guaranteed output clears `needed` → the close cannot revert on swap output. */
  guaranteed: boolean
}

/**
 * Work out how much collateral actually has to be swapped to repay the debt.
 *
 * Aggregators quote exact-INPUT only, so the required input cannot be asked for directly. One
 * sample is quoted — the oracle seed where there is one, the whole balance otherwise — and its
 * BUY PRICE (what the route pays per collateral unit at about this size) says exactly how much
 * input clears `needed`. One more quote at that size fetches the calldata. Two round trips at
 * most, in either direction: a sample that falls short grows, one that over-swaps shrinks.
 *
 * Pricing is non-linear, so the re-size carries a small margin and is judged on its own
 * quote, never assumed. A size the price puts beyond the balance drains instead, and
 * `covered` is then read off the full-collateral quote.
 */
export async function sizeSwap({
  collAmount,
  debt,
  needed,
  slipNum,
  quoteAt,
  fixedIn,
  seedIn,
  outOf = (q) => BigInt(q.amountOut),
}: SizeSwapInput): Promise<SizeSwapResult> {
  /** What a router contractually guarantees to deliver for a given quoted output. */
  const guaranteedOut = (quotedOut: bigint) => (quotedOut * slipNum) / 10000n

  /**
   * Assemble the result from whichever quote won.
   *
   * `requiredIn` is taken from the quote's own input rather than from the loop's bookkeeping:
   * the router's calldata encodes that amount and that calldata is what executes, so deriving
   * the size from anywhere else lets the withdrawal and the swap disagree.
   */
  const finalize = (
    best: QuoteResponse,
    ranked: QuoteResponse[],
    covered: boolean,
  ): SizeSwapResult => {
    const quotedIn = BigInt(best.amountIn)
    if (quotedIn === 0n || quotedIn > collAmount) {
      throw new CloseError('pair', 'Swap route returned an unusable input amount')
    }
    const expectedOut = outOf(best)
    const minDebtOut = guaranteedOut(expectedOut)
    return {
      requiredIn: quotedIn,
      best,
      ranked,
      covered,
      expectedOut,
      minDebtOut,
      // Gated on `needed`, not `debt`. The contract flash-loans the debt read on-chain at
      // execution, which is strictly larger than the `debt` read here — a plan guaranteeing
      // only the stale figure can come up short and revert with InsufficientOutput, after
      // both permits have been signed.
      guaranteed: covered && minDebtOut >= needed,
    }
  }

  // A user-chosen size needs no solving: quote it once and report what it buys. The checks
  // that follow are the same ones a solved size faces, so an amount too small to repay the
  // debt is refused here rather than on-chain.
  if (fixedIn !== undefined) {
    if (fixedIn <= 0n) throw new CloseError('pair', 'Enter how much collateral to swap')
    if (fixedIn > collAmount) {
      throw new CloseError('pair', 'That is more collateral than you have supplied')
    }
    const rankedFixed = await quoteAt(fixedIn)
    const bestFixed = rankedFixed[0]
    if (!bestFixed) throw new CloseError('pair', 'No compatible swap route available')
    return finalize(bestFixed, rankedFixed, outOf(bestFixed) >= debt)
  }

  /** The whole balance, quoted: what a drain would return, and whether it covers the debt. */
  const drain = async () => {
    const rankedFull = await quoteAt(collAmount)
    const bestFull = rankedFull[0]
    if (!bestFull) throw new CloseError('pair', 'No compatible swap route available')
    return finalize(bestFull, rankedFull, outOf(bestFull) >= debt)
  }

  // The sample. The oracle seed costs nothing and is usually right; without one the balance
  // is the only size known to be worth quoting, and it doubles as the coverage check.
  const sampleIn = seedIn !== undefined && seedIn > 0n && seedIn < collAmount ? seedIn : collAmount
  const sampled = await quoteAt(sampleIn)
  const sample = sampled[0]
  if (!sample) throw new CloseError('pair', 'No compatible swap route available')
  const sampleOut = outOf(sample)
  if (sampleIn === collAmount && sampleOut < debt) return finalize(sample, sampled, false) // underwater: drain

  // The route's buy price, read as the size at which it would return exactly `targetOut`.
  // Scaling by the ratio treats `out(in)` as a straight line through the origin, which price
  // impact bends — hence the margin on top, and the one verifying quote after.
  const targetOut = ceilDiv(needed * 10000n, slipNum)
  const need = sampleOut > 0n ? ceilDiv(targetOut * BigInt(sample.amountIn), sampleOut) : collAmount
  const sized = need + ceilDiv(need * SEED_MARGIN_BPS, 10000n)
  if (sized >= collAmount) {
    // Needs more than there is — drain instead. The balance sample IS that quote.
    return sampleIn === collAmount ? finalize(sample, sampled, true) : drain()
  }
  const sampleCovers = guaranteedOut(sampleOut) >= needed
  const sampleIsRightSized = BigInt(sample.amountIn) <= need + ceilDiv(need * SEED_TOLERANCE_BPS, 10000n)
  if (sampleCovers && sampleIsRightSized) return finalize(sample, sampled, true)

  // Round two, at the size the price says. A failed re-quote must NOT leave the sample in
  // place: its calldata swaps a different amount than the contract would withdraw, so the
  // router would try to pull more than it was approved for. The balance sample drains instead.
  const ranked = await quoteAt(sized)
  const best = ranked[0]
  if (!best) {
    if (sampleIn === collAmount) return finalize(sample, sampled, true)
    throw new CloseError('pair', 'No compatible swap route available')
  }
  if (guaranteedOut(outOf(best)) >= needed) return finalize(best, ranked, true)
  // Still short after re-sizing on the route's own price: the curve is steeper than the margin
  // covers. Whether the whole balance can do it is the drain quote's answer, and `guaranteed`
  // says no either way.
  return drain()
}
