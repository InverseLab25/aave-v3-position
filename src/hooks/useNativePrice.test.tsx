import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

/**
 * The hook prices the CONNECTED chain's native currency, which is not always ether. Two things
 * it has to get right: quote on the chain the user is actually on, and never let one chain's
 * price be read against another — a stale ETH figure shown while Polygon is selected would put a
 * sub-cent transaction at ether rates.
 */
const mocks = vi.hoisted(() => ({
  useChainId: vi.fn(),
  limitedFetch: vi.fn(),
  nordsternQuote: vi.fn(),
}))

vi.mock('wagmi', () => ({ useChainId: mocks.useChainId }))
vi.mock('../adapters/http', () => ({ limitedFetch: mocks.limitedFetch }))
// The second price source. Stubbed at the adapter rather than at the network, because that is
// the seam the hook actually uses — and the adapter is what decides which chains it serves.
vi.mock('../adapters/nordstern', () => ({ nordsternAdapter: { getQuote: mocks.nordsternQuote } }))

import { useNativePrice } from './useNativePrice'

const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const WETH_L2 = '0x4200000000000000000000000000000000000006'
const WETH_ARB = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
const WPOL = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'

/**
 * The price endpoint answers both sides of the book, keyed by chain then token. `PriceBuy` is
 * deliberately different here so a test can tell which one the hook reads.
 */
const priced = (chainId: number, token: string, sell: number) => ({
  ok: true,
  status: 200,
  json: async () => ({ code: 0, data: { [String(chainId)]: { [token]: { PriceBuy: sell * 2, PriceSell: sell } } } }),
})

/** The `{ chainId: [token] }` payload the hook posted on call `n`. */
const bodyOf = (n: number) =>
  JSON.parse((mocks.limitedFetch.mock.calls[n][1] as { body: string }).body) as Record<string, string[]>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.limitedFetch.mockResolvedValue(priced(1, WETH_MAINNET, 1890))
  // Silent by default: the suites below are about the Kyber leg, and a second source answering
  // underneath them would decide their assertions.
  mocks.nordsternQuote.mockResolvedValue(null)
})

afterEach(() => vi.useRealTimers())

