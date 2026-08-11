import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

/**
 * The hook prices the CONNECTED chain's native currency, which is not always ether. Two things
 * it has to get right: quote on the chain the user is actually on, and never let one chain's
 * price be read against another — a stale ETH figure shown while Polygon is selected would put a
 * sub-cent transaction at ether rates.
 */
const mocks = vi.hoisted(() => ({ useChainId: vi.fn(), fetchQuoteJson: vi.fn() }))

vi.mock('wagmi', () => ({ useChainId: mocks.useChainId }))
vi.mock('../adapters/http', () => ({ fetchQuoteJson: mocks.fetchQuoteJson }))

import { useEthPrice } from './useEthPrice'

/** `amountOut` at the stable's decimals — 6 nearly everywhere, 18 on BSC. */
const quote = (amountOut: string) => ({ code: 0, data: { routeSummary: { amountOut } } })

const urlOf = (n: number) => mocks.fetchQuoteJson.mock.calls[n][0] as string

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.fetchQuoteJson.mockResolvedValue(quote('1890000000')) // 1,890 at 6dp
})

afterEach(() => vi.useRealTimers())

describe('useEthPrice — quoting the selected chain', () => {
  it('quotes on Ethereum against USDT', async () => {
    const { result } = renderHook(() => useEthPrice(1))

    await waitFor(() => expect(result.current).toBe(1890))
    expect(urlOf(0)).toContain('/ethereum/')
    expect(urlOf(0)).toContain('0xdAC17F958D2ee523a2206206994597C13D831ec7')
  })

  it('quotes on Base and on Arbitrum against their own stablecoins', async () => {
    renderHook(() => useEthPrice(8453))
    await waitFor(() => expect(mocks.fetchQuoteJson).toHaveBeenCalled())
    expect(urlOf(0)).toContain('/base/')
    expect(urlOf(0)).toContain('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')

    mocks.fetchQuoteJson.mockClear()
    renderHook(() => useEthPrice(42161))
    await waitFor(() => expect(mocks.fetchQuoteJson).toHaveBeenCalled())
    expect(urlOf(0)).toContain('/arbitrum/')
    expect(urlOf(0)).toContain('0xaf88d065e77c8cC2239327C5EDb3A432268e5831')
  })

  it("reads BSC's stablecoin at EIGHTEEN decimals, not six", async () => {
    // BSC's USDT is 18dp. Reading it as 6 would report BNB at roughly a trillion dollars, and
    // the number would look like a real price rather than an obvious error.
    mocks.fetchQuoteJson.mockResolvedValue(quote('612000000000000000000')) // 612 at 18dp
    const { result } = renderHook(() => useEthPrice(56))

    await waitFor(() => expect(result.current).toBe(612))
    expect(urlOf(0)).toContain('/bsc/')
  })

  it('prices Polygon in POL, not in ether', async () => {
    mocks.fetchQuoteJson.mockResolvedValue(quote('75700')) // 0.0757 at 6dp
    const { result } = renderHook(() => useEthPrice(137))

    await waitFor(() => expect(result.current).toBeCloseTo(0.0757, 6))
  })

  it('returns null on a chain it cannot price, so the caller falls back to the oracle', async () => {
    // Sepolia has no real liquidity to quote, so no entry — and no request is spent trying.
    const { result } = renderHook(() => useEthPrice(11155111))

    await waitFor(() => expect(mocks.fetchQuoteJson).not.toHaveBeenCalled())
    expect(result.current).toBeNull()
  })

  it('falls back to the connected chain when no chainId is passed', async () => {
    mocks.useChainId.mockReturnValue(8453)
    renderHook(() => useEthPrice())

    await waitFor(() => expect(mocks.fetchQuoteJson).toHaveBeenCalled())
    expect(urlOf(0)).toContain('/base/')
  })
})

describe('useEthPrice — switching chains', () => {
  it('re-quotes on the new chain', async () => {
    const { rerender } = renderHook(({ id }) => useEthPrice(id), { initialProps: { id: 1 } })
    await waitFor(() => expect(urlOf(0)).toContain('/ethereum/'))

    rerender({ id: 137 })

    await waitFor(() => expect(mocks.fetchQuoteJson.mock.calls.length).toBeGreaterThan(1))
    expect(urlOf(mocks.fetchQuoteJson.mock.calls.length - 1)).toContain('/polygon/')
  })

  it('stops returning the old chain price the instant the chain changes', async () => {
    // The reason price and chain are stored together. Ether's figure shown against Polygon —
    // even for the one poll it takes to catch up — prices a sub-cent transaction at ~$1,890.
    let resolveNext: ((v: unknown) => void) | undefined
    mocks.fetchQuoteJson
      .mockResolvedValueOnce(quote('1890000000'))
      .mockImplementationOnce(() => new Promise((r) => { resolveNext = r }))

    const { result, rerender } = renderHook(({ id }) => useEthPrice(id), { initialProps: { id: 1 } })
    await waitFor(() => expect(result.current).toBe(1890))

    rerender({ id: 137 })

    // Polygon's quote has not landed yet, and ether's must not stand in for it.
    expect(result.current).toBeNull()

    resolveNext?.(quote('75700'))
    await waitFor(() => expect(result.current).toBeCloseTo(0.0757, 6))
  })

  it('returns null when switching to a chain it cannot price', async () => {
    const { result, rerender } = renderHook(({ id }) => useEthPrice(id), { initialProps: { id: 1 } })
    await waitFor(() => expect(result.current).toBe(1890))

    rerender({ id: 11155111 })

    expect(result.current).toBeNull()
  })
})

describe('useEthPrice — failure handling', () => {
  it('keeps returning null rather than a partial number when the quote fails', async () => {
    mocks.fetchQuoteJson.mockResolvedValue({ code: 4001 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useEthPrice(1))

    await waitFor(() => expect(mocks.fetchQuoteJson).toHaveBeenCalled())
    expect(result.current).toBeNull()

    spy.mockRestore()
  })

  it('survives a thrown request', async () => {
    mocks.fetchQuoteJson.mockRejectedValue(new Error('network down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useEthPrice(1))

    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(result.current).toBeNull()

    spy.mockRestore()
  })
})
