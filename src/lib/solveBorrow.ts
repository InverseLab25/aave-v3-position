import type { QuoteResponse } from '../adapters/types'
import { BPS, ceilDiv } from './strategies-sdk/sizing'

/**
 * Headroom over what a price says is needed (0.3%), on the oracle seed and on the re-size alike.
 *
 * A price is only exact at the size it was measured at: a larger swap pays more impact, and the
 * oracle knows nothing about the DEX spread at all. Nudging the size up trades a little
 * over-borrowing for a quote that clears the flash first time. Kept small: every basis point
 * here is debt the user did not need to take on, though the surplus collateral it buys is
 * supplied to them rather than lost.
 */
const SEED_MARGIN_BPS = 30n

/**
 * How far over the buy-price size the seed may land and still be taken as it is (twice the margin).
 *
 * The seed is worth keeping when the oracle was right: it is the figure the form showed while
 * the user typed, so accepting it means the number firms up rather than jumping. Past this the
 * oracle overstated the route, and re-sizing saves the user real debt.
 */
const SEED_TOLERANCE_BPS = 2n * SEED_MARGIN_BPS

export interface SolveBorrowInput {
  /** Collateral the swap must produce, in collateral wei — the flash loan being repaid. */
  flashAmount: bigint
  /** Margin posted in the DEBT asset, which joins the borrow inside the same swap. Zero on the
   *  collateral-margin and ratchet paths. */
  debtMargin: bigint
  /** 10000 − slippageBps. What the router's GUARANTEED output must clear. */
  slipNum: bigint
  /** Aave oracle prices, any shared fixed-point scale — it cancels in the ratio. */
  collateralPriceUsd: bigint
  debtPriceUsd: bigint
  collateralDecimals: number
  debtDecimals: number
  /** Ranked quotes for a given DEBT-asset input, best first; empty when nothing routes. */
  quoteAt: (amountIn: bigint) => Promise<QuoteResponse[]>
  /**
   * The output a quote is sized on. Defaults to the quote's own `amountOut`; a caller holding a
   * measurement passes that instead, so the buy price is what the route really pays, not what
   * it claims.
   */
  outOf?: (quote: QuoteResponse) => bigint
}

type SolveBorrowError = 'ZERO_FLASH' | 'ZERO_RATE' | 'NO_ROUTE' | 'NOT_CONVERGING'

/** What `seedBorrow` needs — the oracle half of `SolveBorrowInput`, without the router. */
type SeedBorrowInput = Pick<
  SolveBorrowInput,
  | 'flashAmount' | 'debtMargin' | 'slipNum'
  | 'collateralPriceUsd' | 'debtPriceUsd' | 'collateralDecimals' | 'debtDecimals'
>

/** The rate half alone, for callers that hold the prices but derive the amounts themselves. */
export type SeedBorrowPricing = Omit<SeedBorrowInput, 'flashAmount' | 'debtMargin'>

/**
 * The borrow implied by oracle prices alone, before any router is asked.
 *
 * Costs no network call, so the form can show what will be borrowed the moment the amounts
 * parse rather than leaving a dash until a quote settles. `solveBorrow` starts from this same
 * figure and then verifies it, so the number the user reads while typing is the one the solve
 * begins from — it moves when the route disagrees with the oracle, not arbitrarily.
 *
 * Returns null when the inputs cannot imply a rate, or when the debt-asset margin already
 * covers the whole swap and there is nothing left to borrow.
 */
export function seedBorrow(p: SeedBorrowInput): bigint | null {
  if (p.flashAmount <= 0n) return null
  if (p.slipNum <= 0n || p.collateralPriceUsd <= 0n || p.debtPriceUsd <= 0n) return null

  const swapIn = ceilDiv(
    p.flashAmount * p.collateralPriceUsd * 10n ** BigInt(p.debtDecimals) * BPS * (BPS + SEED_MARGIN_BPS),
    10n ** BigInt(p.collateralDecimals) * p.debtPriceUsd * p.slipNum * BPS,
  )
  const borrow = swapIn - p.debtMargin
  return borrow > 0n ? borrow : null
}

interface SolveBorrowResult {
  /** What to borrow from Aave. Always `best.amountIn` minus the debt-asset margin. */
  borrowAmount: bigint
  /** The full swap input the router was quoted for: `borrowAmount + debtMargin`. */
  swapIn: bigint
  best: QuoteResponse
  ranked: QuoteResponse[]
  expectedOut: bigint
  /** What the router contractually guarantees: expectedOut × (1 − slippage). */
  minCollateralOut: bigint
}

type SolveBorrowOutcome =
  | { ok: true; solved: SolveBorrowResult }
  | { ok: false; error: SolveBorrowError }

