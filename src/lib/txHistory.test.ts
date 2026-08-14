import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  HISTORY_KEY,
  HISTORY_LIMIT,
  appendHistory,
  clearHistory,
  loadHistory,
  type TxHistoryEntry,
} from './txHistory'
import type { DelegationStorage } from './delegationCache'

const WALLET = '0x1111111111111111111111111111111111111111' as Address
const OTHER_WALLET = '0x2222222222222222222222222222222222222222' as Address
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address

function memoryStorage(seed: Record<string, string> = {}): DelegationStorage {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

function entry(over: Partial<TxHistoryEntry> = {}): TxHistoryEntry {
  return {
    hash: `0x${'11'.repeat(32)}`,
    chainId: 8453,
    wallet: WALLET,
    kind: 'open',
    at: 1_800_000_000_000,
    swap: {
      srcToken: USDC,
      dstToken: WETH,
      srcSymbol: 'USDC',
      srcDecimals: 6,
      dstSymbol: 'WETH',
      dstDecimals: 18,
      spentAmount: 3405_100000n,
      returnAmount: 10n ** 18n,
    },
    rate: '0.000293',
    fill: { delta: -2_700000n, percent: -0.0792, belowFloor: false },
    deltas: [{ token: WETH, symbol: 'WETH', decimals: 18, delta: 10n ** 18n }],
    ...over,
  }
}

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`

describe('txHistory', () => {
  it('reads back an appended entry with its bigints intact', () => {
    const storage = memoryStorage()
    const original = entry()

    appendHistory(storage, original)

    expect(loadHistory(storage)).toEqual([original])
  })

  it('keeps the rate the swap actually filled at', () => {
    // The reason this file exists rather than a list of hashes: what a past open cost is not
    // recoverable from the chain without re-deriving it from the receipt every time.
    const storage = memoryStorage()

    appendHistory(storage, entry({ rate: '3405.1' }))

    expect(loadHistory(storage)[0].rate).toBe('3405.1')
  })

  it('puts the newest entry first', () => {
    const storage = memoryStorage()

    appendHistory(storage, entry({ hash: hash(1), at: 1000 }))
    appendHistory(storage, entry({ hash: hash(2), at: 2000 }))

    expect(loadHistory(storage).map((e) => e.hash)).toEqual([hash(2), hash(1)])
  })

  it('records a transaction once however many times the flow reports it', () => {
    // The caller records from a render effect, and a re-render must not produce a second row.
    const storage = memoryStorage()

    appendHistory(storage, entry({ hash: hash(7) }))
    appendHistory(storage, entry({ hash: hash(7) }))

    expect(loadHistory(storage)).toHaveLength(1)
  })

  it('tells apart the same hash on two different chains', () => {
    const storage = memoryStorage()

    appendHistory(storage, entry({ hash: hash(7), chainId: 8453 }))
    appendHistory(storage, entry({ hash: hash(7), chainId: 42161 }))

    expect(loadHistory(storage)).toHaveLength(2)
  })

  it('drops the oldest once it is full, so it cannot grow without bound', () => {
    const storage = memoryStorage()
    for (let i = 0; i <= HISTORY_LIMIT; i++) appendHistory(storage, entry({ hash: hash(i), at: i }))

    const kept = loadHistory(storage)

    expect(kept).toHaveLength(HISTORY_LIMIT)
    expect(kept.map((e) => e.hash)).not.toContain(hash(0))
  })

  it('returns only the wallet and chain asked for', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1) }))
    appendHistory(storage, entry({ hash: hash(2), wallet: OTHER_WALLET }))
    appendHistory(storage, entry({ hash: hash(3), chainId: 42161 }))

    const mine = loadHistory(storage, { wallet: WALLET, chainId: 8453 })

    expect(mine.map((e) => e.hash)).toEqual([hash(1)])
  })

  it('matches the wallet whatever case it is asked for in', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry())

    expect(loadHistory(storage, { wallet: WALLET.toUpperCase() as Address })).toHaveLength(1)
  })

  it('forgets everything when cleared', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry())

    clearHistory(storage)

    expect(loadHistory(storage)).toEqual([])
  })

  it('reads a corrupt payload as no history rather than throwing', () => {
    expect(loadHistory(memoryStorage({ [HISTORY_KEY]: 'not json' }))).toEqual([])
    expect(loadHistory(memoryStorage({ [HISTORY_KEY]: '{"not":"an array"}' }))).toEqual([])
  })

  it('keeps the readable rows when one of them is malformed', () => {
    // A shape that changed, or a half-written entry. Losing the whole list to one bad row would
    // be a worse outcome than losing the row.
    const good = JSON.parse(
      JSON.stringify({ ...entry(), swap: null, fill: null, deltas: [] }, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    )
    const storage = memoryStorage({
      [HISTORY_KEY]: JSON.stringify([{ hash: '0xdead' }, good]),
    })

    expect(loadHistory(storage)).toHaveLength(1)
  })

  it('survives storage that refuses to be written to', () => {
    const full: DelegationStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    }

    expect(() => appendHistory(full, entry())).not.toThrow()
  })

  it('treats an absent store as no history', () => {
    expect(loadHistory(null)).toEqual([])
    expect(() => appendHistory(null, entry())).not.toThrow()
    expect(() => clearHistory(null)).not.toThrow()
  })
})
