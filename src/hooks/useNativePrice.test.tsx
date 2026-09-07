import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

/**
 * The hook prices the CONNECTED chain's native currency, which is not always ether. Two things
 * it has to get right: quote on the chain the user is actually on, and never let one chain's
 * price be read against another — a stale ETH figure shown while Polygon is selected would put a
 * sub-cent transaction at ether rates.
 *
 * Nordstern is now the only source. It publishes no price endpoint, so a price here IS a swap
 * quote: one native token into the chain's stablecoin, read as USD. Stubbed at the adapter
 * rather than at the network, because that is the seam the hook uses — and the adapter is what
 * decides which chains it serves.
 */
const mocks = vi.hoisted(() => ({
  useChainId: vi.fn(),
  nordsternQuote: vi.fn(),
}))

vi.mock('wagmi', () => ({ useChainId: mocks.useChainId }))
vi.mock('../adapters/nordstern', () => ({ nordsternAdapter: { getQuote: mocks.nordsternQuote } }))

import { useNativePrice } from './useNativePrice'

const USDT_MAINNET = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'

/** A route returning `usd` worth of a 6dp stablecoin for one native token. */
const quoted = (usd: number) => ({ aggregator: 'Nordstern', amountOut: String(usd * 1e6) })

/** The (fromAsset, toAsset, amountIn, slippage, chainId) the hook asked for on call `n`. */
const askOf = (n: number) => {
  const [from, to, amountIn, , chainId] = mocks.nordsternQuote.mock.calls[n]
  return { from: from.underlyingAsset, to: to.underlyingAsset, amountIn, chainId }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.nordsternQuote.mockResolvedValue(quoted(1890))
})

afterEach(() => vi.useRealTimers())

describe('useNativePrice — quoting the selected chain', () => {
  it('prices one whole native token against that chain\'s own stablecoin', async () => {
    const { result } = renderHook(() => useNativePrice(1))

    await waitFor(() => expect(result.current).toBe(1890))
    expect(askOf(0)).toMatchObject({ to: USDT_MAINNET, amountIn: '1000000000000000000', chainId: 1 })
  })

  it('prices Polygon in POL, not in ether', async () => {
    // The whole reason this stopped being called `useEthPrice`. Quoting mainnet everywhere
    // valued a sub-cent Polygon transaction at ether rates.
    renderHook(() => useNativePrice(137))

    await waitFor(() => expect(mocks.nordsternQuote).toHaveBeenCalled())
    expect(askOf(0)).toMatchObject({ to: USDC_POLYGON, chainId: 137 })
  })

  it('spends no request on a chain with nothing to price against', async () => {
    // Sepolia has no real liquidity, so no stablecoin entry — and no poll left running behind a
    // source that could only ever answer null.
    const { result } = renderHook(() => useNativePrice(11155111))

    await waitFor(() => expect(mocks.nordsternQuote).not.toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it('falls back to the connected chain when no chainId is passed', async () => {
    mocks.useChainId.mockReturnValue(8453)
    renderHook(() => useNativePrice())

    await waitFor(() => expect(mocks.nordsternQuote).toHaveBeenCalled())
    expect(askOf(0)).toMatchObject({ to: USDC_BASE, chainId: 8453 })
  })
})

describe('useNativePrice — switching chains', () => {
  it('re-quotes on the new chain', async () => {
    const { rerender } = renderHook(({ id }) => useNativePrice(id), { initialProps: { id: 1 } })
    await waitFor(() => expect(askOf(0)).toMatchObject({ chainId: 1 }))

    rerender({ id: 137 })

    await waitFor(() => expect(mocks.nordsternQuote.mock.calls.length).toBeGreaterThan(1))
    expect(askOf(mocks.nordsternQuote.mock.calls.length - 1)).toMatchObject({ chainId: 137 })
  })

  it('stops returning the old chain price the instant the chain changes', async () => {
    // The reason price and chain are stored together. Ether's figure shown against Polygon —
    // even for the one poll it takes to catch up — prices a sub-cent transaction at ~$1,890.
    let resolveNext: ((v: unknown) => void) | undefined
    mocks.nordsternQuote
      .mockResolvedValueOnce(quoted(1890))
      .mockImplementationOnce(() => new Promise((r) => { resolveNext = r }))

    const { result, rerender } = renderHook(({ id }) => useNativePrice(id), { initialProps: { id: 1 } })
    await waitFor(() => expect(result.current).toBe(1890))

    rerender({ id: 137 })

    // Polygon's quote has not landed yet, and ether's must not stand in for it.
    expect(result.current).toBeNull()

    resolveNext?.(quoted(0.0757))
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
  it('returns null rather than zero on a chain Nordstern does not serve', async () => {
    // The adapter answers null off its own Guard list. That is an absent source, not a price of
    // zero — and a zero reaching a caller multiplying by it reads as a free transaction.
    mocks.nordsternQuote.mockResolvedValue(null)
    const { result } = renderHook(() => useNativePrice(1))

    await waitFor(() => expect(mocks.nordsternQuote).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it('survives a thrown request, and says so', async () => {
    // Now the only source, so a silent failure drops every caller onto the Aave oracle with
    // nothing to explain why. The console line is the only trace there is.
    mocks.nordsternQuote.mockRejectedValue(new Error('network down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useNativePrice(1))

    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(result.current).toBeNull()

    spy.mockRestore()
  })
})
