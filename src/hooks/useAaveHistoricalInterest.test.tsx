import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

/**
 * Cost basis is replayed from Aave's transaction history, and two things about that replay were
 * wrong until recently: it read a single page of a PAGINATED endpoint, and it let entries the
 * indexer could not price drag the average entry price toward zero.
 *
 * The query SHAPE is verified against the live api.v3.aave.com endpoint (it returns
 * `{items, pageInfo}` and accepts `$cursor: Cursor`). What these pin is the behaviour on top of
 * it — following the cursor, bounding the loop, and keeping the average honest.
 */
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useChainId: vi.fn(),
  getChainConfig: vi.fn(),
}))

vi.mock('wagmi', () => ({ useConnection: mocks.useConnection, useChainId: mocks.useChainId }))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChainConfig: mocks.getChainConfig,
}))

import { useAaveHistoricalInterest } from './useAaveHistoricalInterest'
import { parseUnits } from 'viem'
import { readHistorySnapshot, writeHistorySnapshot } from '../lib/aaveUserHistory'
import { appendHistory } from '../lib/txHistory'
import type { DelegationStorage } from '../lib/delegationCache'

/**
 * A `localStorage` for the duration of one test.
 *
 * This jsdom setup exposes none at all, and `browserStorage()` correctly reads that as "nothing
 * held" — so without a stub the snapshot path silently does nothing and its tests pass for the
 * wrong reason.
 */
function memoryStorage(): DelegationStorage & { clear: () => void } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  }
}

let storage: ReturnType<typeof memoryStorage>

const USER = '0x1111111111111111111111111111111111111111'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

const supply = (value: string, usdPerToken: number) => ({
  __typename: 'UserSupplyTransaction',
  timestamp: 0,
  amount: { amount: { value }, usd: 0, usdPerToken },
  reserve: { underlyingToken: { address: WETH } },
})

const withdraw = (value: string, usdPerToken: number) => ({
  __typename: 'UserWithdrawTransaction',
  timestamp: 0,
  amount: { amount: { value }, usd: 0, usdPerToken },
  reserve: { underlyingToken: { address: WETH } },
})

/** One GraphQL page. `next` non-null tells the loop to keep going. */
const page = (items: unknown[], next: string | null) => ({
  data: { userTransactionHistory: { items, pageInfo: { next } } },
})

let fetchMock: ReturnType<typeof vi.fn>

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const mount = () => renderHook(() => useAaveHistoricalInterest(), { wrapper })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: USER })
  mocks.useChainId.mockReturnValue(1)
  mocks.getChainConfig.mockReturnValue({
    aave: { poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
  })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => vi.unstubAllGlobals())

/** The cursor sent on request `n`, read back out of the posted body. */
const cursorOf = (n: number) => JSON.parse(fetchMock.mock.calls[n][1].body).variables.cursor

