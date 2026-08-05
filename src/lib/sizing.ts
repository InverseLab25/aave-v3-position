import type { QuoteResponse } from '../adapters/types'
import { CloseError } from './deleverage'

/** Ceiling division for bigints: smallest n such that n * b >= a. */
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/**
 * Extra headroom on the oracle seed (0.3%).
 *
 * Oracle prices are mid-market: they know nothing about the DEX spread or the price impact
 * of this particular size, so a seed derived straight from them tends to come up slightly
 * short and cost a refinement round. Nudging it up trades a little over-swapping for a lot
 * fewer second calls. Kept small — every basis point here is collateral converted that did
 * not need to be.
 */
const SEED_MARGIN_BPS = 30n

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

export interface SizeSwapInput {
  /** Total collateral available to the user, in wei. */
  collAmount: bigint
  /** Live debt to repay, in wei. */
  debt: bigint
  /** Debt plus accrual headroom — what the router's GUARANTEED output must clear. */
  needed: bigint
  /** 10000 − slippageBps. */
  slipNum: bigint
  /** How many verification rounds to spend converging. */
  rounds: number
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
}

export interface SizeSwapResult {
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
 * Aggregators quote exact-INPUT only, so the required input cannot be asked for directly.
 * It is estimated from an observed rate, then VERIFIED against a real quote at that size
 * and refined if it falls short. Pricing is non-linear and the aggregator may pick a
 * different route at a different size, so a single back-out is an estimate, never an answer.
 *
 * The estimate is deliberately conservative: it is derived from the rate for swapping the
 * ENTIRE collateral, i.e. the worst price-impact point, so any smaller trade prices at least
 * that well. In practice the first verification round succeeds and the loop exits; the
 * remaining rounds exist for the case where the aggregator routes differently at the
 * smaller size.
 */
export async function sizeSwap({
  collAmount,
  debt,
  needed,
  slipNum,
  rounds,
  quoteAt,
  fixedIn,
  seedIn,
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
    const expectedOut = BigInt(best.amountOut)
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
    return finalize(bestFixed, rankedFixed, BigInt(bestFixed.amountOut) >= debt)
  }

  // Try the free estimate first. A seed that already clears `needed` answers the whole
  // question in one call — no full-collateral probe, which is the second request every
  // refresh would otherwise pay for.
  if (seedIn !== undefined && seedIn > 0n && seedIn < collAmount) {
    const rankedSeed = await quoteAt(seedIn)
    const bestSeed = rankedSeed[0]
    if (bestSeed && guaranteedOut(BigInt(bestSeed.amountOut)) >= needed) {
      // Clearing `needed` means clearing `debt`, since needed > debt by the accrual buffer.
      return finalize(bestSeed, rankedSeed, true)
    }
    // Seed was short (or unroutable). Fall through to the probe-and-refine path below — the
    // oracle disagreeing with the route costs an extra round, never a wrong size.
  }

  // Quote the full collateral first to gauge price and coverage.
  const rankedFull = await quoteAt(collAmount)
  const bestFull = rankedFull[0]
  if (!bestFull) throw new CloseError('pair', 'No compatible swap route available')
  const fullOut = BigInt(bestFull.amountOut)
  const covered = fullOut >= debt

  let requiredIn =
    covered && fullOut > 0n ? ceilDiv(collAmount * needed * 10000n, fullOut * slipNum) : collAmount
  if (!covered || requiredIn >= collAmount) requiredIn = collAmount

  let best = bestFull
  let ranked = rankedFull
  for (let round = 0; round < rounds && requiredIn !== collAmount; round++) {
    const rankedAt = await quoteAt(requiredIn)
    const quote = rankedAt[0]
    // A failed re-quote must NOT leave the previous quote in place: its calldata swaps a
    // different amount than the contract would withdraw, so the router would try to pull
    // more than it was approved for. Fall back to the full-collateral quote, which drains.
    if (!quote) {
      best = bestFull
      ranked = rankedFull
      break
    }
    best = quote
    ranked = rankedAt

    const quotedOut = BigInt(quote.amountOut)
    if (guaranteedOut(quotedOut) >= needed) break // this size is enough — stop here

    // Short. Scale the input up by the shortfall ratio and re-measure.
    const scaled =
      quotedOut > 0n ? ceilDiv(requiredIn * needed * 10000n, quotedOut * slipNum) : collAmount
    // Needs more than there is — drain instead.
    if (scaled >= collAmount) {
      best = bestFull
      ranked = rankedFull
      break
    }
    if (scaled <= requiredIn) break // not converging — accept and let `guaranteed` decide
    requiredIn = scaled
  }

  return finalize(best, ranked, covered)
}
