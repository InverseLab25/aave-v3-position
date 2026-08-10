import type { QuoteResponse } from '../adapters/types'

/** Smallest n such that n * b >= a. */
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

/** Basis-point scale: 10000n == 1.0. */
const BPS = 10_000n

/**
 * Extra headroom on the oracle seed (0.3%).
 *
 * Oracle prices are mid-market and know nothing about the DEX spread or this size's price
 * impact, so a seed taken straight from them tends to land short and cost a refinement round.
 * Nudging it up trades a little over-borrowing for a lot fewer second calls. Kept small: every
 * basis point here is debt the user did not need to take on.
 */
const SEED_MARGIN_BPS = 30n

export interface SolveBorrowInput {
  /** Collateral the swap must produce, in collateral wei — the flash loan being repaid. */
  flashAmount: bigint
  /** Margin posted in the DEBT asset, which joins the borrow inside the same swap. Zero on the
   *  collateral-margin and ratchet paths. */
  debtMargin: bigint
  /** 10000 − slippageBps. What the router's GUARANTEED output must clear. */
  slipNum: bigint
  /** How many verification rounds to spend converging. */
  rounds: number
  /** Aave oracle prices, any shared fixed-point scale — it cancels in the ratio. */
  collateralPriceUsd: bigint
  debtPriceUsd: bigint
  collateralDecimals: number
  debtDecimals: number
  /** Ranked quotes for a given DEBT-asset input, best first; empty when nothing routes. */
  quoteAt: (amountIn: bigint) => Promise<QuoteResponse[]>
}

export type SolveBorrowError = 'ZERO_FLASH' | 'ZERO_RATE' | 'NO_ROUTE' | 'NOT_CONVERGING'

export interface SolveBorrowResult {
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

export type SolveBorrowOutcome =
  | { ok: true; solved: SolveBorrowResult }
  | { ok: false; error: SolveBorrowError }

/**
 * Work out how much debt has to be borrowed for the swap to repay the flash loan.
 *
 * This is the open flow's mirror of `sizeSwap`: aggregators quote exact-INPUT only, so the
 * required input cannot be asked for directly. It is seeded from oracle prices, VERIFIED
 * against a real quote at that size, and scaled up if the guaranteed output falls short.
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

  // Seed: the debt whose value covers `flashAmount` of collateral at oracle mid-market, plus
  // slippage and a little headroom. Costs no network call.
  const seed = ceilDiv(
    p.flashAmount * p.collateralPriceUsd * 10n ** BigInt(p.debtDecimals) * BPS * (BPS + SEED_MARGIN_BPS),
    10n ** BigInt(p.collateralDecimals) * p.debtPriceUsd * p.slipNum * BPS,
  )
  if (seed <= 0n) return { ok: false, error: 'ZERO_RATE' }

  let swapIn = seed
  let best: QuoteResponse | null = null
  let ranked: QuoteResponse[] = []

  for (let round = 0; round <= p.rounds; round++) {
    const rankedAt = await p.quoteAt(swapIn)
    const quote = rankedAt[0]
    // A failed re-quote must not leave the previous one in place: its calldata swaps a
    // different amount than the contract would borrow, so the two would disagree.
    if (!quote) return { ok: false, error: 'NO_ROUTE' }

    best = quote
    ranked = rankedAt

    const quotedOut = BigInt(quote.amountOut)
    if (guaranteedOut(quotedOut) >= p.flashAmount) break // this size repays the flash — done

    // Short. Scale the input up by the shortfall ratio and re-measure. Pricing is non-linear
    // and the aggregator may route differently at a different size, so one back-out is an
    // estimate rather than an answer.
    const scaled =
      quotedOut > 0n ? ceilDiv(swapIn * p.flashAmount * BPS, quotedOut * p.slipNum) : 0n
    if (scaled <= swapIn) return { ok: false, error: 'NOT_CONVERGING' }
    if (round === p.rounds) return { ok: false, error: 'NOT_CONVERGING' }
    swapIn = scaled
  }

  if (!best) return { ok: false, error: 'NO_ROUTE' }

  // Read the size back off the winning quote rather than the loop's bookkeeping: the router's
  // calldata encodes that amount and that calldata is what executes, so deriving it from
  // anywhere else lets the borrow and the swap disagree.
  const quotedIn = BigInt(best.amountIn)
  const expectedOut = BigInt(best.amountOut)
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
