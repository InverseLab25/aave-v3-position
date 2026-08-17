/**
 * Recovering this wallet's leveraged positions from a list of transaction hashes.
 *
 * This replaced a log scanner that walked the chain from the contract's deployment block, halving
 * its window until a provider accepted it. That worked, but on Base it meant about forty
 * `eth_getLogs` windows to find three transactions, every one capped by whatever range limit the
 * provider happened to enforce, and repeated in full on every load.
 *
 * Aave's indexer already knows every transaction this wallet made against the pool, and hands back
 * a `txHash` for each. A leveraged open IS a supply and a borrow, so the indexer has seen them all.
 * Reading those receipts directly is a point lookup per hash — no range, no cap, and no window to
 * tune. For a real Base account that is one GraphQL query and eight receipts, and the eight become
 * zero on the next load because `screenCache` remembers what each one turned out to be.
 *
 * What it gives up is pruning. A scan could say "I examined blocks X to Y and this row was not in
 * them", which is how `mergeHistory` detects a reorg. Walking hashes examines no range at all, so
 * it passes none, and nothing is ever deleted on the strength of it. A row orphaned by a reorg
 * therefore lingers until the user presses Resync, which is the trade this path makes.
 */
import type { Address, Hex } from 'viem'
import type { DelegationStorage } from './delegationCache'
import { positionEventFromReceipt, type ScreenedReceipt } from './receiptScreen'
import { recordScreened, unscreened, type Screened } from './screenCache'
import { entriesFromReceipts, RECEIPT_CONCURRENCY, type BackfillContext } from './txBackfill'
import { mergeHistory } from './txHistory'
import type { TokenMeta } from './tokenMeta'

export interface HashSyncClient {
  getTransactionReceipt(args: { hash: Hex }): Promise<ScreenedReceipt>
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>
}

export interface HashSyncInput {
  client: HashSyncClient
  storage: DelegationStorage | null
  /** The AaveV3Strategies deployment whose events mark a transaction as ours. */
  strategies: Address
  wallet: Address
  chainId: number
  /** Every hash the indexer reported for this wallet. Duplicates and repeats are expected. */
  hashes: readonly Hex[]
  tokens: Record<string, TokenMeta>
  hidden: readonly Address[]
}

export interface HashSyncResult {
  /** Receipts actually fetched — zero once the cache is warm. */
  examined: number
  /** Of those, how many turned out to be leveraged positions. */
  found: number
}

/**
 * Concurrency for the receipt reads, shared with the backfill's own pool.
 *
 * Same reasoning as there: a wallet with a long history would otherwise open one request per
 * hash at once, which is what rate limiting exists to stop.
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Reads the receipts not seen before, files the ones that were ours, and remembers the rest.
 *
 * THROWS rather than salvaging a partial result, matching `syncChain`. Nothing is written unless
 * every receipt in this round came back — a verdict recorded from a half-finished round would
 * suppress the retry that would have completed it.
 */
export async function syncChainFromHashes({
  client,
  storage,
  strategies,
  wallet,
  chainId,
  hashes,
  tokens,
  hidden,
}: HashSyncInput): Promise<HashSyncResult> {
  const scope = { wallet, chainId }
  // De-duplicated and filtered against the cache in one step: one open shows up in the indexer as
  // a supply, a borrow and a second supply, all under the same hash.
  const todo = unscreened(storage, scope, hashes)
  if (todo.length === 0) return { examined: 0, found: 0 }

  const receipts = await mapWithLimit(todo, RECEIPT_CONCURRENCY, (hash) =>
    client.getTransactionReceipt({ hash }),
  )

  const verdicts: Screened[] = []
  const found: { event: NonNullable<ReturnType<typeof positionEventFromReceipt>>; receipt: ScreenedReceipt }[] = []

  for (const [i, receipt] of receipts.entries()) {
    const event = receipt ? positionEventFromReceipt(receipt, strategies) : null
    verdicts.push({ hash: todo[i], verdict: event ? 'strategies' : 'other' })
    if (event && receipt) found.push({ event, receipt })
  }

  const context: BackfillContext = { wallet, chainId, tokens, hidden }
  const entries = await entriesFromReceipts(client, found, context)

  // No range. See the note at the top of this file: walking hashes proves nothing about the
  // blocks between them, so it must never be read as authority to delete.
  mergeHistory(storage, { wallet, chainId, entries, range: null })

  // Only after the writes above, so a throw anywhere leaves the round to be retried whole.
  recordScreened(storage, scope, verdicts)

  return { examined: todo.length, found: entries.length }
}