describe('useNativePrice — quoting the selected chain', () => {
  it('reads PriceSell, not PriceBuy', async () => {
    // The two differ by over a percent on Base, so picking the wrong one is not a rounding
    // matter. The fixture sets PriceBuy to double PriceSell purely so this test can tell them
    // apart — the real spread is nothing like that.
    const { result } = renderHook(() => useNativePrice(1))

    await waitFor(() => expect(result.current).toBe(1890))
    expect(bodyOf(0)).toEqual({ '1': [WETH_MAINNET] })
  })

  it('asks for each chain\'s own wrapped native, not one address everywhere', async () => {
    renderHook(() => useNativePrice(8453))
    await waitFor(() => expect(mocks.limitedFetch).toHaveBeenCalled())
    expect(bodyOf(0)).toEqual({ '8453': [WETH_L2] })

    mocks.limitedFetch.mockClear()
    renderHook(() => useNativePrice(42161))
    await waitFor(() => expect(mocks.limitedFetch).toHaveBeenCalled())
    expect(bodyOf(0)).toEqual({ '42161': [WETH_ARB] })
  })

  it('returns null for a chain the app no longer configures', async () => {
    // BSC used to live here, and its 18dp USDT was what proved the hook reads each entry's own
    // `decimals` instead of assuming six. Every remaining entry is 6dp, so that guard now has
    // nothing to bite on — if an 18dp chain is ever added back, restore a case like it.
    const { result } = renderHook(() => useNativePrice(56))

    await waitFor(() => expect(result.current).toBeNull())
    expect(mocks.limitedFetch).not.toHaveBeenCalled()
  })

  it('prices Polygon in POL, not in ether', async () => {
    mocks.limitedFetch.mockResolvedValue(priced(137, WPOL, 0.0757))
    const { result } = renderHook(() => useNativePrice(137))

    await waitFor(() => expect(result.current).toBeCloseTo(0.0757, 6))
    expect(bodyOf(0)).toEqual({ '137': [WPOL] })
  })

  it('returns null on a chain it cannot price, so the caller falls back to the oracle', async () => {
    // Sepolia has no real liquidity to quote, so no entry — and no request is spent trying.
    const { result } = renderHook(() => useNativePrice(11155111))

    await waitFor(() => expect(mocks.limitedFetch).not.toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it('falls back to the connected chain when no chainId is passed', async () => {
    mocks.useChainId.mockReturnValue(8453)
    renderHook(() => useNativePrice())

    await waitFor(() => expect(mocks.limitedFetch).toHaveBeenCalled())
    expect(bodyOf(0)).toEqual({ '8453': [WETH_L2] })
  })
})

describe('useNativePrice — switching chains', () => {
  it('re-quotes on the new chain', async () => {
    const { rerender } = renderHook(({ id }) => useNativePrice(id), { initialProps: { id: 1 } })
    await waitFor(() => expect(bodyOf(0)).toEqual({ '1': [WETH_MAINNET] }))

    rerender({ id: 137 })

    await waitFor(() => expect(mocks.limitedFetch.mock.calls.length).toBeGreaterThan(1))
    expect(bodyOf(mocks.limitedFetch.mock.calls.length - 1)).toEqual({ '137': [WPOL] })
  })

  it('stops returning the old chain price the instant the chain changes', async () => {
    // The reason price and chain are stored together. Ether's figure shown against Polygon —
    // even for the one poll it takes to catch up — prices a sub-cent transaction at ~$1,890.
    let resolveNext: ((v: unknown) => void) | undefined
    mocks.limitedFetch
      .mockResolvedValueOnce(priced(1, WETH_MAINNET, 1890))
      .mockImplementationOnce(() => new Promise((r) => { resolveNext = r }))

    const { result, rerender } = renderHook(({ id }) => useNativePrice(id), { initialProps: { id: 1 } })
    await waitFor(() => expect(result.current).toBe(1890))

    rerender({ id: 137 })

    // Polygon's quote has not landed yet, and ether's must not stand in for it.
    expect(result.current).toBeNull()

    resolveNext?.(priced(137, WPOL, 0.0757))
    await waitFor(() => expect(result.current).toBeCloseTo(0.0757, 6))
  })

  it('returns null when switching to a chain it cannot price', async () => {
    const { result, rerender } = renderHook(({ id }) => useNativePrice(id), { initialProps: { id: 1 } })
    await waitFor(() => expect(result.current).toBe(1890))

    rerender({ id: 11155111 })

    expect(result.current).toBeNull()
  })
})

describe('useNativePrice — failure handling', () => {
  it('keeps returning null rather than a partial number when the quote fails', async () => {
    mocks.limitedFetch.mockResolvedValue({ code: 4001 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useNativePrice(1))

    await waitFor(() => expect(mocks.limitedFetch).toHaveBeenCalled())
    expect(result.current).toBeNull()

    spy.mockRestore()
  })

  it('takes the better of the two sources, whichever one it is', async () => {
    // Both are asked for the same thing — what one native token sells for — so the higher figure
    // is the better rate. Nordstern answers with a route, hence USDC wei rather than a price.
    mocks.nordsternQuote.mockResolvedValue({ aggregator: 'Nordstern', amountOut: '1920000000' })
    const { result } = renderHook(() => useNativePrice(1))

    await waitFor(() => expect(result.current).toBe(1920))
  })

  it('keeps the price when one source is down and the other answers', async () => {
    // Halving the number of sources must not cost the caller its price and drop it back to the
    // Aave oracle — either one alone is a usable figure.
    mocks.limitedFetch.mockRejectedValue(new Error('price API down'))
    mocks.nordsternQuote.mockResolvedValue({ aggregator: 'Nordstern', amountOut: '1875500000' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useNativePrice(1))

    await waitFor(() => expect(result.current).toBe(1875.5))
    expect(spy).toHaveBeenCalled()

    spy.mockRestore()
  })

  it('ignores a chain Nordstern does not serve rather than zeroing the price', async () => {
    // The adapter answers null off its own Guard list; that is an absent source, not a price of
    // zero, and a zero would win nothing but would poison a Math.max that took it literally.
    mocks.nordsternQuote.mockResolvedValue(null)
    const { result } = renderHook(() => useNativePrice(1))

    await waitFor(() => expect(result.current).toBe(1890))
  })

  it('survives a thrown request', async () => {
    mocks.limitedFetch.mockRejectedValue(new Error('network down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useNativePrice(1))

    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(result.current).toBeNull()

    spy.mockRestore()
  })
})