describe('useAaveHistoricalInterest — following the cursor', () => {
  it('stops after one request when there is no next page', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => page([supply('100', 10)], null) })
    const { result } = mount()

    await waitFor(() => expect(result.current.netPrincipals.supply[WETH.toLowerCase()]).toBe(100))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cursorOf(0)).toBeNull()
  })

  it('follows next and accumulates every page', async () => {
    // The defect this fixes: reading page one only produced a plausible-looking average entry
    // price from a truncated ledger, with nothing to indicate anything was missing.
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => page([supply('100', 10)], 'CURSOR_2') })
      .mockResolvedValueOnce({ ok: true, json: async () => page([supply('300', 20)], null) })
    const { result } = mount()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    // Both pages replayed: 400 units, weighted average (100x10 + 300x20) / 400 = 17.50
    await waitFor(() => expect(result.current.netPrincipals.supply[WETH.toLowerCase()]).toBe(400))
    expect(result.current.costBasis.supply[WETH.toLowerCase()].avgEntryPriceUsd).toBeCloseTo(17.5, 6)
  })

  it('sends the cursor it was handed on the following request', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => page([], 'CURSOR_2') })
      .mockResolvedValueOnce({ ok: true, json: async () => page([], null) })
    mount()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(cursorOf(0)).toBeNull()
    expect(cursorOf(1)).toBe('CURSOR_2')
  })

  it('bounds the walk rather than following a cursor forever', async () => {
    // An unbounded loop against a remote API is a worse failure than a truncated basis, so the
    // cap is deliberate. 20 pages.
    fetchMock.mockResolvedValue({ ok: true, json: async () => page([supply('1', 1)], 'ALWAYS_MORE') })
    const { result } = mount()

    await waitFor(() => expect(result.current.isLoadingHistory).toBe(false))
    expect(fetchMock).toHaveBeenCalledTimes(20)
  })

  it('surfaces a transport failure rather than reporting an empty history', async () => {
    // An empty basis and a failed read are not the same thing; conflating them would show a
    // confident P&L computed from nothing.
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) })
    const { result } = mount()

    await waitFor(() => expect(result.current.errorHistory).toBeTruthy())
  })

  it('surfaces a GraphQL error the same way', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: 'Unknown argument "cursor"' }] }),
    })
    const { result } = mount()

    await waitFor(() => expect(result.current.errorHistory).toBeTruthy())
  })
})

describe('useAaveHistoricalInterest — unpriced entries', () => {
  const asset = WETH.toLowerCase()

  it('keeps an unpriced entry out of the average but inside the principal', async () => {
    // The two questions have different answers. An entry the indexer prices at 0 still moved
    // tokens, so it belongs in the principal; folding it into the average at a cost of nothing
    // would halve the entry price here and inflate apparent unrealized gain.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => page([supply('100', 10), supply('100', 0)], null),
    })
    const { result } = mount()

    await waitFor(() => expect(result.current.netPrincipals.supply[asset]).toBe(200))
    expect(result.current.costBasis.supply[asset].avgEntryPriceUsd).toBeCloseTo(10, 6)
  })

  it('averages priced entries by weight', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => page([supply('100', 10), supply('300', 20)], null),
    })
    const { result } = mount()

    await waitFor(() => expect(result.current.netPrincipals.supply[asset]).toBe(400))
    expect(result.current.costBasis.supply[asset].avgEntryPriceUsd).toBeCloseTo(17.5, 6)
  })

  it('leaves the average entry price unchanged across an exit', async () => {
    // Weighted-average cost: selling part of a position realises P&L but does not re-price what
    // remains. Scaling pricedUnits and totalCostUsd by the same factor is what preserves that.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => page([supply('100', 10), withdraw('50', 30)], null),
    })
    const { result } = mount()

    await waitFor(() => expect(result.current.netPrincipals.supply[asset]).toBe(50))
    expect(result.current.costBasis.supply[asset].avgEntryPriceUsd).toBeCloseTo(10, 6)
    // Sold 50 at 30 against a 10 basis — 1,000 realised.
    expect(result.current.costBasis.supply[asset].realizedPnlUsd).toBeCloseTo(1000, 6)
  })
})

