import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import {
  MAX_HISTORY_PAGES,
  MAX_SNAPSHOT_AGE_MS,
  fetchUserHistory,
  readHistorySnapshot,
  userHistoryQuery,
  userHistoryQueryKey,
  writeHistorySnapshot,
  type HistoryItem,
} from './aaveUserHistory'
import type { DelegationStorage } from './delegationCache'

const USER = '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600' as Address
const MARKET = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' as Address
const req = { user: USER, chainId: 8453, market: MARKET }

const page = (items: unknown[], next: string | null = null) => ({
  ok: true,
  json: async () => ({ data: { userTransactionHistory: { items, pageInfo: { next } } } }),
})

const hash = (txHash: string) => ({ __typename: 'UserSupplyTransaction', txHash })

/** A `localStorage` that lives for one test. */
function memoryStorage(): DelegationStorage {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchUserHistory — following the cursor', () => {
  it('follows the cursor to the end', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([hash('0xaa')], 'cursor-1'))
      .mockResolvedValueOnce(page([hash('0xbb')], null))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchUserHistory(req)).toEqual([hash('0xaa'), hash('0xbb')])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sends the cursor it was handed on the following request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([], 'cursor-1'))
      .mockResolvedValueOnce(page([], null))
    vi.stubGlobal('fetch', fetchMock)

    await fetchUserHistory(req)

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).variables.cursor).toBeNull()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.cursor).toBe('cursor-1')
  })

  it('stops following an endless cursor', async () => {
    // An unbounded loop against a remote API is a worse failure than a truncated list.
    const fetchMock = vi.fn().mockResolvedValue(page([hash('0xaa')], 'always-more'))
    vi.stubGlobal('fetch', fetchMock)

    await fetchUserHistory(req)

    expect(fetchMock).toHaveBeenCalledTimes(MAX_HISTORY_PAGES)
  })

  it('throws rather than returning a short list', async () => {
    // `hashSync` records a verdict per hash it examined, and the basis averages what it is given.
    // A silently truncated list would corrupt both.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }))

    await expect(fetchUserHistory(req)).rejects.toThrow('429')
  })

  it('reports a GraphQL-level error too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'unknown market' }] }),
    }))

    await expect(fetchUserHistory(req)).rejects.toThrow('unknown market')
  })
})

describe('fetchUserHistory — what it asks for', () => {
  const sentQuery = async () => {
    const fetchMock = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('fetch', fetchMock)
    await fetchUserHistory(req)
    return JSON.parse(fetchMock.mock.calls[0][1].body).query as string
  }

  it('asks for the movements a close appears as, not just an open', async () => {
    // Verified against a real Base account: its close showed up as a Repay and NOTHING else.
    const sent = await sentQuery()

    expect(sent).toContain('UserSupplyTransaction')
    expect(sent).toContain('UserBorrowTransaction')
    expect(sent).toContain('UserWithdrawTransaction')
    expect(sent).toContain('UserRepayTransaction')
  })

  it('asks for liquidations, which the basis has to realize P&L against', async () => {
    // Discovery does not want these. It drops them in `positionHashes` instead, which is what
    // lets one query serve both readers.
    expect(await sentQuery()).toContain('UserLiquidationCallTransaction')
  })

  it('asks for the hash and the amount together, so neither reader needs its own request', async () => {
    const sent = await sentQuery()

    expect(sent).toContain('txHash')
    expect(sent).toContain('usdPerToken')
  })
})

describe('userHistoryQueryKey', () => {
  it('is the same key whatever casing the caller holds the address in', () => {
    // The two readers get their addresses from different places — one from wagmi, one from a view
    // prop. A casing difference would put them on separate cache entries and quietly restore the
    // duplicate request this merge exists to remove.
    expect(userHistoryQueryKey(USER, 8453, MARKET)).toEqual(
      userHistoryQueryKey(USER.toLowerCase(), 8453, MARKET.toLowerCase()),
    )
  })

  it('separates markets, chains and wallets', () => {
    expect(userHistoryQueryKey(USER, 8453, MARKET)).not.toEqual(userHistoryQueryKey(USER, 1, MARKET))
  })
})

describe('history snapshot', () => {
  let storage: DelegationStorage
  const items: HistoryItem[] = [hash('0xaa')]

  beforeEach(() => {
    storage = memoryStorage()
  })

  it('reads back what it wrote', () => {
    writeHistorySnapshot(storage, USER, 8453, MARKET, items, 1_000)

    expect(readHistorySnapshot(storage, USER, 8453, MARKET, 1_000)).toEqual({
      items,
      updatedAt: 1_000,
    })
  })

  it('does not hand one wallet another wallet history', () => {
    writeHistorySnapshot(storage, USER, 8453, MARKET, items, 1_000)
    const other = '0x1111111111111111111111111111111111111111'

    expect(readHistorySnapshot(storage, other, 8453, MARKET, 1_000)).toBeNull()
  })

  it('keeps chains apart', () => {
    writeHistorySnapshot(storage, USER, 8453, MARKET, items, 1_000)

    expect(readHistorySnapshot(storage, USER, 1, MARKET, 1_000)).toBeNull()
  })

  it('refuses a snapshot old enough to describe a position that has since closed', () => {
    writeHistorySnapshot(storage, USER, 8453, MARKET, items, 0)

    expect(readHistorySnapshot(storage, USER, 8453, MARKET, MAX_SNAPSHOT_AGE_MS + 1)).toBeNull()
  })

  it('keeps one that is still inside the window', () => {
    writeHistorySnapshot(storage, USER, 8453, MARKET, items, 0)

    expect(readHistorySnapshot(storage, USER, 8453, MARKET, MAX_SNAPSHOT_AGE_MS - 1)).not.toBeNull()
  })

  it('survives storage holding something that is not a snapshot', () => {
    // A cache is an optimisation. Corrupt contents cost one load with a blank profit column.
    storage.setItem('defi-route.aavehistory.v1', 'not json')

    expect(readHistorySnapshot(storage, USER, 8453, MARKET)).toBeNull()
  })

  it('treats no storage at all as nothing held', () => {
    expect(readHistorySnapshot(null, USER, 8453, MARKET)).toBeNull()
    expect(() => writeHistorySnapshot(null, USER, 8453, MARKET, items)).not.toThrow()
  })
})

describe('userHistoryQuery', () => {
  it('writes a snapshot as a side effect of fetching, so the next load has a first frame', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([hash('0xaa')])))
    const storage = memoryStorage()

    const result = await userHistoryQuery(storage, USER, 8453, MARKET).queryFn({})

    expect(result).toEqual([hash('0xaa')])
    expect(readHistorySnapshot(storage, USER, 8453, MARKET)?.items).toEqual([hash('0xaa')])
  })

  it('leaves the last good snapshot alone when the fetch fails', async () => {
    const storage = memoryStorage()
    writeHistorySnapshot(storage, USER, 8453, MARKET, [hash('0xold')], Date.now())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))

    await expect(userHistoryQuery(storage, USER, 8453, MARKET).queryFn({})).rejects.toThrow('500')
    expect(readHistorySnapshot(storage, USER, 8453, MARKET)?.items).toEqual([hash('0xold')])
  })
})
