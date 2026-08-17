/**
 * What a leveraged position actually cost, read back from its own fills.
 *
 * The average entry price shown against a position comes from Aave's indexer, which prices each
 * supply at the oracle price of its block. For a position opened through AaveV3Strategies that is
 * not what the user paid: the collateral was BOUGHT, through a router, at whatever the book gave
 * — and that number is in the `Swapped` event, which the history sync already records whole.
 *
 * So the basis is recomputed here from the fills. The alternative was the manual override the
 * position table still offers, which asks a user to type in a price they would have to go and
 * work out from an explorer.
 */
import { formatUnits, type Address } from 'viem'
import { quoteRate } from './deleverage'
import { isVolatilePrice } from '../utils/liquidation'
import type { TxHistoryEntry } from './txHistory'

/** Current USD price of a token, or undefined when nothing on screen knows it. */
export type PriceLookup = (token: Address) => number | undefined

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
 * Weighted-average USD price paid for the `collateral` still held, replayed from this wallet's fills.
 *
 * Both the price and the quantity come from the `Swapped` events alone — never from Aave's
 * reported amounts. The rate a router filled at IS what a unit cost; the amounts on either side
 * of it are what says how much weight that cost carries.
 *
 * Weighted rather than averaged flat, matching `addEntry` in `useAaveHistoricalInterest`: ten
 * units at 1,800 and one at 2,000 is a basis of 1,818, not 1,900.
 *
 * Closes participate, and the arithmetic makes the two cases fall out of one rule rather than a
 * threshold deciding between them:
 *
 *  - A PARTIAL close scales cost and units by the same remaining share, so the average it leaves
 *    behind is the average it found. Selling 5 of 10 bought at 1,800 leaves 5 that cost 1,800.
 *  - A FULL close drives units to zero, taking the cost with it, so the next open starts from
 *    nothing. This is what stops a position exited months ago from pricing one opened yesterday.
 *
 * Flooring at zero is what makes the full case robust: collateral accrues interest, so an exit
 * sells MORE than the fills ever bought, and the overshoot has to read as "closed" rather than as
 * a negative holding. No dust threshold is needed for the residue of a near-full close either —
 * a leftover of 1e-15 units carries 1e-15 of the weight, and the next open drowns it.
 *
 * Returns null rather than zero when nothing is held. Zero is a price, and the caller's
 * precedence chain reads it as one.
 */
export function avgEntryFromHistory(
  entries: readonly TxHistoryEntry[],
  collateral: Address,
  priceUsdOf: PriceLookup,
): number | null {
  const wanted = collateral.toLowerCase()
  let totalUnits = 0
  let totalCostUsd = 0

  for (const entry of chronological(entries)) {
    const { swap } = entry
    if (!swap) continue

    if (entry.kind === 'close') {
      // The collateral is the leg being SOLD, so it is the source. No price gate: units left the
      // position whatever they were sold for, and a close only ever moves the quantity.
      if (swap.srcToken.toLowerCase() !== wanted) continue
      if (swap.srcDecimals === null) continue
      if (totalUnits <= 0) continue

      const sold = Number(formatUnits(swap.spentAmount, swap.srcDecimals))
      if (!(sold > 0)) continue

      const remaining = Math.max(0, totalUnits - sold)
      // Scaling both by the same share is exactly what leaves the average untouched.
      totalCostUsd *= remaining / totalUnits
      totalUnits = remaining
      continue
    }

    if (swap.dstToken.toLowerCase() !== wanted) continue
    // Two unscaled integers have no ratio between them until both sides name their decimals.
    if (swap.srcDecimals === null || swap.dstDecimals === null) continue

    // The debt token the collateral was bought with has to be worth something knowable in dollars.
    // Classified on price rather than by symbol, following `isVolatilePrice`: an allowlist rots on
    // every new listing, and a depegged stable is exactly the case that must NOT pass here.
    const debtPriceUsd = priceUsdOf(swap.srcToken)
    if (debtPriceUsd === undefined || debtPriceUsd <= 0) continue
    if (isVolatilePrice(debtPriceUsd)) continue

    // Debt tokens per 1 collateral token — the fill, in the direction that prices the collateral.
    const rate = quoteRate(swap.spentAmount, swap.returnAmount, swap.dstDecimals, swap.srcDecimals)
    if (rate === null) continue

    const units = Number(formatUnits(swap.returnAmount, swap.dstDecimals))
    if (!(units > 0)) continue

    totalUnits += units
    totalCostUsd += units * Number(rate) * debtPriceUsd
  }

  return totalUnits > 0 ? totalCostUsd / totalUnits : null
}
