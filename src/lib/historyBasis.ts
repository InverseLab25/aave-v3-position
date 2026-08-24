/**
 * What a leveraged position actually cost, read back from its own fills.
 *
 * The average entry price shown against a position comes from Aave's indexer, which prices each
 * supply at the oracle price of its block. For a position opened through AaveV3Strategies that is
 * not what the user paid: the asset was traded, through a router, at whatever the book gave — and
 * that number is in the `Swapped` event, which the history sync already records whole.
 *
 * Counted in the token on the OTHER side of the fill, never converted to USD. The rate a router
 * filled at is a fact about two tokens; turning it into dollars needs a price for one of them, and
 * the only price to hand is today's, which has no business pricing a trade from last week.
 */
import { formatUnits, type Address } from 'viem'
import { quoteRate } from './deleverage'
import type { TxHistoryEntry } from './txHistory'

/** Which leg of the position is being priced. */
export type PositionSide = 'supply' | 'borrow'

export interface HistoryBasis {
  /** Quote tokens per 1 unit of the asset — what a unit cost, or what it was sold for. */
  perUnit: number
  /** The token `perUnit` is denominated in: the debt for a long, the collateral for a short. */
  quoteToken: Address
}

/**
 * Oldest first.
 *
 * `loadHistory` hands back newest-first, which is right for a list and wrong for a ledger: a
 * replay that met the close before the opens it settles would find nothing to close and reset
 * nothing. Sorted here rather than demanded of the caller, because the caller has no reason to
 * know this function replays anything.
 */
function chronological(entries: readonly TxHistoryEntry[]): TxHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at
    if (a.blockNumber !== b.blockNumber) {
      if (a.blockNumber === null) return -1
      if (b.blockNumber === null) return 1
      return a.blockNumber > b.blockNumber ? 1 : -1
    }
    return a.hash.toLowerCase() < b.hash.toLowerCase() ? -1 : 1
  })
}

/**
 * Weighted-average price of the `asset` still held or still owed, replayed from this wallet's fills.
 *
 * Both the price and the quantity come from the `Swapped` events alone — never from Aave's
 * reported amounts. The rate a router filled at IS what a unit cost; the amounts on either side of
 * it are what says how much weight that cost carries.
 *
 * The two sides are the same fill read in opposite directions, because a leveraged open borrows
 * one asset and buys the other with it:
 *
 *  - `supply` — the asset was BOUGHT, so it is the swap's destination. Quantity is what came back,
 *    cost is what was spent, and the quote token is the debt. This is a long.
 *  - `borrow` — the asset was SOLD to fund the collateral, so it is the swap's source. Quantity is
 *    the debt taken on, cost is the collateral received, and the quote token is that collateral.
 *    This is a short, and reading the other leg would answer "WETH per USDT", which tells a
 *    shorter nothing about where they got in.
 *
 * Closes participate, mirrored the same way: a long sells its collateral, a short buys its debt
 * back. One rule covers both shapes of close rather than a threshold deciding between them:
 *
 *  - A PARTIAL close scales cost and units by the same remaining share, so the average it leaves
 *    behind is the average it found. Selling 5 of 10 bought at 1,800 leaves 5 that cost 1,800.
 *  - A FULL close drives units to zero, taking the cost with it, so the next open starts from
 *    nothing. This is what stops a position exited months ago from pricing one opened yesterday.
 *
 * Flooring at zero is what makes the full case robust: a position accrues interest, so an exit
 * moves MORE than the fills ever opened, and the overshoot has to read as "closed" rather than as
 * a negative holding. No dust threshold is needed for the residue of a near-full close either —
 * a leftover of 1e-15 units carries 1e-15 of the weight, and the next open drowns it.
 *
 * Returns null when nothing is held, and also when the fills were quoted in MORE THAN ONE token:
 * costs in USDT and costs in WBTC cannot be added, and reconciling them needs exactly the price
 * conversion this function exists to avoid. Null rather than zero throughout — zero is a price,
 * and the caller's precedence chain reads it as one.
 */
