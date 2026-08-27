import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Adapters are the app's only untrusted-input boundary: every field below arrives as JSON from a
 * third party and is then used to size a swap, rank a route, or build calldata a user signs.
 *
 * KyberSwap gets the deepest coverage because it is the only entry in `COMPATIBLE_ADAPTERS` —
 * the open and close flows execute nothing else.
 */
const mocks = vi.hoisted(() => ({
  fetchQuoteJson: vi.fn(),
  limitedFetch: vi.fn(),
}))

vi.mock('./http', async (orig) => ({
  // The error type is real: the adapter branches on `instanceof`, so a stub would make every
  // transport failure look like an ordinary one.
  ...(await orig<Record<string, unknown>>()),
  fetchQuoteJson: mocks.fetchQuoteJson,
  limitedFetch: mocks.limitedFetch,
  clearQuoteCache: vi.fn(),
}))

import { AggregatorHttpError } from './http'
import { isNativeAddress, NATIVE_ADDRESS, NATIVE_ZERO_ADDRESS } from './native'
import { allAdapters, getAdaptersForChain } from './index'
import { kyberSwapAdapter } from './kyberswap'

describe('native sentinel', () => {
  it('recognises the canonical sentinel whatever its casing', () => {
    expect(isNativeAddress(NATIVE_ADDRESS)).toBe(true)
    expect(isNativeAddress(NATIVE_ADDRESS.toLowerCase())).toBe(true)
    expect(isNativeAddress(NATIVE_ADDRESS.toUpperCase())).toBe(true)
  })

  it('does not treat the zero address as native', () => {
    // Odos/DefiLlama use zero as their own native marker, so the two must not be conflated —
    // an adapter translating one into the other is a per-adapter decision, not a global truth.
    expect(isNativeAddress(NATIVE_ZERO_ADDRESS)).toBe(false)
  })

  it('is safe on an absent address', () => {
    expect(isNativeAddress(undefined)).toBe(false)
    expect(isNativeAddress('')).toBe(false)
  })
})

