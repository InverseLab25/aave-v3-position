/**
 * What this wallet has already done, kept between visits.
 *
 * A settled transaction is reported once, in the modal that sent it, and then the modal closes and
 * the numbers are gone. The hash survives on an explorer, but what the swap actually FILLED AT
 * does not — recovering it means decoding the receipt again, which is exactly the work
 * {@link readOutcome} has already done by the time the modal shows it. So it is written down.
 *
 * Storage is injected rather than reached for, following `delegationCache`: the browser's
 * `localStorage` can be absent or throw outright, and no part of this is worth failing a flow for.
 */
import type { Address, Hex } from 'viem'
import type { DelegationStorage } from './delegationCache'

export const HISTORY_KEY = 'defi-route.txhistory.v1'

/** The swap leg, with the metadata needed to format it long after the token list has moved on. */
interface HistorySwap {
  srcToken: Address
  dstToken: Address
  /** Null when nothing on screen could name the token at the time it was recorded. */
  srcSymbol: string | null
  srcDecimals: number | null
  dstSymbol: string | null
  dstDecimals: number | null
  spentAmount: bigint
  returnAmount: bigint
}

export interface HistoryDelta {
  token: Address
  symbol: string | null
  decimals: number | null
  delta: bigint
}

export interface TxHistoryEntry {
  hash: Hex
  chainId: number
  wallet: Address
  kind: 'open' | 'close'
  /** Unix milliseconds, stamped by the caller — this module never reads a clock. */
  at: number
  swap: HistorySwap | null
  /**
   * Destination token per 1 source token, as a decimal string — "1 WETH = 3,405.10 USDC" without
   * the formatting. Taken from the SWAP event, so it is the price paid rather than the one quoted.
   */
  rate: string | null
  fill: { delta: bigint; percent: number | null; belowFloor: boolean } | null
  deltas: HistoryDelta[]
  /**
   * Where this row came from: the flow that sent the transaction, or a scan of the chain.
   *
   * Rows written before the sync existed carry neither field and decode as a live row of unknown
   * block, which is exactly what they are.
   */
  source: 'live' | 'chain'
  /**
   * The block it settled in, once something has confirmed it. Null until then.
   *
   * Load-bearing for {@link mergeHistory}: a row without one can never be pruned, because there is
   * no way to say whether the scan that failed to mention it had even looked in the right place.
   */
  blockNumber: bigint | null
}

/**
 * Readers of this store, and a counter they can compare.
 *
 * The list renders from storage during render while the recorder writes from an effect, which
 * runs afterwards — so a row written for the transaction just settled was invisible until a
 * reload. Storage does not announce itself, so the store does: a version any reader can watch.
 */
const listeners = new Set<() => void>()
let version = 0

function announce(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Subscribes to writes; returns the unsubscribe. Shaped for React's `useSyncExternalStore`. */
export function subscribeHistory(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => void listeners.delete(onChange)
}

/** Moves on every write. A stable value, so it can be a snapshot React compares by identity. */
export function historyVersion(): number {
  return version
}

/**
 * JSON has no bigint, so every one of them crosses as a decimal string.
 *
 * Keys are sorted on the way out as well. `JSON.stringify` writes them in insertion order, so two
 * structurally identical rows built by different code paths — one decoded from storage, one
 * returned by {@link reconcile} — serialise to different strings. {@link mergeHistory} compares
 * those strings to decide whether anything actually changed, and would otherwise announce a write
 * on every sync that found no news.
 */
const encode = (entry: TxHistoryEntry): unknown =>
  JSON.parse(
    JSON.stringify(entry, (_key, value) => {
      if (typeof value === 'bigint') return value.toString()
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      }
      return value
    }),
  )

const asBigInt = (value: unknown): bigint | null => {
  if (typeof value !== 'string') return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

const asNullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asNullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function decodeSwap(raw: unknown): HistorySwap | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const spentAmount = asBigInt(r.spentAmount)
  const returnAmount = asBigInt(r.returnAmount)
  if (spentAmount === null || returnAmount === null) return null
  if (typeof r.srcToken !== 'string' || typeof r.dstToken !== 'string') return null
  return {
    srcToken: r.srcToken as Address,
    dstToken: r.dstToken as Address,
    srcSymbol: asNullableString(r.srcSymbol),
    srcDecimals: asNullableNumber(r.srcDecimals),
    dstSymbol: asNullableString(r.dstSymbol),
    dstDecimals: asNullableNumber(r.dstDecimals),
    spentAmount,
    returnAmount,
  }
}

