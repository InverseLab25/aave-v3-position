/**
 * Which transactions have already been looked at, so they are never fetched twice.
 *
 * Discovery asks Aave's indexer for every hash this wallet touched, then reads each receipt to
 * find out whether a strategies contract was involved — see `receiptScreen`. Most are not: on a
 * real Base account, eight hashes yielded three. Without a record, every one of those eight would
 * be fetched again on every load, forever, to reach the same conclusion.
 *
 * Only the VERDICT is kept, never the receipt. Everything worth having from a matching receipt is
 * already distilled into a `TxHistoryEntry` — the swap's two tokens, their decimals and the two
 * amounts — and a receipt carries twenty-odd logs of things no part of this app reads. A verdict
 * is one word against one hash.
 */
import type { Address, Hex } from 'viem'
import type { DelegationStorage } from './delegationCache'

export const SCREEN_KEY = 'defi-route.txscreen.v1'

/** `strategies` — one of ours, and filed in history. `other` — ordinary Aave activity. */
export type Verdict = 'strategies' | 'other'

export interface ScreenScope {
  wallet: Address
  chainId: number
}

export interface Screened {
  hash: Hex
  verdict: Verdict
}

/**
 * Hashes are compared lower-cased throughout.
 *
 * Aave's indexer and an RPC do not agree on the casing of a hash, and a miss here is not a
 * correctness bug but a permanent one-per-load refetch — the exact cost this module exists to
 * remove, quietly reintroduced.
 */
const scopeKey = (s: ScreenScope) => `${s.wallet.toLowerCase()}:${s.chainId}`

type Store = Record<string, Record<string, Verdict>>

function read(storage: DelegationStorage | null): Store {
  if (!storage) return {}
  try {
    const raw = storage.getItem(SCREEN_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Store
  } catch {
    // Same posture as the history store: a screen cache is an optimisation, and losing it costs
    // one round of refetching rather than any data.
    return {}
  }
}

/** Everything already decided for this wallet on this chain, keyed by lower-cased hash. */
export function loadScreened(
  storage: DelegationStorage | null,
  scope: ScreenScope,
): Map<string, Verdict> {
  return new Map(Object.entries(read(storage)[scopeKey(scope)] ?? {}))
}

/** The hashes with no verdict yet — the only ones a receipt has to be fetched for. */
export function unscreened(
  storage: DelegationStorage | null,
  scope: ScreenScope,
  hashes: readonly Hex[],
): Hex[] {
  const seen = loadScreened(storage, scope)
  const out: Hex[] = []
  // De-duplicated on the way through: one leveraged open produces several indexer rows under one
  // hash, and fetching that receipt three times would undo the point of the cache.
  const queued = new Set<string>()
  for (const hash of hashes) {
    const key = hash.toLowerCase()
    if (seen.has(key) || queued.has(key)) continue
    queued.add(key)
    out.push(hash)
  }
  return out
}

/** Files verdicts, merged with whatever was already known. */
export function recordScreened(
  storage: DelegationStorage | null,
  scope: ScreenScope,
  results: readonly Screened[],
): void {
  if (!storage || results.length === 0) return
  try {
    const store = read(storage)
    const key = scopeKey(scope)
    const scoped = { ...(store[key] ?? {}) }
    for (const { hash, verdict } of results) scoped[hash.toLowerCase()] = verdict
    storage.setItem(SCREEN_KEY, JSON.stringify({ ...store, [key]: scoped }))
  } catch {
    // A full or blocked quota costs the optimisation, never the history.
  }
}

/**
 * Forgets every verdict, so the next round reads all of them again.
 *
 * What Resync means now that discovery walks hashes: there is no cursor to rewind, and the
 * history rows themselves are reconciled rather than replaced. The only thing standing between a
 * user and a fresh read of the chain is this cache, so this is the thing Resync clears.
 */
export function clearScreened(storage: DelegationStorage | null): void {
  if (!storage) return
  try {
    storage.removeItem(SCREEN_KEY)
  } catch {
    // Unable to forget is not a reason to fail anything.
  }
}