/**
 * Work out how much debt has to be borrowed for the swap to repay the flash loan.
 *
 * Aggregators quote exact-INPUT only, so the required input cannot be asked for directly. It
 * is seeded from oracle prices and quoted once; that quote's BUY PRICE (what the route pays
 * per debt unit at about this size) then says exactly how much input repays the flash, and one
 * more quote at that size fetches the calldata. Two round trips at most, in either direction:
 * a route worse than the oracle borrows more, a route better than it borrows less.
 *
 * Solving for the borrow rather than asking the user for it is what makes an under-covered
 * flash structurally impossible: the amount is derived FROM the repayment obligation, so there
 * is no combination of typed numbers that can come up short. `AaveV3Strategies.sol:502` reverts
 * when the swap cannot repay the flash, and nothing that reaches here can trip it.
 *
 * The margin posted in the debt asset is inside the swap (`AaveV3Strategies.sol:491` swaps
 * `borrowAmount + marginAmount`), so it is quoted as part of the input and subtracted back out
 * of the answer — the user is not asked to borrow what they already brought.
 */
export async function solveBorrow(p: SolveBorrowInput): Promise<SolveBorrowOutcome> {
  if (p.flashAmount <= 0n) return { ok: false, error: 'ZERO_FLASH' }
  if (p.slipNum <= 0n || p.collateralPriceUsd <= 0n || p.debtPriceUsd <= 0n) {
    return { ok: false, error: 'ZERO_RATE' }
  }

  /** What a router contractually guarantees to deliver for a given quoted output. */
  const guaranteedOut = (quotedOut: bigint) => (quotedOut * p.slipNum) / BPS

  // Seed from the oracle — the same figure the form shows while the user types, so the number
  // they read is the one this solve starts from.
  const seededBorrow = seedBorrow(p)
  // The flash and both prices were validated above, so the only remaining reason the seed can
  // come back empty is a debt-asset margin that already covers the whole swap — leaving nothing
  // to borrow, which the contract rejects with ZeroAmount.
  if (seededBorrow === null) return { ok: false, error: 'NOT_CONVERGING' }

  const outOf = p.outOf ?? ((q: QuoteResponse) => BigInt(q.amountOut))
  /** Output the swap has to reach for its guarantee to repay the flash. */
  const targetOut = ceilDiv(p.flashAmount * BPS, p.slipNum)

  // Round one: the oracle's guess, quoted for real.
  let ranked = await p.quoteAt(seededBorrow + p.debtMargin)
  let best = ranked[0]
  if (!best) return { ok: false, error: 'NO_ROUTE' }
  const seedIn = BigInt(best.amountIn)
  const seedOut = outOf(best)
  if (seedOut <= 0n) return { ok: false, error: 'NOT_CONVERGING' }

  // The route's buy price, read as the size at which it would return exactly `targetOut`.
  // Scaling by the ratio treats `out(in)` as a straight line through the origin, which price
  // impact bends — hence the margin on top, and the one verifying quote after.
  const need = ceilDiv(targetOut * seedIn, seedOut)
  const sized = need + ceilDiv(need * SEED_MARGIN_BPS, BPS)
  const seedCovers = guaranteedOut(seedOut) >= p.flashAmount
  const seedIsRightSized = seedIn <= need + ceilDiv(need * SEED_TOLERANCE_BPS, BPS)

  if (!(seedCovers && seedIsRightSized)) {
    // Round two, at the size the price says. A failed re-quote must not leave the seed's quote
    // in place: its calldata swaps a different amount than the contract would borrow.
    ranked = await p.quoteAt(sized)
    best = ranked[0]
    if (!best) return { ok: false, error: 'NO_ROUTE' }
    // Still short after re-sizing on the route's own price: the curve is steeper than a margin
    // covers, and a third guess would be a guess. Ask the user for a smaller position instead.
    if (guaranteedOut(outOf(best)) < p.flashAmount) return { ok: false, error: 'NOT_CONVERGING' }
  }

  // Read the size back off the winning quote rather than the arithmetic: the router's calldata
  // encodes that amount and that calldata is what executes, so deriving it from anywhere else
  // lets the borrow and the swap disagree.
  const quotedIn = BigInt(best.amountIn)
  const expectedOut = outOf(best)
  if (quotedIn <= p.debtMargin) {
    // The margin alone covers the whole swap, so there is nothing to borrow. The contract
    // reverts ZeroAmount on a zero borrow, so refuse rather than clamp.
    return { ok: false, error: 'NOT_CONVERGING' }
  }

  return {
    ok: true,
    solved: {
      borrowAmount: quotedIn - p.debtMargin,
      swapIn: quotedIn,
      best,
      ranked,
      expectedOut,
      minCollateralOut: guaranteedOut(expectedOut),
    },
  }
}