function decodeEntry(raw: unknown): TxHistoryEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.hash !== 'string' || typeof r.wallet !== 'string') return null
  if (typeof r.chainId !== 'number' || typeof r.at !== 'number') return null
  if (r.kind !== 'open' && r.kind !== 'close') return null

  const fillRaw = r.fill as Record<string, unknown> | null | undefined
  const fillDelta = fillRaw ? asBigInt(fillRaw.delta) : null

  return {
    hash: r.hash as Hex,
    chainId: r.chainId,
    wallet: r.wallet as Address,
    kind: r.kind,
    at: r.at,
    swap: decodeSwap(r.swap),
    rate: asNullableString(r.rate),
    fill:
      fillRaw && fillDelta !== null
        ? {
            delta: fillDelta,
            percent: asNullableNumber(fillRaw.percent),
            belowFloor: fillRaw.belowFloor === true,
          }
        : null,
    deltas: Array.isArray(r.deltas)
      ? r.deltas
          .map((d): HistoryDelta | null => {
            const row = d as Record<string, unknown>
            const delta = asBigInt(row?.delta)
            if (delta === null || typeof row.token !== 'string') return null
            return {
              token: row.token as Address,
              symbol: asNullableString(row.symbol),
              decimals: asNullableNumber(row.decimals),
              delta,
            }
          })
          .filter((d): d is HistoryDelta => d !== null)
      : [],
    // Both absent on every row written before the sync existed. Defaulting rather than rejecting:
    // those rows are the history this feature is here to preserve, not to discard.
    source: r.source === 'chain' ? 'chain' : 'live',
    blockNumber: asBigInt(r.blockNumber),
  }
}

/**
 * Newest first, by when the transaction HAPPENED.
 *
 * Insertion order was equivalent while the only writer was the flow that sent the transaction. A
 * backfill breaks that: it records an hour-old open after a minute-old one, and insertion order
 * would put the older of the two on top.
 *
 * Ties break on block and then hash so the order is total — two rows in the same second must not
 * swap places between reads, or the list reshuffles under the reader on every sync.
 */
function byTimeDescending(a: TxHistoryEntry, b: TxHistoryEntry): number {
  if (a.at !== b.at) return b.at - a.at
  if (a.blockNumber !== b.blockNumber) {
    if (a.blockNumber === null) return 1
    if (b.blockNumber === null) return -1
    return a.blockNumber > b.blockNumber ? -1 : 1
  }
  return a.hash.toLowerCase() < b.hash.toLowerCase() ? -1 : 1
}

/**
 * How many transactions are kept per wallet, per chain.
 *
 * Per scope rather than overall, because one flat array backs every wallet and chain: a single
 * global cap would mean connecting a second wallet evicts the first one's history on sight.
 *
 * KNOWN COST. `historyBasis` REPLAYS these rows to price a position, so evicting an open whose
 * position is still held does not merely hide an old line — it drops units and cost out of the
 * weighted average and leaves a number that looks every bit as plausible as the right one. A
 * position opened more than 50 transactions ago will show a wrong average entry price. That is
 * why there was no cap here; it is back because an unbounded store shares one origin quota with
 * everything else and fails silently when it runs out.
 */
export const MAX_HISTORY_PER_SCOPE = 50

/**
 * Scopes that have had a row evicted, so the basis can refuse rather than average a fraction.
 *
 * A SECOND key rather than a field on the store, because the store's root is a bare array and
 * `readAll` drops anything that is not one. Wrapping it in an object to make room here would
 * read every existing history as empty and throw it away on the next write.
 */
const HISTORY_TRUNCATED_KEY = 'defi-route.txhistory.truncated.v1'

/** One wallet on one chain — the unit the cap is counted in, and the unit `loadHistory` reads. */
const scopeKey = (e: TxHistoryEntry) => `${e.chainId}:${e.wallet.toLowerCase()}`

const scopeOf = (wallet: Address, chainId: number) => `${chainId}:${wallet.toLowerCase()}`

function readTruncated(storage: DelegationStorage | null): Record<string, true> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(HISTORY_TRUNCATED_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, true>
  } catch {
    // Unreadable reads as "nothing known to be truncated", which is the same answer a store
    // that has never evicted anything gives.
    return {}
  }
}

/**
 * Whether this wallet-and-chain has lost rows to the cap.
 *
 * Sticky once set: the rows are gone, and a later scope dropping back under the cap does not
 * bring them back. Only {@link clearHistory} forgets it.
 */
export function isScopeTruncated(
  storage: DelegationStorage | null,
  filter: { wallet: Address; chainId: number },
): boolean {
  return readTruncated(storage)[scopeOf(filter.wallet, filter.chainId)] === true
}

