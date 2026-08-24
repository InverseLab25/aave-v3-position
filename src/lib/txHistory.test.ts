import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  HISTORY_KEY,
  MAX_HISTORY_PER_SCOPE,
  isScopeTruncated,
  historyVersion,
  subscribeHistory,
  appendHistory,
  clearHistory,
  loadHistory,
  mergeHistory,
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
    source: 'live',
    blockNumber: null,
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

  it('keeps the oldest row until the cap is reached', () => {
    // Below the cap nothing is evicted at all, which is the case that matters most:
    // `historyBasis` replays these rows to price a position, so dropping the first open would
    // not hide an old line, it would change an average entry price to one just as plausible.
    const storage = memoryStorage()
    for (let i = 0; i < MAX_HISTORY_PER_SCOPE; i++) {
      appendHistory(storage, entry({ hash: hash(i), at: i }))
    }

    const kept = loadHistory(storage)

    expect(kept).toHaveLength(MAX_HISTORY_PER_SCOPE)
    expect(kept.map((e) => e.hash)).toContain(hash(0))
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

  it('tells subscribers when something has been recorded', () => {
    // The list reads storage during render and the recorder writes in an effect, which runs
    // afterwards — so without a notification the row it just wrote is invisible until a reload.
    const storage = memoryStorage()
    let notified = 0
    const unsubscribe = subscribeHistory(() => notified++)

    appendHistory(storage, entry())

    expect(notified).toBe(1)
    unsubscribe()
  })

  it('moves the version on every write, so a reader can tell it changed', () => {
    const storage = memoryStorage()
    const before = historyVersion()

    appendHistory(storage, entry({ hash: hash(1) }))
    appendHistory(storage, entry({ hash: hash(2) }))

    expect(historyVersion()).toBe(before + 2)
  })

  it('tells subscribers when history is cleared', () => {
    let notified = 0
    const unsubscribe = subscribeHistory(() => notified++)

    clearHistory(memoryStorage())

    expect(notified).toBe(1)
    unsubscribe()
  })

  it('stops telling a subscriber that has unsubscribed', () => {
    let notified = 0
    subscribeHistory(() => notified++)()

    appendHistory(memoryStorage(), entry())

    expect(notified).toBe(0)
  })

  it('treats an absent store as no history', () => {
    expect(loadHistory(null)).toEqual([])
    expect(() => appendHistory(null, entry())).not.toThrow()
    expect(() => clearHistory(null)).not.toThrow()
  })

  it('reads a row written before provenance was recorded as a live one of unknown block', () => {
    // Every entry in a user's storage today predates both fields. Refusing to decode them would
    // throw away the exact history this feature exists to preserve.
    const v1 = JSON.parse(
      JSON.stringify({ ...entry(), source: undefined, blockNumber: undefined }, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    )
    const storage = memoryStorage({ [HISTORY_KEY]: JSON.stringify([v1]) })

    const [row] = loadHistory(storage)

    expect(row.source).toBe('live')
    expect(row.blockNumber).toBeNull()
  })

  it('keeps a block number across a write and a read', () => {
    const storage = memoryStorage()

    appendHistory(storage, entry({ blockNumber: 49_831_780n, source: 'chain' }))

    expect(loadHistory(storage)[0].blockNumber).toBe(49_831_780n)
    expect(loadHistory(storage)[0].source).toBe('chain')
  })

  it('orders by when it happened, not by when it was written down', () => {
    // A backfill produces rows out of order — an hour-old transaction can be recorded after a
    // minute-old one. Insertion order would put the older of the two on top.
    const storage = memoryStorage()

    appendHistory(storage, entry({ hash: hash(1), at: 3000 }))
    appendHistory(storage, entry({ hash: hash(2), at: 1000 }))
    appendHistory(storage, entry({ hash: hash(3), at: 2000 }))

    expect(loadHistory(storage).map((e) => e.hash)).toEqual([hash(1), hash(3), hash(2)])
  })

  it('never lets one chain evict another', () => {
    // The busy chain hits its own cap; the quiet one keeps its single row regardless.
    const storage = memoryStorage()
    for (let i = 0; i < 60; i++) {
      appendHistory(storage, entry({ hash: hash(i), chainId: 8453, at: i }))
    }
    appendHistory(storage, entry({ hash: hash(999), chainId: 42161, at: 1 }))

    expect(loadHistory(storage, { chainId: 8453 })).toHaveLength(MAX_HISTORY_PER_SCOPE)
    expect(loadHistory(storage, { chainId: 42161 })).toHaveLength(1)
  })

})

describe('mergeHistory', () => {
  const range = { from: 100n, to: 200n }

  it('adds a transaction this browser never saw', () => {
    const storage = memoryStorage()

    mergeHistory(storage, {
      wallet: WALLET,
      chainId: 8453,
      range,
      entries: [entry({ hash: hash(1), source: 'chain', blockNumber: 150n })],
    })

    expect(loadHistory(storage)).toHaveLength(1)
  })

  it('repairs a row that was recorded before its tokens could be named', () => {
    // The live recorder writes whatever metadata the screen happened to hold. On a cold load that
    // is nothing, and the row reads "1234 raw units against 0x8f3c…b21a" forever.
    const storage = memoryStorage()
    appendHistory(
      storage,
      entry({
        hash: hash(1),
        rate: null,
        swap: {
          srcToken: USDC, dstToken: WETH,
          srcSymbol: null, srcDecimals: null, dstSymbol: null, dstDecimals: null,
          spentAmount: 3405_100000n, returnAmount: 10n ** 18n,
        },
      }),
    )

    mergeHistory(storage, {
      wallet: WALLET, chainId: 8453, range,
      entries: [entry({ hash: hash(1), source: 'chain', blockNumber: 150n, rate: '0.000293' })],
    })

    const [row] = loadHistory(storage)
    expect(row.swap?.srcSymbol).toBe('USDC')
    expect(row.swap?.dstDecimals).toBe(18)
    expect(row.rate).toBe('0.000293')
  })

  it('keeps the fill quality only the live record could have measured', () => {
    // `expectedOut` and `minOut` came from a quote that exists nowhere on chain, so a re-read can
    // never recover them. A merge that overwrote the live row would destroy them.
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1) }))

    mergeHistory(storage, {
      wallet: WALLET, chainId: 8453, range,
      entries: [entry({ hash: hash(1), source: 'chain', blockNumber: 150n, fill: null })],
    })

    expect(loadHistory(storage)[0].fill).toEqual({
      delta: -2_700000n, percent: -0.0792, belowFloor: false,
    })
  })

  it('prefers the block timestamp over the moment the browser noticed', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1), at: 9_999_999 }))

    mergeHistory(storage, {
      wallet: WALLET, chainId: 8453, range,
      entries: [entry({ hash: hash(1), source: 'chain', blockNumber: 150n, at: 1_700_000_000_000 })],
    })

    expect(loadHistory(storage)[0].at).toBe(1_700_000_000_000)
  })

  it('does not borrow symbols from a local row describing a different pair', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1) }))
    const other = '0x3333333333333333333333333333333333333333' as Address

    mergeHistory(storage, {
      wallet: WALLET, chainId: 8453, range,
      entries: [
        entry({
          hash: hash(1), source: 'chain', blockNumber: 150n,
          swap: {
            srcToken: other, dstToken: WETH,
            srcSymbol: null, srcDecimals: null, dstSymbol: null, dstDecimals: null,
            spentAmount: 1n, returnAmount: 2n,
          },
        }),
      ],
    })

    expect(loadHistory(storage)[0].swap?.srcSymbol).toBeNull()
  })

  it('records a transaction once when the live path and the sync both report it', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1) }))

    mergeHistory(storage, {
      wallet: WALLET, chainId: 8453, range,
      entries: [entry({ hash: hash(1), source: 'chain', blockNumber: 150n })],
    })

    expect(loadHistory(storage)).toHaveLength(1)
  })

  it('drops a row the completed scan could not confirm on chain', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1), source: 'chain', blockNumber: 150n }))

    mergeHistory(storage, { wallet: WALLET, chainId: 8453, range, entries: [] })

    expect(loadHistory(storage)).toEqual([])
  })

  it('deletes nothing when the scan did not finish', () => {
    // The clause that matters most. A scan that threw halfway has no opinion about what exists,
    // and treating its empty result as authoritative would erase real history on any RPC blip.
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1), source: 'chain', blockNumber: 150n }))

    mergeHistory(storage, { wallet: WALLET, chainId: 8453, range: null, entries: [] })

    expect(loadHistory(storage)).toHaveLength(1)
  })

  it('leaves a row sitting outside the range that was scanned', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1), source: 'chain', blockNumber: 50n }))

    mergeHistory(storage, { wallet: WALLET, chainId: 8453, range, entries: [] })

    expect(loadHistory(storage)).toHaveLength(1)
  })

  it('leaves a row whose block was never recorded', () => {
    // Everything written before this feature. There is no way to tell whether the scan covered it.
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1), blockNumber: null }))

    mergeHistory(storage, { wallet: WALLET, chainId: 8453, range, entries: [] })

    expect(loadHistory(storage)).toHaveLength(1)
  })

  it('leaves another wallet and another chain alone', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1), wallet: OTHER_WALLET, blockNumber: 150n }))
    appendHistory(storage, entry({ hash: hash(2), chainId: 42161, blockNumber: 150n }))

    mergeHistory(storage, { wallet: WALLET, chainId: 8453, range, entries: [] })

    expect(loadHistory(storage)).toHaveLength(2)
  })

  it('matches the wallet it is pruning for whatever case it is given in', () => {
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1), blockNumber: 150n }))

    mergeHistory(storage, {
      wallet: WALLET.toUpperCase() as Address, chainId: 8453, range, entries: [],
    })

    expect(loadHistory(storage)).toEqual([])
  })

  it('tells subscribers once, however many rows it wrote', () => {
    const storage = memoryStorage()
    let notified = 0
    const unsubscribe = subscribeHistory(() => notified++)

    mergeHistory(storage, {
      wallet: WALLET, chainId: 8453, range,
      entries: [entry({ hash: hash(1) }), entry({ hash: hash(2) })],
    })

    expect(notified).toBe(1)
    unsubscribe()
  })

  it('says nothing when it changed nothing', () => {
    // The panel re-renders on every announcement. A sync that finds no news should be invisible.
    const storage = memoryStorage()
    appendHistory(storage, entry({ hash: hash(1), source: 'chain', blockNumber: 150n }))
    let notified = 0
    const unsubscribe = subscribeHistory(() => notified++)

    mergeHistory(storage, {
      wallet: WALLET, chainId: 8453, range,
      entries: [entry({ hash: hash(1), source: 'chain', blockNumber: 150n })],
    })

    expect(notified).toBe(0)
    unsubscribe()
  })

  it('survives an absent store and one that refuses to be written to', () => {
    const full: DelegationStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
    }
    const input = { wallet: WALLET, chainId: 8453, range, entries: [entry()] }

    expect(() => mergeHistory(null, input)).not.toThrow()
    expect(() => mergeHistory(full, input)).not.toThrow()
  })
})