describe('adapter registry', () => {
  it('returns nothing when a chain lists no adapters', () => {
    expect(getAdaptersForChain([])).toEqual([])
  })

  it('ignores names it does not know rather than throwing', () => {
    expect(getAdaptersForChain(['NotAnAggregator'])).toEqual([])
  })

  it('returns only the named adapters', () => {
    const picked = getAdaptersForChain(['KyberSwap'])
    expect(picked.map((a) => a.name)).toEqual(['KyberSwap'])
  })

  it('every registered adapter satisfies the interface the callers assume', () => {
    // `selectBuildableRoute` calls both of these on every candidate; a half-implemented adapter
    // would surface as an unactionable "no route" rather than as the omission it is.
    for (const a of allAdapters) {
      expect(typeof a.name).toBe('string')
      expect(typeof a.supportsExecution).toBe('boolean')
      expect(typeof a.getQuote).toBe('function')
      expect(typeof a.buildTransaction).toBe('function')
    }
  })

  it('has no duplicate adapter names', () => {
    // Names are the registry key AND the allowlist key in COMPATIBLE_ADAPTERS.
    const names = allAdapters.map((a) => a.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

const WETH = { underlyingAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 }
const USDC = {
  underlyingAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  decimals: 6,
  priceInUsd: '1',
}

const routeSummary = (over: Record<string, unknown> = {}) => ({
  amountIn: '1000000000000000000',
  amountInUsd: '3000',
  amountOut: '2990000000',
  amountOutUsd: '2990',
  gas: '250000',
  gasUsd: '12.5',
  route: [[{ pool: '0xpool' }]],
  ...over,
})

describe('KyberSwap — getQuote', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps a successful route onto the shared quote shape', async () => {
    mocks.fetchQuoteJson.mockResolvedValue({ code: 0, data: { routeSummary: routeSummary() } })

    const q = await kyberSwapAdapter.getQuote(WETH, USDC, '1000000000000000000', 0.5, 1)

    expect(q).toMatchObject({
      aggregator: 'KyberSwap',
      amountIn: '1000000000000000000',
      amountOut: '2990000000',
      // 250000 with 20% headroom on top — the aggregator's own number runs short.
      gasEstimate: '300000',
      // gasUsd is NOT padded: it ranks routes against other aggregators, and inflating
      // only KyberSwap's cost would push its routes down for a reason unrelated to price.
      gasUsd: '12.50',
      // The aggregator's own figures, kept untouched for route-cost comparison.
      rawAmountInUsd: '3000',
      rawAmountOutUsd: '2990',
    })
    // Replayed verbatim into buildTransaction — the build rejects anything reshaped.
    expect(q?.rawQuote).toEqual(routeSummary())
  })

  it('re-prices the output against the Aave oracle when one is available', async () => {
    // 2990 USDC at the oracle's $1, not the aggregator's own USD figure. Ranking compares
    // adapters against each other, so it has to use one pricing source for all of them.
    mocks.fetchQuoteJson.mockResolvedValue({
      code: 0,
      data: { routeSummary: routeSummary({ amountOutUsd: '9999' }) },
    })

    const q = await kyberSwapAdapter.getQuote(WETH, USDC, '1000000000000000000', 0.5, 1)

    expect(q?.amountOutUsd).toBe('2990.00')
    // ...while the aggregator's own figure survives untouched alongside it.
    expect(q?.rawAmountOutUsd).toBe('9999')
  })

  it("falls back to the aggregator's USD figure when the asset carries no oracle price", async () => {
    mocks.fetchQuoteJson.mockResolvedValue({ code: 0, data: { routeSummary: routeSummary() } })

    const q = await kyberSwapAdapter.getQuote(WETH, { ...USDC, priceInUsd: undefined }, '1', 0.5, 1)

    expect(q?.amountOutUsd).toBe('2990.00')
  })

  it('nets the gas cost off the return used for ranking', async () => {
    mocks.fetchQuoteJson.mockResolvedValue({ code: 0, data: { routeSummary: routeSummary() } })

    const q = await kyberSwapAdapter.getQuote(WETH, USDC, '1000000000000000000', 0.5, 1)

    expect(q?.netReturnUsd).toBeCloseTo(2990 - 12.5, 6)
    expect(q?.gasUsd).toBe('12.50')
  })

  it('refuses an unsupported chain rather than silently quoting Ethereum', async () => {
    // The hazard this guards: a chain-string fallback would return a mainnet route for a
    // position on another chain, and every downstream number would be plausible and wrong.
    const q = await kyberSwapAdapter.getQuote(WETH, USDC, '1', 0.5, 999999)

    expect(q).toBeNull()
    expect(mocks.fetchQuoteJson).not.toHaveBeenCalled()
  })

  it('returns null on a non-zero response code', async () => {
    mocks.fetchQuoteJson.mockResolvedValue({ code: 4001, data: undefined })
    expect(await kyberSwapAdapter.getQuote(WETH, USDC, '1', 0.5, 1)).toBeNull()
  })

  it('returns null when the payload is missing the route summary', async () => {
    // code 0 with no summary is a shape the API can genuinely return; reading through it would
    // throw inside BigInt() rather than degrade to "no route".
    mocks.fetchQuoteJson.mockResolvedValue({ code: 0, data: {} })
    expect(await kyberSwapAdapter.getQuote(WETH, USDC, '1', 0.5, 1)).toBeNull()
  })

  it('swallows an abort quietly — a superseded quote is not a fault', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    mocks.fetchQuoteJson.mockRejectedValue(abort)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await kyberSwapAdapter.getQuote(WETH, USDC, '1', 0.5, 1)).toBeNull()
    expect(spy).not.toHaveBeenCalled()

    spy.mockRestore()
  })

  it('reports a genuine network failure while still degrading to null', async () => {
    mocks.fetchQuoteJson.mockRejectedValue(new Error('socket hang up'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await kyberSwapAdapter.getQuote(WETH, USDC, '1', 0.5, 1)).toBeNull()
    expect(spy).toHaveBeenCalled()

    spy.mockRestore()
  })

  it('lets a transport failure through instead of dressing it as "no route"', async () => {
    // null is the adapter's word for "this pair has nowhere to trade". A 429 means the opposite:
    // we never got to ask. Callers can only tell them apart if this one escapes.
    mocks.fetchQuoteJson.mockRejectedValue(new AggregatorHttpError(429, 'https://kyber/routes'))

    await expect(kyberSwapAdapter.getQuote(WETH, USDC, '1', 0.5, 1)).rejects.toThrow(
      AggregatorHttpError,
    )
  })

  it('still swallows an abort that arrives as a transport-shaped failure', async () => {
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    mocks.fetchQuoteJson.mockRejectedValue(abort)

    expect(await kyberSwapAdapter.getQuote(WETH, USDC, '1', 0.5, 1, new AbortController().signal))
      .toBeNull()
  })
})

describe('KyberSwap — buildTransaction', () => {
  const quote = { aggregator: 'KyberSwap', rawQuote: routeSummary() } as never
  const WALLET = '0x1111111111111111111111111111111111111111'

  const buildOk = (over: Record<string, unknown> = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({
      code: 0,
      data: {
        routerAddress: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
        data: '0xdeadbeef',
        amountOut: '2985000000',
        outputChange: { percent: -0.17 },
        gas: '250000',
        ...over,
      },
    }),
  })

  beforeEach(() => vi.clearAllMocks())

  it('reports the router as BOTH call target and approval target', async () => {
    // `validateSwapTx` rejects any build where these differ, because the contract approves
    // `spender` and then calls `to` — a mismatch would leave a live allowance to a third party.
    mocks.limitedFetch.mockResolvedValue(buildOk())

    const tx = await kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)

    expect(tx.to).toBe('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5')
    expect(tx.spender).toBe(tx.to)
  })

  it('carries the re-simulated output and its change, which the caller floors against', async () => {
    mocks.limitedFetch.mockResolvedValue(buildOk())

    const tx = await kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)

    expect(tx.amountOut).toBe('2985000000')
    expect(tx.outputChangePercent).toBe(-0.17)
  })

  it('carries the build gas with the same 20% headroom the quote gets', async () => {
    mocks.limitedFetch.mockResolvedValue(buildOk())

    const tx = await kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)

    expect(tx.gasEstimate).toBe('300000')
  })

  it('leaves gas undefined when the build omits it, rather than inventing a floor', async () => {
    mocks.limitedFetch.mockResolvedValue(buildOk({ gas: undefined }))

    const tx = await kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)

    expect(tx.gasEstimate).toBeUndefined()
  })

  it('defaults the value to "0" when the build omits it', async () => {
    // LibCall.callContract sends no ETH, and validateSwapTx rejects a non-zero value — so an
    // absent field must read as zero rather than undefined.
    mocks.limitedFetch.mockResolvedValue(buildOk())

    const tx = await kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)

    expect(tx.value).toBe('0')
  })

  it('converts the slippage percent into the bps the API expects', async () => {
    // 0.5% -> 50 bps. Off by a factor of a hundred either way is a silently mis-floored swap.
    mocks.limitedFetch.mockResolvedValue(buildOk())

    await kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)

    const body = JSON.parse(mocks.limitedFetch.mock.calls[0][1].body)
    expect(body.slippageTolerance).toBe(50)
  })

  it('replays the quote payload verbatim and keeps simulation off', async () => {
    // Both must stay off: the deleverager only holds the collateral mid-flash-loan, so any
    // server-side execution against `sender` reverts and the build returns no calldata at all.
    mocks.limitedFetch.mockResolvedValue(buildOk())

    await kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)

    const body = JSON.parse(mocks.limitedFetch.mock.calls[0][1].body)
    expect(body.routeSummary).toEqual(routeSummary())
    expect(body.skipSimulateTx).toBe(true)
    expect(body.enableGasEstimation).toBeUndefined()
    expect(body.sender).toBe(WALLET)
    expect(body.recipient).toBe(WALLET)
  })

  it('sets a deadline it chose rather than inheriting the API default', async () => {
    mocks.limitedFetch.mockResolvedValue(buildOk())
    const now = Math.floor(Date.now() / 1000)

    await kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)

    const body = JSON.parse(mocks.limitedFetch.mock.calls[0][1].body)
    expect(body.deadline).toBeGreaterThanOrEqual(now + 20 * 60 - 5)
    expect(body.deadline).toBeLessThanOrEqual(now + 20 * 60 + 5)
  })

  it('throws on an unsupported chain instead of building against the wrong network', async () => {
    await expect(kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 999999)).rejects.toThrow(
      /unsupported chain/,
    )
    expect(mocks.limitedFetch).not.toHaveBeenCalled()
  })

  it('names a throttled build as such rather than reading the body as calldata', async () => {
    mocks.limitedFetch.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })

    await expect(kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)).rejects.toThrow(
      AggregatorHttpError,
    )
  })

  it("surfaces the API's own message when the build is refused", async () => {
    // Build failures are actionable — 4227 means the simulation could not transfer from the
    // sender — so the message has to survive rather than becoming a generic failure.
    mocks.limitedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 4227, message: 'TRANSFER_FROM_FAILED' }),
    })

    await expect(kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)).rejects.toThrow(
      'TRANSFER_FROM_FAILED',
    )
  })

  it('throws even when the API returns code 0 with no data', async () => {
    mocks.limitedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) })

    await expect(kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)).rejects.toThrow()
  })
})