describe('useAaveHistoricalInterest — the snapshot', () => {
  const MARKET = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'

  it('prices a position from the last load before the indexer answers', async () => {
    // Everything else on the panel comes off the chain and paints at once — collateral, debt,
    // health factor. Cost basis is the one figure that waits on a third party, which is roughly a
    // second measured against the live endpoint, so the profit column sat blank on every load.
    writeHistorySnapshot(storage, USER, 1, MARKET, [supply('100', 10)], Date.now())
    // Never resolves, so nothing but the snapshot can be answering.
    fetchMock.mockReturnValue(new Promise(() => {}))

    const { result } = mount()

    await waitFor(() =>
      expect(result.current.costBasis.supply[WETH.toLowerCase()].avgEntryPriceUsd).toBe(10),
    )
  })

  it('revalidates anyway, and takes the fresh answer', async () => {
    // The seed is a first frame, not an answer. It is handed to react-query stamped with when it
    // was written, which is always older than the stale window, so the refetch is not optional.
    writeHistorySnapshot(storage, USER, 1, MARKET, [supply('100', 10)], Date.now())
    fetchMock.mockResolvedValue({ ok: true, json: async () => page([supply('100', 40)], null) })

    const { result } = mount()

    await waitFor(() =>
      expect(result.current.costBasis.supply[WETH.toLowerCase()].avgEntryPriceUsd).toBe(40),
    )
    expect(fetchMock).toHaveBeenCalled()
  })

  it('keeps the snapshot up to date for the next load', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => page([supply('100', 40)], null) })

    const { result } = mount()
    await waitFor(() => expect(result.current.costBasis.supply[WETH.toLowerCase()]).toBeDefined())

    expect(readHistorySnapshot(storage, USER, 1, MARKET)?.items).toEqual([supply('100', 40)])
  })

  it('ignores a snapshot from a wallet that is not the one being viewed', async () => {
    writeHistorySnapshot(storage, '0x9999999999999999999999999999999999999999', 1, MARKET, [supply('100', 10)], Date.now())
    fetchMock.mockReturnValue(new Promise(() => {}))

    const { result } = mount()

    await waitFor(() => expect(result.current.isLoadingHistory).toBe(true))
    expect(result.current.costBasis.supply[WETH.toLowerCase()]).toBeUndefined()
  })
})

/**
 * A leveraged open supplies two lots in one transaction and Aave reports them as one supply:
 * what the router bought, and whatever margin the user walked in with. Pricing all of it at the
 * block's oracle read is wrong by the size of the swapped lot, which on a real Base position was
 * about 95 USDC per WETH.
 *
 * The numbers below are that position, in the order it happened.
 */
