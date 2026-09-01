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
import { clearScreened } from './screenCache'

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
/**
 * Bigints as decimal strings, and object keys in a fixed order.
 *
 * The key sort is what lets `mergeHistory` decide whether anything changed by comparing two
 * strings: without it, two identical stores written in different key orders compare unequal and
 * every sync rewrites storage and re-renders the panel.
 */
const rowReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
    )
  }
  return value
}

/**
 * A token as it was recorded, keyed on ALL THREE fields rather than the address alone.
 *
 * The same address can appear with a symbol and without one — recorded before anything on
 * screen could name it, and again after. Folding those together would rewrite history: the
 * older row would gain a symbol it never had.
 */
const tokenKey = (t: { token: string; symbol: string | null; decimals: number | null }): string =>
  `${t.token}|${t.symbol ?? ''}|${t.decimals ?? ''}`

/** Collects tokens and wallets as rows are walked, handing back the index each one landed at. */
function newTables() {
  const tokens: [string, string | null, number | null][] = []
  const wallets: string[] = []
  const tokenAt = new Map<string, number>()
  const walletAt = new Map<string, number>()
  return {
    tokens,
    wallets,
    token(t: { token: string; symbol: string | null; decimals: number | null }): number {
      const key = tokenKey(t)
      const found = tokenAt.get(key)
      if (found !== undefined) return found
      const at = tokens.push([t.token, t.symbol, t.decimals]) - 1
      tokenAt.set(key, at)
      return at
    },
    wallet(address: string): number {
      const found = walletAt.get(address)
      if (found !== undefined) return found
      const at = wallets.push(address) - 1
      walletAt.set(address, at)
      return at
    },
  }
}


/**
 * The stored form of a whole list, in one pass.
 *
 * Every row used to carry the full address, symbol and decimals of every token it touched, plus
 * the wallet — 42 characters an address, repeated across the store. Tokens and wallets are
 * hoisted into tables at the document root and referenced by index, which measured 46% off a
 * full 250-row store: 158 KB down to 85 KB.
 *
 * It also used to run `JSON.parse(JSON.stringify(row))` per row and then stringify the array on
 * top — three serialisations of every row to produce one string. `JSON.stringify` applies a
 * replacer recursively, so the document is written directly.
 *
 * Table order follows first encounter, which is deterministic because `sortAndCap` hands rows
 * over in a fixed order. That matters: `mergeHistory` decides whether anything changed by
 * comparing two of these strings.
 */
const serialise = (entries: readonly TxHistoryEntry[]): string => {
  const t = newTables()
  const rows = entries.map((e) => ({
    at: e.at,
    blockNumber: e.blockNumber,
    chainId: e.chainId,
    deltas: e.deltas.map((d) => [t.token(d), d.delta]),
    fill: e.fill,
    hash: e.hash,
    kind: e.kind,
    rate: e.rate,
    source: e.source,
    swap:
      e.swap === null
        ? null
        : {
            dst: t.token({
              token: e.swap.dstToken, symbol: e.swap.dstSymbol, decimals: e.swap.dstDecimals,
            }),
            returnAmount: e.swap.returnAmount,
            spentAmount: e.swap.spentAmount,
            src: t.token({
              token: e.swap.srcToken, symbol: e.swap.srcSymbol, decimals: e.swap.srcDecimals,
            }),
          },
    wallet: t.wallet(e.wallet),
  }))
  return JSON.stringify({ rows, tokens: t.tokens, wallets: t.wallets }, rowReplacer)
}