export function avgEntryFromHistory(
  entries: readonly TxHistoryEntry[],
  asset: Address,
  side: PositionSide,
  opts: {
    /**
     * This wallet-and-chain has lost rows to the FIFO cap, so `entries` may be a fraction of the
     * fills that built the position. See the note above the return.
     */
    truncated?: boolean
  } = {},
): HistoryBasis | null {
  const wanted = asset.toLowerCase()
  let totalUnits = 0
  let totalCostIn = 0
  let quoteToken: Address | null = null
  /**
   * The replay saw this position go to zero and start again, so whatever came before is
   * irrelevant to the tally that is left. This is what makes a truncated store still usable:
   * every full exit is a point the history heals at.
   */
  let resetObserved = false

  for (const entry of chronological(entries)) {
    const { swap } = entry
    if (!swap) continue

    // A long holds the destination leg of its open and gives it back on close; a short owes the
    // source leg and buys it back. So the leg carrying `asset` flips with BOTH side and kind.
    const heldOnSource = side === 'borrow'
    const onSource = entry.kind === 'open' ? heldOnSource : !heldOnSource

    const assetToken = onSource ? swap.srcToken : swap.dstToken
    if (assetToken.toLowerCase() !== wanted) continue

    const assetDecimals = onSource ? swap.srcDecimals : swap.dstDecimals
    const assetAmount = onSource ? swap.spentAmount : swap.returnAmount
    if (assetDecimals === null) continue

    if (entry.kind === 'close') {
      // No quote-token check: units left the position whatever they were traded against, and a
      // close only ever moves the quantity.
      if (totalUnits <= 0) continue
      const settled = Number(formatUnits(assetAmount, assetDecimals))
      if (!(settled > 0)) continue

      const remaining = Math.max(0, totalUnits - settled)
      // Scaling both by the same share is exactly what leaves the average untouched.
      totalCostIn *= remaining / totalUnits
      totalUnits = remaining
      if (remaining === 0) resetObserved = true
      continue
    }

    const quote = onSource ? swap.dstToken : swap.srcToken
    const quoteDecimals = onSource ? swap.dstDecimals : swap.srcDecimals
    if (quoteDecimals === null) continue

    // Two tallies in different units are not a tally. Bail rather than pick a winner.
    if (quoteToken !== null && quoteToken.toLowerCase() !== quote.toLowerCase()) return null

    // Quote tokens per 1 unit of the asset — the fill, in the direction that prices the asset.
    const rate = quoteRate(
      onSource ? swap.returnAmount : swap.spentAmount,
      assetAmount,
      assetDecimals,
      quoteDecimals,
    )
    if (rate === null) continue

    const units = Number(formatUnits(assetAmount, assetDecimals))
    if (!(units > 0)) continue

    quoteToken = quote
    totalUnits += units
    totalCostIn += units * Number(rate)
  }

  if (!(totalUnits > 0) || quoteToken === null) return null
  /**
   * A tally built on rows that may be missing their earliest fills is the one answer worse than
   * no answer: it is a plausible number, it BEATS the indexer in `resolveEntryPrice`, and the
   * caller multiplies it by the full held balance rather than by the units these rows account
   * for. So it refuses, and the row falls through to the indexer's oracle-priced figure.
   *
   * Unless a full exit was replayed, which proves the position was zero at a point inside the
   * surviving rows — everything after that is complete whatever the cap threw away.
   *
   * Deliberately conservative: the evicted rows might have been for a different asset entirely,
   * and this refuses anyway. Being absent where it could have been right costs a labelled
   * fallback; being wrong where it looks right costs nothing that shows.
   */
  if (opts.truncated && !resetObserved) return null
  return { perUnit: totalCostIn / totalUnits, quoteToken }
}