describe('useAaveHistoricalInterest — pricing the swapped lot at what it filled at', () => {
  const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const open = '0xaa'.padEnd(66, '0') as `0x${string}`

  /** A supply and a borrow in the same transaction — the shape of every leveraged open. */
  const leveragedOpen = (weth: string, wethUsd: number, usdc: string, usdcUsd: number) => [
    {
      __typename: 'UserSupplyTransaction',
      txHash: open,
      timestamp: 0,
      amount: { amount: { value: weth }, usd: 0, usdPerToken: wethUsd },
      reserve: { underlyingToken: { address: WETH } },
    },
    {
      __typename: 'UserBorrowTransaction',
      txHash: open,
      timestamp: 0,
      amount: { amount: { value: usdc }, usd: 0, usdPerToken: usdcUsd },
      reserve: { underlyingToken: { address: USDC } },
    },
  ]

  const recordFill = () =>
    appendHistory(storage, {
      hash: open,
      chainId: 1,
      wallet: USER as `0x${string}`,
      kind: 'open',
      at: 1,
      swap: {
        srcToken: USDC as `0x${string}`,
        dstToken: WETH as `0x${string}`,
        srcSymbol: 'USDC',
        srcDecimals: 6,
        dstSymbol: 'WETH',
        dstDecimals: 18,
        spentAmount: parseUnits('625910.463567', 6),
        returnAmount: parseUnits('257.115702', 18),
      },
      rate: null,
      fill: null,
      deltas: [],
      source: 'chain',
      blockNumber: 1n,
    })

  it('blends the router fill with the margin at its own price', async () => {
    recordFill()
    // 400.5174 WETH supplied, of which the swap bought 257.115702 at 625,910.463567 USDC.
    // The other 143.401698 came from the wallet, and the oracle priced WETH at 2,437 that block.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => page(leveragedOpen('400.5174', 2437, '625910.463567', 1), null),
    })
    const { result } = mount()

    await waitFor(() =>
      expect(result.current.costBasis.supply[WETH.toLowerCase()]?.avgEntryPriceUsd).toBeGreaterThan(0),
    )
    // (257.115702 x 2,434.3533 + 143.401698 x 2,437) / 400.5174
    expect(result.current.costBasis.supply[WETH.toLowerCase()].avgEntryPriceUsd).toBeCloseTo(2435.3009, 3)
  })

  it('leaves the whole supply at the oracle price when no fill was recorded', async () => {
    // Nothing written to history — a wallet whose rows this browser never saw. The lot keeps the
    // indexer's own price rather than being dropped.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => page(leveragedOpen('400.5174', 2437, '625910.463567', 1), null),
    })
    const { result } = mount()

    await waitFor(() =>
      expect(result.current.costBasis.supply[WETH.toLowerCase()]?.avgEntryPriceUsd).toBe(2437),
    )
  })

  it('reports the fill itself, not the fill scaled by the quote token\'s peg', async () => {
    // Aave reads USD₮0 on Arbitrum at 1.00012415. Multiplying by it turned a fill of 2,447.7557
    // USDT per WETH into $2,448.0596 — a number that no longer matches the swap on an explorer,
    // and one that puts the peg's own wobble inside the P&L.
    appendHistory(storage, {
      hash: open,
      chainId: 1,
      wallet: USER as `0x${string}`,
      kind: 'open',
      at: 1,
      swap: {
        srcToken: USDC as `0x${string}`,
        dstToken: WETH as `0x${string}`,
        srcSymbol: 'USDT',
        srcDecimals: 6,
        dstSymbol: 'WETH',
        dstDecimals: 18,
        spentAmount: parseUnits('152291.252939', 6),
        returnAmount: parseUnits('62.216688102949919124', 18),
      },
      rate: null,
      fill: null,
      deltas: [],
      source: 'chain',
      blockNumber: 1n,
    })
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        page(leveragedOpen('62.216688102949919124', 2445.75298943, '152291.252939', 1.00012415), null),
    })
    const { result } = mount()

    await waitFor(() =>
      expect(result.current.costBasis.supply[WETH.toLowerCase()]?.avgEntryPriceUsd).toBeGreaterThan(0),
    )
    expect(result.current.costBasis.supply[WETH.toLowerCase()].avgEntryPriceUsd).toBeCloseTo(2447.7557, 4)
  })

  it('leaves the stablecoin leg on the oracle rather than booking the swap twice', async () => {
    // A fill is ONE fact and both legs can claim it. Applied to both, selling WETH for USDC told
    // the USDC leg those dollars had been bought at $1.0015 apiece and sold at $0.9967 — the
    // WETH/oracle gap re-expressed as a claim about the dollar. On a real Base short that was
    // $3,684 of loss invented on a stablecoin that never moved.
    recordFill()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => page(leveragedOpen('400.5174', 2437, '625910.463567', 1), null),
    })
    const { result } = mount()

    await waitFor(() =>
      expect(result.current.costBasis.borrow[USDC.toLowerCase()]?.avgEntryPriceUsd).toBeGreaterThan(0),
    )
    // Quoted in WETH, which is volatile, so the fill cannot become a dollar price for it.
    expect(result.current.costBasis.borrow[USDC.toLowerCase()].avgEntryPriceUsd).toBe(1)
  })
})

