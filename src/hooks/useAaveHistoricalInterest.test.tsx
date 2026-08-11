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