/** Records every scope `sortAndCap` had to evict from. No-op when it evicted nothing. */
function markTruncated(storage: DelegationStorage, evicted: readonly TxHistoryEntry[]): void {
  if (evicted.length === 0) return
  try {
    const marks = readTruncated(storage)
    let changed = false
    for (const row of evicted) {
      if (marks[scopeKey(row)] !== true) {
        marks[scopeKey(row)] = true
        changed = true
      }
    }
    if (changed) storage.setItem(HISTORY_TRUNCATED_KEY, JSON.stringify(marks))
  } catch {
    // Same posture as everything else here. Losing the mark costs an over-confident basis on
    // one load, which is the pre-cap behaviour rather than a new failure.
  }
}

/**
 * Newest first, with each wallet-and-chain trimmed to its newest {@link MAX_HISTORY_PER_SCOPE}.
 *
 * Both write paths go through this, so `appendHistory` and `mergeHistory` cannot disagree about
 * what is on disk — `mergeHistory` decides whether to write at all by comparing against this
 * output, and a cap applied on only one side would make every sync look like news.
 */
function sortAndCap(entries: readonly TxHistoryEntry[]): {
  kept: TxHistoryEntry[]
  evicted: TxHistoryEntry[]
} {
  const sorted = [...entries].sort(byTimeDescending)
  const seen = new Map<string, number>()
  const kept: TxHistoryEntry[] = []
  const evicted: TxHistoryEntry[] = []
  // Sorted newest-first, so counting down the list keeps the newest and drops the oldest.
  for (const e of sorted) {
    const key = scopeKey(e)
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    ;(n <= MAX_HISTORY_PER_SCOPE ? kept : evicted).push(e)
  }
  return { kept, evicted }
}

function readAll(storage: DelegationStorage | null): TxHistoryEntry[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Row by row: an entry written by an older shape, or half-written, costs itself and not the
    // whole list. History is a convenience, and losing all of it to one bad row is not one.
    const rows = parsed.map(decodeEntry).filter((e): e is TxHistoryEntry => e !== null)
    // Sorted on the way out rather than trusted from disk, so a store written before ordering
    // moved to `at` still reads back in the right order without having to be rewritten first.
    return rows.sort(byTimeDescending)
  } catch {
    return []
  }
}

const txKey = (e: { chainId: number; hash: Hex }) => `${e.chainId}:${e.hash.toLowerCase()}`

/**
 * The two records of one transaction, combined into the one that keeps everything either knew.
 *
 * A transaction can be described twice — once by the flow that sent it, once by a scan that read
 * it back — and neither description is complete. The chain has the authoritative amounts, the
 * block timestamp and the kind, straight from an indexed event. Only the live record has a `fill`,
 * because `expectedOut` and `minOut` came from a quote that exists nowhere on chain and can never
 * be recovered. Overwriting in either direction throws away something.
 */
function reconcile(local: TxHistoryEntry, incoming: TxHistoryEntry): TxHistoryEntry {
  // The incoming row wins ties: for two live records it is the fresher reading of the same thing.
  // It loses only to a local row that was read off the chain when it was not.
  const chainWins = local.source === 'chain' && incoming.source !== 'chain'
  const authoritative = chainWins ? local : incoming
  const other = chainWins ? incoming : local

  return {
    hash: local.hash,
    chainId: local.chainId,
    wallet: local.wallet,
    kind: authoritative.kind,
    at: authoritative.at,
    swap: mergeSwap(authoritative.swap, other.swap),
    rate: authoritative.rate ?? other.rate,
    // Never `authoritative`: the side that has one is the side that measured it.
    fill: local.fill ?? incoming.fill,
    deltas: authoritative.deltas.length > 0 ? authoritative.deltas : other.deltas,
    blockNumber: incoming.blockNumber ?? local.blockNumber,
    // Live is the stickier label — a row carrying a `fill` was witnessed being sent, whatever
    // else has confirmed it since.
    source: local.source === 'live' || incoming.source === 'live' ? 'live' : 'chain',
  }
}

/**
 * The swap leg with the naming filled in from whichever record happened to have it.
 *
 * The amounts come from `authoritative` whole — they are one fill and must not be assembled from
 * two readings of it. Only the metadata is borrowed, and only when both records agree on the pair:
 * a row that disagrees about the tokens is describing a different fill, and labelling it with the
 * other's symbols would produce a confidently wrong line rather than an unnamed one.
 */
function mergeSwap(authoritative: HistorySwap | null, other: HistorySwap | null): HistorySwap | null {
  if (!authoritative) return other
  if (!other) return authoritative

  const samePair =
    authoritative.srcToken.toLowerCase() === other.srcToken.toLowerCase() &&
    authoritative.dstToken.toLowerCase() === other.dstToken.toLowerCase()
  if (!samePair) return authoritative

  return {
    ...authoritative,
    srcSymbol: authoritative.srcSymbol ?? other.srcSymbol,
    srcDecimals: authoritative.srcDecimals ?? other.srcDecimals,
    dstSymbol: authoritative.dstSymbol ?? other.dstSymbol,
    dstDecimals: authoritative.dstDecimals ?? other.dstDecimals,
  }
}

