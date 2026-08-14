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

/**
 * How many transactions to keep.
 *
 * Enough to cover any session a user would scroll back through, and small enough that the whole
 * list is parsed in one go without noticing. Storage is a few kB per fifty entries.
 */
export const HISTORY_LIMIT = 50

/** The swap leg, with the metadata needed to format it long after the token list has moved on. */
export interface HistorySwap {
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
}

/** JSON has no bigint, so every one of them crosses as a decimal string. */
const encode = (entry: TxHistoryEntry): unknown =>
  JSON.parse(JSON.stringify(entry, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)))

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
  }
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
    return parsed.map(decodeEntry).filter((e): e is TxHistoryEntry => e !== null)
  } catch {
    return []
  }
}

const sameTx = (a: TxHistoryEntry, b: TxHistoryEntry) =>
  a.chainId === b.chainId && a.hash.toLowerCase() === b.hash.toLowerCase()

/**
 * Records a settled transaction, newest first.
 *
 * De-duplicated by (chain, hash) because the caller records from a render effect — a re-render, a
 * remount, or React running an effect twice must not turn one transaction into three rows.
 */
export function appendHistory(storage: DelegationStorage | null, entry: TxHistoryEntry): void {
  if (!storage) return
  try {
    const existing = readAll(storage).filter((e) => !sameTx(e, entry))
    const next = [entry, ...existing].slice(0, HISTORY_LIMIT)
    storage.setItem(HISTORY_KEY, JSON.stringify(next.map(encode)))
  } catch {
    // A full or blocked quota costs a row of history, nothing more.
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
  } catch {
    // Same as above: unable to forget it is not a reason to fail anything.
  }
}