const asBigInt = (value: unknown): bigint | null => {
  if (typeof value !== 'string') return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

const asNullableNumber = (value: unknown): number | null =>
  typeof value === 'number' ? value : null

const asNullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null

/** A token resolved out of the document's table, or null when the index points nowhere. */
type TokenLookup = (index: unknown) => { token: Address; symbol: string | null; decimals: number | null } | null
/** The wallet at an index in the document's table, or null when the index points nowhere. */
type WalletLookup = (index: unknown) => Address | null

function decodeEntry(raw: unknown, lookup: TokenLookup, walletOf: WalletLookup): TxHistoryEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.hash !== 'string') return null
  if (typeof r.chainId !== 'number' || typeof r.at !== 'number') return null
  if (r.kind !== 'open' && r.kind !== 'close') return null

  const fillRaw = r.fill as Record<string, unknown> | null | undefined
  const fillDelta = fillRaw ? asBigInt(fillRaw.delta) : null
  const wallet = walletOf(r.wallet)
  if (wallet === null) return null

  // A swap naming a token the table does not hold is a half-written document. The row keeps
  // everything else it can still account for rather than being thrown away whole — except when
  // it claimed a swap and cannot produce one, which would read as a transfer that never swapped.
  const swapRaw = r.swap as Record<string, unknown> | null | undefined
  const src = swapRaw ? lookup(swapRaw.src) : null
  const dst = swapRaw ? lookup(swapRaw.dst) : null
  const spent = swapRaw ? asBigInt(swapRaw.spentAmount) : null
  const returned = swapRaw ? asBigInt(swapRaw.returnAmount) : null
  if (swapRaw && (!src || !dst || spent === null || returned === null)) return null

  return {
    hash: r.hash as Hex,
    chainId: r.chainId,
    wallet,
    kind: r.kind,
    at: r.at,
    swap:
      src && dst && spent !== null && returned !== null
        ? {
            srcToken: src.token, srcSymbol: src.symbol, srcDecimals: src.decimals,
            dstToken: dst.token, dstSymbol: dst.symbol, dstDecimals: dst.decimals,
            spentAmount: spent,
            returnAmount: returned,
          }
        : null,
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
            if (!Array.isArray(d)) return null
            const token = lookup(d[0])
            const delta = asBigInt(d[1])
            return token && delta !== null ? { ...token, delta } : null
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
    const parsed = JSON.parse(raw) as {
      rows?: unknown
      tokens?: unknown
      wallets?: unknown
    } | null
    // An array here is the old flat format, which this deliberately does not read: the store
    // carries no compatibility shim, and the rows are rebuilt from the chain instead.
    //
    // The SCREENING cache has to go with it, or they never are. `hashSync` skips every hash it
    // already holds a verdict for, so with the history gone and the verdicts kept it fetches no
    // receipts, writes no rows, and returns before doing anything — leaving Recent activity
    // blank for good rather than for one sync.
    if (!parsed || Array.isArray(parsed) || !Array.isArray(parsed.rows)) {
      storage.removeItem(HISTORY_KEY)
      clearScreened(storage)
      return []
    }

    const tokens = Array.isArray(parsed.tokens) ? parsed.tokens : []
    const wallets = Array.isArray(parsed.wallets) ? parsed.wallets : []
    const lookup = (index: unknown) => {
      const row = typeof index === 'number' ? tokens[index] : undefined
      if (!Array.isArray(row) || typeof row[0] !== 'string') return null
      return {
        token: row[0] as Address,
        symbol: asNullableString(row[1]),
        decimals: asNullableNumber(row[2]),
      }
    }
    const walletOf = (index: unknown) => {
      const found = typeof index === 'number' ? wallets[index] : undefined
      return typeof found === 'string' ? (found as Address) : null
    }

    // Row by row: a half-written document costs the row it broke and not the whole list. History
    // is a convenience, and losing all of it to one bad row is not one.
    const rows = parsed.rows
      .map((r) => decodeEntry(r, lookup, walletOf))
      .filter((e): e is TxHistoryEntry => e !== null)
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
  storage.setItem(HISTORY_KEY, serialise(kept))
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
    const before = serialise(existing)

    const byKey = new Map(existing.map((e) => [txKey(e), e]))
    for (const entry of entries) {
      const key = txKey(entry)
      const local = byKey.get(key)
      byKey.set(key, local ? reconcile(local, entry) : entry)
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
    const after = serialise(kept)
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
