/**
 * What each leveraged transaction actually traded at, keyed by the hash it happened in.
 *
 * Aave's indexer reports a leveraged open as an ordinary supply and borrow, priced at the block's
 * oracle read. That is the right price for tokens the user walked in with, and the wrong one for
 * tokens a router bought — those cost whatever the book gave, which is in the `Swapped` event the
 * history sync already records whole.
 *
 * So this hands the cost-basis replay the one thing the indexer cannot know: which units in a
 * transaction went through a swap, and at what rate. Everything else about the ledger — the
 * ordering, the withdrawals, the liquidations, the exits — the indexer already has, and this
 * deliberately does not duplicate any of it.
 *
 * BOTH legs of every fill, because a leveraged open acquires one asset and takes on the other as
 * debt, and the two positions are priced against opposite sides of the same trade.
 */
import { formatUnits } from 'viem'
import type { TxHistoryEntry } from './txHistory'

/** One side of a fill: units of an asset that moved, and what they cost in the other token. */
export interface SwapFill {
  /** Units of the asset this leg acquired or gave up. */
  units: number
  /** The other token, LOWER-CASED. `perUnit` is denominated in it. */
  quote: string
  /** `quote` tokens per unit of the asset. */
  perUnit: number
}

/** Both legs of every fill: lower-cased tx hash, then lower-cased asset address. */
export type SwapFills = Record<string, Record<string, SwapFill>>

/**
 * The fills in these rows, indexed for lookup by hash.
 *
 * Open and close alike. An open prices what was bought; a close prices what it was sold for, and
 * the replay realizes P&L against that exit the same way it does against a withdrawal.
 *
 * A row missing either side's decimals is skipped rather than guessed at: 18 is the plausible
 * guess and it is wrong for every stablecoin, which would report a fill off by twelve orders of
 * magnitude. Falling through leaves the lot at the oracle price, which is merely imprecise.
 */
export function swapFills(entries: readonly TxHistoryEntry[]): SwapFills {
  const byHash: SwapFills = {}

  for (const entry of entries) {
    const { swap } = entry
    if (!swap) continue
    if (swap.srcDecimals === null || swap.dstDecimals === null) continue

    const spent = Number(formatUnits(swap.spentAmount, swap.srcDecimals))
    const returned = Number(formatUnits(swap.returnAmount, swap.dstDecimals))
    if (!(spent > 0) || !(returned > 0)) continue

    const src = swap.srcToken.toLowerCase()
    const dst = swap.dstToken.toLowerCase()

    byHash[entry.hash.toLowerCase()] = {
      // What the swap bought, priced in what paid for it.
      [dst]: { units: returned, quote: src, perUnit: spent / returned },
      // What the swap sold, priced in what it fetched.
      [src]: { units: spent, quote: dst, perUnit: returned / spent },
    }
  }

  return byHash
}
