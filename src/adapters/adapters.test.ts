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
import { isSmartSettlement, kyberSwapAdapter } from './kyberswap'
import { nordsternAdapter } from './nordstern'
import { socketAdapter } from './socket'

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
      // The aggregator's own figure, unpadded. It is unreliable in BOTH directions — measured
      // 169% under on one route and ~11% over on another — so nothing here may inflate it: this
      // number reaches `validateSwapTx`, where over-stating costs a route that would have run.
      gasEstimate: '250000',
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

  it('carries the build gas as reported, so the cap check judges the real figure', async () => {
    // Padding this 20% rejected a 1,000,000 USDC route five times in six: the route measured
    // 13.2M against a 16,777,216 cap, and the pad — not the route — put it over.
    mocks.limitedFetch.mockResolvedValue(buildOk())

    const tx = await kyberSwapAdapter.buildTransaction(quote, 0.5, WALLET, 1)

    expect(tx.gasEstimate).toBe('250000')
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

describe('isSmartSettlement', () => {
  const hop = (extra?: { _ce?: unknown }) => ({ tokenIn: '0xa', tokenOut: '0xb', swapAmount: '1', extra })

  it('is true when any hop anywhere in the split carries _ce', () => {
    // Kyber marks maker-settled hops with `extra._ce` and buffers gas 50% on it. One hop is
    // enough — the whole transaction pays for the settlement machinery.
    expect(isSmartSettlement([[hop()], [hop(), hop({ _ce: 1 })]])).toBe(true)
  })

  it('is false when nothing does', () => {
    expect(isSmartSettlement([[hop()], [hop(), hop({})]])).toBe(false)
    expect(isSmartSettlement([])).toBe(false)
  })
})

describe('Nordstern — the Guard check', () => {
  const WETH_B = { underlyingAsset: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }
  const USDC_B = { underlyingAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }
  const GUARD = '0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d'
  const quote = { aggregator: 'Nordstern', rawQuote: { src: USDC_B.underlyingAsset, dst: WETH_B.underlyingAsset, amount: '1000000000' } } as never
  const reply = (to: string) => ({ ok: true, status: 200, json: async () => ({ toAmount: '409473892950776899', gasEstimate: '141103', tx: { to, data: '0xfeed', value: 0 } }) })

  beforeEach(() => vi.clearAllMocks())

  it('refuses a build that targets anything but the Guard', async () => {
    // Their docs ask integrators to check this, and on the plain-swap screen we have nothing
    // else: `to` and `spender` go straight to the user's wallet to approve and call, with no
    // on-chain allowlist behind them.
    mocks.limitedFetch.mockResolvedValue(reply('0x000000000000000000000000000000000000dEaD'))
    await expect(nordsternAdapter.buildTransaction(quote, 0.5, GUARD, 8453))
      .rejects.toThrow(/not the Guard/)
  })

  it('accepts the Guard, and makes it the approval target too', async () => {
    // The Guard pulls with `transferFrom(msg.sender, …)`, so call target and approval target are
    // one address. `validateSwapTx` rejects a build where they differ.
    mocks.limitedFetch.mockResolvedValue(reply(GUARD))
    const tx = await nordsternAdapter.buildTransaction(quote, 0.5, GUARD, 8453)
    expect(tx.to).toBe(GUARD)
    expect(tx.spender).toBe(tx.to)
  })

  it('reports the split the way the route panel already renders one', async () => {
    // Trimmed from a live Base response: two paths, 95.6% through one pool and 4.4% through
    // three. `hops: n` said nothing the panel could draw, so the fold rendered empty.
    mocks.fetchQuoteJson.mockResolvedValue({
      toAmount: '2472325837',
      gasEstimate: '280263',
      swaps: [
        {
          amountIn: '956277194740797864',
          route: [{
            tokenIn: WETH_B.underlyingAsset, tokenOut: USDC_B.underlyingAsset,
            amountIn: '956277194740797824', type: 'elfomofi', pool: '0xc1b1',
          }],
        },
        {
          amountIn: '43722805259202136',
          route: [
            { tokenIn: WETH_B.underlyingAsset, tokenOut: '0xEeee', amountIn: '43722805259202136', type: 'native_wrapping' },
            { tokenIn: '0xEeee', tokenOut: '0xcbB7', amountIn: '43722775822343824', type: 'uniswap_v4' },
            { tokenIn: '0xcbB7', tokenOut: USDC_B.underlyingAsset, amountIn: '136952', type: 'elfomofi' },
          ],
        },
      ],
    })

    const q = await nordsternAdapter.getQuote(WETH_B, USDC_B, '1000000000000000000', 0.5, 8453)
    const details = q?.routeDetails
    if (details?.type !== 'nordstern') throw new Error('expected a nordstern split')

    expect(details.totalAmountIn).toBe(1000000000000000000n)
    expect(details.paths.map((p) => p.length)).toEqual([1, 3])
    // The share the panel prints, taken off the first leg of each path.
    expect(details.paths.map((p) => Number((BigInt(p[0].swapAmount) * 10000n) / details.totalAmountIn) / 100))
      .toEqual([95.62, 4.37])
    expect(details.paths[1][1].exchange).toBe('uniswap_v4')
  })

  it('does not quote on a chain with no Guard listed', async () => {
    expect(await nordsternAdapter.getQuote(USDC_B, WETH_B, '1000000000', 0.5, 1)).toBeNull()
  })
})

describe('Socket — same-chain routing', () => {
  const WETH_B = { underlyingAsset: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }
  const USDC_B = { underlyingAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }
  const ALLOWANCE_HOLDER = '0x50c4E75a512F2A14A7b304787Adf79C4531A5909'
  const CALLER = '0x253FaC550bae1EE9B4680b3735DC38a3f6eCd600'
  const STRATEGIES = '0x75b1ab12e47aaee4e1033100de1992e735c32c9c'
  /** The arguments every `getQuotes` case shares. */
  const ask = (over: Record<string, unknown> = {}) => ({
    fromAsset: WETH_B, toAsset: USDC_B, amountIn: '1000000000000000000',
    slippage: 0.5, chainId: 8453, caller: CALLER, ...over,
  })

  /** One route, in the shape `/v3/swap/quote` answers with. */
  const route = (over: Record<string, unknown> = {}) => ({
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    output: { amount: '2472325837', valueInUsd: 2472.32 },
    routeDetails: { dexDetails: { protocol: { displayName: 'Kyberswap' } } },
    approval: { spenderAddress: ALLOWANCE_HOLDER },
    txData: { kind: 'evm_tx', object: { to: ALLOWANCE_HOLDER, data: '0xfeed', value: '0' } },
    gasFee: { gasLimit: '650000', feeInUsd: 0.01 },
    ...over,
  })

  const quoted = { aggregator: 'Socket', rawQuote: {
    chainId: 8453,
    inputToken: WETH_B.underlyingAsset,
    outputToken: USDC_B.underlyingAsset,
    inputAmount: '1000000000000000000',
  } } as never

  beforeEach(() => vi.clearAllMocks())

  it('takes the route with the most output, not the one listed first', async () => {
    // Socket returns several and tags its own favourite; this app ranks every aggregator on
    // output, so it picks on the same basis inside Socket as it does across the others.
    mocks.fetchQuoteJson.mockResolvedValue({
      success: true,
      result: {
        input: { amount: '1000000000000000000', valueInUsd: 2475 },
        routes: [route(), route({ output: { amount: '2480000000', valueInUsd: 2480 } })],
      },
    })

    const q = await socketAdapter.getQuote(WETH_B, USDC_B, '1000000000000000000', 0.5, 8453)

    expect(q?.amountOut).toBe('2480000000')
    // Both sides priced, so the route-cost percentage has something to work with.
    expect(q?.rawAmountInUsd).toBe('2475')
    expect(q?.rawAmountOutUsd).toBe('2480')
  })

  it('offers every route separately, best output first', async () => {
    // One Socket request answers with a route per underlying aggregator. Keeping only the best
    // throws away the field the solver is supposed to rank: its 0x route and its Bitget route
    // are as different from each other as Nordstern is from either.
    mocks.fetchQuoteJson.mockResolvedValue({
      result: {
        input: { amount: '1000000000000000000', valueInUsd: 2475 },
        routes: [
          route({ routeDetails: { dexDetails: { protocol: { displayName: 'Fynd' } } } }),
          route({ output: { amount: '2480000000' }, routeDetails: { dexDetails: { protocol: { displayName: '0x' } } } }),
        ],
      },
    })

    const qs = await socketAdapter.getQuotes!(ask())

    expect(qs.map((q) => q.amountOut)).toEqual(['2480000000', '2472325837'])
    // All still `Socket`, because that is the key COMPATIBLE_ADAPTERS matches on. The row is
    // told apart by the protocol underneath.
    expect(qs.every((q) => q.aggregator === 'Socket')).toBe(true)
    // The venue is the row's identity now, not a subtitle: it keys the measurement and the pin.
    expect(qs.map((q) => q.routeId)).toEqual(['0x', 'Fynd'])
  })

  it('asks once for the whole field', async () => {
    // Per-route requests would multiply the slowest call in the loop by the size of the field.
    mocks.fetchQuoteJson.mockResolvedValue({ result: { routes: [route(), route(), route()] } })

    await socketAdapter.getQuotes!(ask())

    expect(mocks.fetchQuoteJson).toHaveBeenCalledTimes(1)
  })

  it('carries each route transaction, so building costs no request', async () => {
    // The quote is already addressed to the real caller here, unlike `getQuote`'s placeholder
    // round, so its calldata is executable as returned. Re-asking would spend the most
    // expensive call in the loop again for an answer already in hand.
    mocks.fetchQuoteJson.mockResolvedValue({ result: { routes: [route()] } })

    const [q] = await socketAdapter.getQuotes!(ask())
    vi.clearAllMocks()
    const tx = await socketAdapter.buildTransaction(q, 0.5, CALLER, 8453)

    expect(mocks.limitedFetch).not.toHaveBeenCalled()
    expect(tx).toMatchObject({ to: ALLOWANCE_HOLDER, data: '0xfeed', spender: ALLOWANCE_HOLDER })
  })

  it('re-asks when the transaction in hand was addressed to someone else', async () => {
    // Socket bakes the caller into the calldata and reverts with CallerNotSignedUser for anyone
    // else, so a prebuilt route is only reusable by the caller it was quoted for.
    mocks.fetchQuoteJson.mockResolvedValue({ result: { routes: [route()] } })
    const [q] = await socketAdapter.getQuotes!(ask())

    mocks.limitedFetch.mockResolvedValue({ ok: true, json: async () => ({ result: { routes: [route()] } }) })
    await socketAdapter.buildTransaction(q, 0.5, '0x9999999999999999999999999999999999999999', 8453)

    expect(mocks.limitedFetch).toHaveBeenCalledTimes(1)
  })

  it('leaves out routes that carry no EVM transaction', async () => {
    // Socket also answers for Solana and friends. A route with nothing this app can submit is
    // not a candidate, and including it would have it ranked and then rejected at build.
    mocks.fetchQuoteJson.mockResolvedValue({
      result: { routes: [route({ txData: { kind: 'svm_instructions' } }), route()] },
    })

    const qs = await socketAdapter.getQuotes!(ask())

    expect(qs).toHaveLength(1)
  })

  it('leaves out routes that have already expired', async () => {
    mocks.fetchQuoteJson.mockResolvedValue({
      result: { routes: [route({ expiresAt: Math.floor(Date.now() / 1000) - 1 }), route()] },
    })

    const qs = await socketAdapter.getQuotes!(ask())

    expect(qs).toHaveLength(1)
  })

  it('never sends contractCaller, which the endpoint discards', async () => {
    // Proven against the live public endpoint: the calldata comes back byte-identical with and
    // without the parameter, quoteId aside, and a contract executing it still reverts with
    // CallerNotSignedUser. Sending it only made the case look handled.
    mocks.fetchQuoteJson.mockResolvedValue({ result: { routes: [route()] } })

    await socketAdapter.getQuotes!(ask({ caller: STRATEGIES }))

    expect(mocks.fetchQuoteJson.mock.calls[0][0] as string).not.toContain('contractCaller')
  })

  it('quotes same-chain only, with the caller on both ends of the trade', async () => {
    mocks.fetchQuoteJson.mockResolvedValue({ result: { routes: [route()] } })

    await socketAdapter.getQuote(WETH_B, USDC_B, '1000000000000000000', 0.5, 8453)

    const url = mocks.fetchQuoteJson.mock.calls[0][0] as string
    expect(url).toContain('originChainId=8453')
    expect(url).toContain('destinationChainId=8453')
    // A decimal percentage, not basis points.
    expect(url).toContain('slippage=0.5')
    // Off: Socket's own simulation runs serially before it answers, and this app measures its
    // own top candidates anyway.
    expect(url).toContain('simulatedQuotesRequired=false')
    expect(url).toContain('quoteType=EXACT_INPUT')
  })

  it('reads the routes out of the envelope the live API actually returns', async () => {
    // The published example shows a bare object; the API wraps it in { success, result }.
    // Reading the top level found nothing, so the adapter answered null on every call and
    // Socket simply never appeared in the list.
    mocks.fetchQuoteJson.mockResolvedValue({ routes: [route()] })
    expect(await socketAdapter.getQuote(WETH_B, USDC_B, '1000000000000000000', 0.5, 8453)).toBeNull()

    mocks.fetchQuoteJson.mockResolvedValue({ success: true, result: { routes: [route()] } })
    const q = await socketAdapter.getQuote(WETH_B, USDC_B, '1000000000000000000', 0.5, 8453)
    expect(q?.amountOut).toBe('2472325837')
    // Socket routes through other aggregators; the row names the one underneath.
    expect(q?.routeId).toBe('Kyberswap')
    expect(q?.routeDetails).toMatchObject({ type: 'socket', info: 'Routed via Socket' })
  })

  it('does not quote on a chain Socket does not serve', async () => {
    expect(await socketAdapter.getQuote(WETH_B, USDC_B, '1000000000000000000', 0.5, 999)).toBeNull()
    expect(mocks.fetchQuoteJson).not.toHaveBeenCalled()
  })

  it('approves the contract it calls, which is what makes the route executable at all', async () => {
    // Socket wraps the router call inside the AllowanceHolder's calldata, so the approval target
    // and the call target are one address. `validateSwapTx` rejects a build where they differ.
    mocks.limitedFetch.mockResolvedValue({ ok: true, json: async () => ({ result: { routes: [route()] } }) })

    const tx = await socketAdapter.buildTransaction(quoted, 0.5, ALLOWANCE_HOLDER, 8453)

    expect(tx.to).toBe(ALLOWANCE_HOLDER)
    expect(tx.spender).toBe(tx.to)
  })

  it('needs no approval target of its own when the input is the native token', async () => {
    mocks.limitedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: { routes: [route({ approval: null })] } }),
    })

    const tx = await socketAdapter.buildTransaction(quoted, 0.5, ALLOWANCE_HOLDER, 8453)

    expect(tx.spender).toBe(tx.to)
  })

  it('refuses an expired route rather than letting the chain charge for it', async () => {
    mocks.limitedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: { routes: [route({ expiresAt: Math.floor(Date.now() / 1000) - 1 })] } }),
    })

    await expect(socketAdapter.buildTransaction(quoted, 0.5, ALLOWANCE_HOLDER, 8453))
      .rejects.toThrow(/expired/)
  })

  it('refuses anything that is not a plain EVM transaction', async () => {
    // Socket also answers for Solana, Sui, Tron and Bitcoin, none of which this app can submit.
    mocks.limitedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: { routes: [route({ txData: { kind: 'svm_instructions', object: { to: 'x', data: '0x1', value: '0' } } })] } }),
    })

    await expect(socketAdapter.buildTransaction(quoted, 0.5, ALLOWANCE_HOLDER, 8453))
      .rejects.toThrow(/not an EVM transaction/)
  })
})