describe('the FIFO cap', () => {
  const hashN = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`

  /**
   * `count` rows for one wallet on one chain, oldest first. `offset` shifts the hashes, because
   * rows are keyed by (chain, hash) — two scopes reusing the same hashes would overwrite each
   * other rather than sit side by side.
   */
  const fill = (
    storage: DelegationStorage,
    count: number,
    over: Partial<TxHistoryEntry> = {},
    offset = 0,
  ) => {
    for (let i = 0; i < count; i++) {
      appendHistory(
        storage,
        entry({ hash: hashN(offset + i), at: 1_800_000_000_000 + i * 1000, ...over }),
      )
    }
  }

  it('keeps the newest 50 and drops the oldest', async () => {
    const storage = memoryStorage()
    fill(storage, 55)

    const rows = loadHistory(storage, { wallet: WALLET, chainId: 8453 })

    expect(rows).toHaveLength(MAX_HISTORY_PER_SCOPE)
    // Newest first, so row 0 is the last one appended and the first five are gone.
    expect(rows[0].hash).toBe(hashN(54))
    expect(rows.at(-1)?.hash).toBe(hashN(5))
  })

  it('counts the cap per wallet and chain, so a second wallet evicts nothing', async () => {
    // One flat array backs every wallet, so a global cap would mean connecting a second wallet
    // wipes the first one's history on sight.
    const storage = memoryStorage()
    fill(storage, 50)
    fill(storage, 50, { wallet: OTHER_WALLET }, 1000)

    expect(loadHistory(storage, { wallet: WALLET, chainId: 8453 })).toHaveLength(50)
    expect(loadHistory(storage, { wallet: OTHER_WALLET, chainId: 8453 })).toHaveLength(50)
  })

  it('counts it per chain too', async () => {
    const storage = memoryStorage()
    fill(storage, 50)
    fill(storage, 50, { chainId: 1 }, 2000)

    expect(loadHistory(storage, { wallet: WALLET, chainId: 8453 })).toHaveLength(50)
    expect(loadHistory(storage, { wallet: WALLET, chainId: 1 })).toHaveLength(50)
  })

  it('caps what a chain scan folds in, not just what a flow appends', async () => {
    const storage = memoryStorage()
    const scanned = Array.from({ length: 55 }, (_, i) =>
      entry({ hash: hashN(i), at: 1_800_000_000_000 + i * 1000, source: 'chain', blockNumber: BigInt(i) }),
    )

    mergeHistory(storage, { wallet: WALLET, chainId: 8453, entries: scanned, range: null })

    expect(loadHistory(storage, { wallet: WALLET, chainId: 8453 })).toHaveLength(MAX_HISTORY_PER_SCOPE)
  })
})

describe('the truncation mark', () => {
  const hashN = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`

  it('is not set while a scope still has room', () => {
    const storage = memoryStorage()
    for (let i = 0; i < MAX_HISTORY_PER_SCOPE; i++) {
      appendHistory(storage, entry({ hash: hashN(i), at: 1_800_000_000_000 + i }))
    }

    expect(isScopeTruncated(storage, { wallet: WALLET, chainId: 8453 })).toBe(false)
  })

  it('is set for the scope that started evicting, and only that one', () => {
    const storage = memoryStorage()
    for (let i = 0; i < MAX_HISTORY_PER_SCOPE + 1; i++) {
      appendHistory(storage, entry({ hash: hashN(i), at: 1_800_000_000_000 + i }))
    }
    appendHistory(storage, entry({ hash: hashN(9999), chainId: 1 }))

    expect(isScopeTruncated(storage, { wallet: WALLET, chainId: 8453 })).toBe(true)
    expect(isScopeTruncated(storage, { wallet: WALLET, chainId: 1 })).toBe(false)
  })

  it('is forgotten along with the history it describes', () => {
    const storage = memoryStorage()
    for (let i = 0; i < MAX_HISTORY_PER_SCOPE + 1; i++) {
      appendHistory(storage, entry({ hash: hashN(i), at: 1_800_000_000_000 + i }))
    }

    clearHistory(storage)

    expect(isScopeTruncated(storage, { wallet: WALLET, chainId: 8453 })).toBe(false)
  })
})
