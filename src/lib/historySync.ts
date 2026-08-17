/**
 * One chain's history, brought up to date from the chain itself.
 *
 * Ties the three pieces together in the one order that is safe: scan, build, merge, and only then
 * advance the cursor. Every step throws rather than degrading, so a failure anywhere leaves both
 * the stored history and the cursor exactly as they were and the next trigger simply tries again.
 *
 * That ordering is what makes the prune in `mergeHistory` safe to arm. It is only ever handed a
 * range that a scan covered in full.
 */
import type { Address } from 'viem'
import { scanPositionEvents, type LogScanClient } from './strategiesLogs'
import { entriesFromEvents, type ReceiptClient } from './txBackfill'
import { mergeHistory, type ScannedRange } from './txHistory'
import { loadCursor, saveCursor } from './syncCursor'
import type { DelegationStorage } from './delegationCache'
import type { TokenMeta } from './tokenMeta'

/**
 * How far behind the head the cursor is parked.
 *
 * The last blocks of a chain are the least settled, and a cursor sitting on the head means a
 * transaction that reorgs out one block later is never looked at again. Holding back re-scans that
 * window on every sync, which is also what puts it inside the pruning range — so a dropped
 * transaction is noticed and removed rather than lingering as a swap that never happened.
 *
 * Fifty blocks: about a hundred seconds on Base, a dozen on Arbitrum, and a handful of blocks of
 * re-scanning per sync either way.
 */
export const REORG_WINDOW = 50n

export interface ChainSyncClient extends LogScanClient, ReceiptClient {
  getBlockNumber(): Promise<bigint>
}

export interface SyncChainInput {
  client: ChainSyncClient
  storage: DelegationStorage | null
  /** The Strategies contract on this chain. */
  address: Address
  wallet: Address
  chainId: number
  /** The block it was deployed in — as far back as a scan can meaningfully go. */
  fromBlock: bigint
  tokens: Record<string, TokenMeta>
  hidden: readonly Address[]
  onProgress?: (block: bigint) => void
}

export interface SyncChainResult {
  /** The range covered, or null when the cursor was already at the head. */
  scanned: ScannedRange | null
  found: number
}

/**
 * Reads this chain forward from wherever the last scan stopped, and files what it finds.
 *
 * Throws on any failure. The caller's job is to report it and try again later — never to salvage
 * a partial result, which `mergeHistory` would read as authority to delete.
 */
export async function syncChain({
  client,
  storage,
  address,
  wallet,
  chainId,
  fromBlock,
  tokens,
  hidden,
  onProgress,
}: SyncChainInput): Promise<SyncChainResult> {
  const head = await client.getBlockNumber()
  const cursor = loadCursor(storage, { chainId, wallet })

  // Never before the deployment: a cursor from another deployment, or a corrupted one, must not
  // send the scan walking blocks that could not contain this contract.
  const resume = cursor === null ? fromBlock : cursor + 1n
  const from = resume < fromBlock ? fromBlock : resume

  if (from > head) return { scanned: null, found: 0 }

  const events = await scanPositionEvents(client, {
    address,
    wallet,
    fromBlock: from,
    toBlock: head,
    onProgress,
  })

  const entries = await entriesFromEvents(client, events, { wallet, chainId, tokens, hidden })

  // Reached only if BOTH of the above completed, which is what `range` being non-null asserts.
  mergeHistory(storage, { wallet, chainId, entries, range: { from, to: head } })

  // Deliberately behind the head. See REORG_WINDOW.
  const settled = head > REORG_WINDOW ? head - REORG_WINDOW : 0n
  saveCursor(storage, { chainId, wallet }, settled)

  return { scanned: { from, to: head }, found: entries.length }
}