function write(storage: DelegationStorage, entries: readonly TxHistoryEntry[]): void {
  const { kept, evicted } = sortAndCap(entries)
  storage.setItem(HISTORY_KEY, JSON.stringify(kept.map(encode)))
  markTruncated(storage, evicted)
}

/**
 * Records a settled transaction.
 *
 * De-duplicated by (chain, hash) because the caller records from a render effect — a re-render, a
 * remount, or React running an effect twice must not turn one transaction into three rows. A
 * transaction the sync has already filed is reconciled with rather than replaced, so recording it
 * live does not cost the block number the scan found.
 */
export function appendHistory(storage: DelegationStorage | null, entry: TxHistoryEntry): void {
  if (!storage) return
  try {
    const existing = readAll(storage)
    const at = existing.findIndex((e) => txKey(e) === txKey(entry))
    const next = [...existing]
    if (at === -1) next.push(entry)
    else next[at] = reconcile(existing[at], entry)

    write(storage, next)
    announce()
  } catch {
    // A full or blocked quota costs a row of history, nothing more.
  }
}

/** What a completed scan covered. Null means the scan did not finish — see {@link mergeHistory}. */
interface ScannedRange {
  from: bigint
  to: bigint
}

interface MergeHistoryInput {
  wallet: Address
  chainId: number
  /** Everything the chain reported for this wallet on this chain, within `range`. */
  entries: readonly TxHistoryEntry[]
  /**
   * The block range the scan actually covered, or null if it did not complete.
   *
   * Null is the safe value and the default for every failure path: without a range nothing is
   * pruned, so a scan that threw halfway can never be mistaken for proof that the transactions it
   * never reached do not exist.
   */
  range: ScannedRange | null
}

/**
 * Folds a scan of the chain into what is already recorded: adds, repairs, and prunes.
 *
 * The prune is the only operation here that can destroy data, so it is fenced by a conjunction
 * every clause of which has to hold — see the design note in
 * `docs/superpowers/specs/2026-08-17-onchain-history-sync-design.md`. In particular a row is only
 * ever removed if a COMPLETED scan of a range that DEMONSTRABLY CONTAINS IT failed to find it,
 * which is the signature of a reorg rather than of a bad afternoon on a public RPC.
 */
export function mergeHistory(storage: DelegationStorage | null, input: MergeHistoryInput): void {
  if (!storage) return
  try {
    const { wallet, chainId, entries, range } = input
    const owner = wallet.toLowerCase()
    const existing = readAll(storage)
    const before = JSON.stringify(existing.map(encode))

    const byKey = new Map(existing.map((e) => [txKey(e), e]))
    for (const entry of entries) {
      const local = byKey.get(txKey(entry))
      byKey.set(txKey(entry), local ? reconcile(local, entry) : entry)
    }

    const confirmed = new Set(entries.map(txKey))
    const next = [...byKey.values()].filter((row) => {
      if (range === null) return true
      if (row.wallet.toLowerCase() !== owner || row.chainId !== chainId) return true
      if (row.blockNumber === null) return true
      if (row.blockNumber < range.from || row.blockNumber > range.to) return true
      return confirmed.has(txKey(row))
    })

    // Compared rather than assumed: a sync that finds no news runs on every connect, and the
    // panel re-renders on every announcement.
    const { kept, evicted } = sortAndCap(next)
    const after = JSON.stringify(kept.map(encode))
    if (after === before) return

    storage.setItem(HISTORY_KEY, after)
    markTruncated(storage, evicted)
    announce()
  } catch {
    // Same as `appendHistory`: history is a convenience and never worth failing a flow for.
  }
}

/** Everything recorded, newest first — optionally narrowed to one wallet on one chain. */
export function loadHistory(
  storage: DelegationStorage | null,
  filter?: { wallet?: Address; chainId?: number },
): TxHistoryEntry[] {
  const all = readAll(storage)
  const wallet = filter?.wallet?.toLowerCase()
  return all.filter(
    (e) =>
      (wallet === undefined || e.wallet.toLowerCase() === wallet) &&
      (filter?.chainId === undefined || e.chainId === filter.chainId),
  )
}

export function clearHistory(storage: DelegationStorage | null): void {
  if (!storage) return
  try {
    storage.removeItem(HISTORY_KEY)
    // The mark describes rows that no longer exist either way — leaving it behind would make an
    // empty store refuse to price anything.
    storage.removeItem(HISTORY_TRUNCATED_KEY)
    announce()
  } catch {
    // Same as above: unable to forget it is not a reason to fail anything.
  }
}