describe('useAaveHistoricalInterest — realized P&L per transaction', () => {
  const exit = '0xbb'.padEnd(66, '0')

  it('books an exit against the transaction it happened in', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        page(
          [
            { ...supply('10', 100), txHash: '0xcc'.padEnd(66, '0') },
            { ...withdraw('4', 150), txHash: exit },
          ],
          null,
        ),
    })
    const { result } = mount()

    // 4 units bought at 100 and sold at 150.
    await waitFor(() => expect(result.current.realizedByTx[exit]).toBeCloseTo(200, 9))
    // The account total says the same thing, because it is the same figures summed.
    expect(result.current.costBasis.supply[WETH.toLowerCase()].realizedPnlUsd).toBeCloseTo(200, 9)
  })

  it('reports what a repaid borrow made, rather than zeroing it', async () => {
    // Buying a debt back below what it was sold for is the ONLY profit a short ever makes. This
    // was hard-zeroed, so every closed short read as though nothing had happened.
    const borrowed = '0xdd'.padEnd(66, '0')
    const repaid = '0xee'.padEnd(66, '0')
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        page(
          [
            {
              __typename: 'UserBorrowTransaction',
              txHash: borrowed,
              timestamp: 0,
              amount: { amount: { value: '10' }, usd: 0, usdPerToken: 2000 },
              reserve: { underlyingToken: { address: WETH } },
            },
            {
              __typename: 'UserRepayTransaction',
              txHash: repaid,
              timestamp: 0,
              amount: { amount: { value: '10' }, usd: 0, usdPerToken: 1900 },
              reserve: { underlyingToken: { address: WETH } },
            },
          ],
          null,
        ),
    })
    const { result } = mount()

    // Sold 10 WETH at 2,000 and bought them back at 1,900. Repaid in full, so the position is
    // over and its result is filed against the closed span rather than against a row that would
    // otherwise describe a borrow of nothing.
    await waitFor(() => expect(result.current.realizedByTx[repaid]).toBeCloseTo(1000, 6))
    expect(result.current.costBasis.borrow[WETH.toLowerCase()].realizedPnlUsd).toBe(0)
  })

  it('leaves a partial exit on the row, because that position is still open', async () => {
    const entry = '0x11'.padEnd(66, '0')
    const half = '0x22'.padEnd(66, '0')
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        page(
          [
            { ...supply('10', 100), txHash: entry },
            { ...withdraw('4', 150), txHash: half },
          ],
          null,
        ),
    })
    const { result } = mount()

    await waitFor(() =>
      expect(result.current.costBasis.supply[WETH.toLowerCase()]?.realizedPnlUsd).toBeCloseTo(200, 6),
    )
  })

  it('does not carry a closed position P&L onto the one opened after it', async () => {
    // The defect: 179,096 of profit from a position exited weeks ago sat on the row describing
    // 400 WETH bought this week, where it read as that position's gain.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        page(
          [
            { ...supply('10', 100), txHash: '0x31'.padEnd(66, '0') },
            { ...withdraw('10', 150), txHash: '0x32'.padEnd(66, '0') },
            { ...supply('4', 200), txHash: '0x33'.padEnd(66, '0') },
          ],
          null,
        ),
    })
    const { result } = mount()

    await waitFor(() => expect(result.current.netPrincipals.supply[WETH.toLowerCase()]).toBe(4))
    const basis = result.current.costBasis.supply[WETH.toLowerCase()]
    // The new position: 4 units at 200, nothing realized against it yet.
    expect(basis.avgEntryPriceUsd).toBe(200)
    expect(basis.realizedPnlUsd).toBe(0)
    // The old position made 500 and is over. That is reported against its own close in Recent
    // activity, not carried onto this row.
    expect(result.current.realizedByTx['0x32'.padEnd(66, '0')]).toBeCloseTo(500, 6)
  })

  it('books nothing against the open that only set the basis', async () => {
    const entry = '0xcc'.padEnd(66, '0')
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => page([{ ...supply('10', 100), txHash: entry }], null),
    })
    const { result } = mount()

    await waitFor(() => expect(result.current.netPrincipals.supply[WETH.toLowerCase()]).toBe(10))
    expect(result.current.realizedByTx[entry]).toBeUndefined()
  })
})

/**
 * Aave's `userTransactionHistory` omits a withdraw whose destination is a CONTRACT, which is
 * every leveraged close: the collateral goes to the strategies contract, is sold there, and the
 * repay comes back out of the proceeds. So the repay is reported and the withdraw never is.
 *
 * Measured on the real Base account this pins: two withdrawals reported out of six, a ledger
 * claiming 700.31 WETH and 885,778 USDC still supplied against an actual 400.52 WETH and nothing,
 * and a short that reported +$2,282.33 of profit on a trade that made $590.
 */
