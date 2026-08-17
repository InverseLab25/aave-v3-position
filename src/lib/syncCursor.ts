/**
 * How far the chain has already been read, per wallet and chain.
 *
 * Without this, every load re-scans from the Strategies deployment — on Arbitrum that is millions
 * of blocks of `eth_getLogs` to rediscover transactions already sitting in storage. With it, the
 * second load asks about the blocks produced since the first one.
 *
 * Storage is injected rather than reached for, following `delegationCache` and `txHistory`: the
 * browser's `localStorage` can be absent or throw outright, and a lost cursor costs one re-scan.
 */
import type { Address } from 'viem'
import type { DelegationStorage } from './delegationCache'

export const SYNC_CURSOR_KEY = 'defi-route.txsync.v1'

export interface CursorScope {
  chainId: number
  wallet: Address
}

/** Lower-cased, so a wallet reconnecting in checksummed form finds its own cursor. */
const scopeKey = (scope: CursorScope) => `${scope.chainId}:${scope.wallet.toLowerCase()}`

type CursorMap = Record<string, string>

function readAll(storage: DelegationStorage | null): CursorMap {
  if (!storage) return {}
  try {
    const raw = storage.getItem(SYNC_CURSOR_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    // An array parses as an object, so the shape is checked rather than assumed.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as CursorMap
  } catch {
    return {}
  }
}

/** The last block scanned for this scope, or null if it has never been scanned. */
export function loadCursor(storage: DelegationStorage | null, scope: CursorScope): bigint | null {
  const value = readAll(storage)[scopeKey(scope)]
  if (typeof value !== 'string') return null
  try {
    return BigInt(value)
  } catch {
    // A cursor that will not parse is one full re-scan, which is recoverable. Throwing is not.
    return null
  }
}

/**
 * Records how far this scope has been scanned.
 *
 * Monotonic. Chains sync concurrently and a slow provider can answer with a head that a previous
 * call has already passed; letting that rewind the cursor would re-open a range the prune has
 * authority over on the strength of a stale reading.
 */
export function saveCursor(
  storage: DelegationStorage | null,
  scope: CursorScope,
  lastBlock: bigint,
): void {
  if (!storage) return
  try {
    const current = loadCursor(storage, scope)
    if (current !== null && current >= lastBlock) return
    const all = readAll(storage)
    all[scopeKey(scope)] = lastBlock.toString()
    storage.setItem(SYNC_CURSOR_KEY, JSON.stringify(all))
  } catch {
    // A full or blocked quota costs a re-scan on the next load, nothing more.
  }
}

export function clearCursor(storage: DelegationStorage | null, scope: CursorScope): void {
  if (!storage) return
  try {
    const all = readAll(storage)
    delete all[scopeKey(scope)]
    storage.setItem(SYNC_CURSOR_KEY, JSON.stringify(all))
  } catch {
    // Same as above: unable to forget is not a reason to fail anything.
  }
}

/** Forgets every scope, so the next sync starts from the deployment block again. */
export function clearAllCursors(storage: DelegationStorage | null): void {
  if (!storage) return
  try {
    storage.removeItem(SYNC_CURSOR_KEY)
  } catch {
    // As above.
  }
}