describe('useAaveHistoricalInterest — the withdrawals Aave does not report', () => {
  const USDC_B = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const openHash = '0x8849dbd2'.padEnd(66, '0') as `0x${string}`
  const closeHash = '0x5cb95fb7'.padEnd(66, '0') as `0x${string}`

  const leg = (
    typename: string,
    txHash: string,
    token: string,
    value: string,
    usdPerToken: number,
  ) => ({
    __typename: typename,
    txHash,
    timestamp: 0,
    amount: { amount: { value }, usd: 0, usdPerToken },
    reserve: { underlyingToken: { address: token } },
  })

  /** Sold 220.009706 WETH for 536,836.583970 USDC, then bought it back and repaid. */
  const shortAndClose = () => {
    appendHistory(storage, {
      hash: openHash, chainId: 1, wallet: USER as `0x${string}`, kind: 'open', at: 1,
      swap: {
        srcToken: WETH as `0x${string}`, dstToken: USDC_B as `0x${string}`,
        srcSymbol: 'WETH', srcDecimals: 18, dstSymbol: 'USDC', dstDecimals: 6,
        spentAmount: 220_009_705_635_980_620_942n,
        returnAmount: 536_836_583_970n,
      },
      rate: null, fill: null, deltas: [], source: 'chain', blockNumber: 1n,
    })
    appendHistory(storage, {
      hash: closeHash, chainId: 1, wallet: USER as `0x${string}`, kind: 'close', at: 2,
      swap: {
        srcToken: USDC_B as `0x${string}`, dstToken: WETH as `0x${string}`,
        srcSymbol: 'USDC', srcDecimals: 6, dstSymbol: 'WETH', dstDecimals: 18,
        spentAmount: 885_774_694_285n,
        returnAmount: 363_413_720_352_469_951_876n,
      },
      rate: null, fill: null, deltas: [], source: 'chain', blockNumber: 2n,
    })

    // What the indexer actually returns for these two transactions. Note the absent withdraw.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        page(
          [
            leg('UserSupplyTransaction', openHash, USDC_B, '884491.451262', 0.9999),
            leg('UserBorrowTransaction', openHash, WETH, '220.009705635980620942', 2443.85),
            leg('UserSupplyTransaction', openHash, USDC_B, '1268.469201', 0.9999),
            leg('UserRepayTransaction', closeHash, WETH, '220.012109257666659579', 2429.44085833),
          ],
          null,
        ),
    })
  }

  it('takes the collateral back out, so the position does not stay open forever', async () => {
    shortAndClose()
    const { result } = mount()

    // 885,759.920463 supplied, 885,774.694285 sold. Aave reports none of the second half.
    await waitFor(() => expect(result.current.netPrincipals.supply[USDC_B.toLowerCase()]).toBe(0))
    expect(result.current.netPrincipals.borrow[WETH.toLowerCase()]).toBe(0)
  })

  it('books the short at what it filled at, not at the oracle read on the repay', async () => {
    // Sold at 2,440.0586 and bought back at 2,437.3727, on 220.01 WETH. Pricing the exit at the
    // oracle's 2,429.44 instead reported $2,282.33.
    shortAndClose()
    const { result } = mount()

    await waitFor(() => expect(result.current.realizedByTx[closeHash]).toBeDefined())
    expect(result.current.realizedByTx[closeHash]).toBeCloseTo(590.93, 2)
  })

  it('leaves a withdraw alone once Aave does report one', async () => {
    // The recovery only ever ADDS what is missing, so the day this gap closes nothing is counted
    // twice and the position does not go doubly-negative.
    shortAndClose()
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        page(
          [
            leg('UserSupplyTransaction', openHash, USDC_B, '885759.920463', 0.9999),
            leg('UserBorrowTransaction', openHash, WETH, '220.009705635980620942', 2443.85),
            leg('UserRepayTransaction', closeHash, WETH, '220.012109257666659579', 2429.44085833),
            leg('UserWithdrawTransaction', closeHash, USDC_B, '885774.711938', 0.9999),
          ],
          null,
        ),
    })
    const { result } = mount()

    await waitFor(() => expect(result.current.netPrincipals.supply[USDC_B.toLowerCase()]).toBe(0))
  })
})
