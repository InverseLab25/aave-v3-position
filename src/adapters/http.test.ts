import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AggregatorHttpError, fetchQuoteJson, limitedFetch, clearQuoteCache, resetHttpGate,
} from './http'

const KYBER = 'https://aggregator-api.kyberswap.com/ethereum/api/v1/routes'

describe('fetchQuoteJson', () => {
  beforeEach(() => {
    resetHttpGate()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('de-duplicates concurrent requests for the same URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0, n: 1 }) })
    vi.stubGlobal('fetch', fetchMock)

    const [a, b, c] = await Promise.all([
      fetchQuoteJson(`${KYBER}?amountIn=1`),
      fetchQuoteJson(`${KYBER}?amountIn=1`),
      fetchQuoteJson(`${KYBER}?amountIn=1`),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('reuses a completed response inside the TTL and refetches after it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) })
    vi.stubGlobal('fetch', fetchMock)

    await fetchQuoteJson(`${KYBER}?amountIn=2`)
    await fetchQuoteJson(`${KYBER}?amountIn=2`)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4_001)
    await fetchQuoteJson(`${KYBER}?amountIn=2`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats different amountIn as different requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) })
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([
      fetchQuoteJson(`${KYBER}?amountIn=1`),
      fetchQuoteJson(`${KYBER}?amountIn=2`),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed request', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchQuoteJson(`${KYBER}?amountIn=3`)).rejects.toThrow('network')
    await fetchQuoteJson(`${KYBER}?amountIn=3`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not share an abortable request, so one caller cannot cancel another', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) })
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    await Promise.all([
      fetchQuoteJson(`${KYBER}?amountIn=9`),
      fetchQuoteJson(`${KYBER}?amountIn=9`, { signal: controller.signal }),
    ])

    // The plain one may be cached; the abortable one must have gone to the network on its own.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clearQuoteCache forces the next identical request back to the network', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) })
    vi.stubGlobal('fetch', fetchMock)

    await fetchQuoteJson(`${KYBER}?amountIn=4`)
    clearQuoteCache()
    await fetchQuoteJson(`${KYBER}?amountIn=4`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('HTTP failures are distinguishable from a missing route', () => {
  beforeEach(() => {
    resetHttpGate()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('throws rather than parsing a non-2xx body', async () => {
    // Previously this went straight to res.json(): an HTML error page became a SyntaxError and a
    // JSON one became `code !== 0`. Both reached the user as "no route can price this pair".
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ message: 'rate limit exceeded' }),
    }))

    await expect(fetchQuoteJson(`${KYBER}?amountIn=9`)).rejects.toThrow(AggregatorHttpError)
  })

  it('marks a rate limit and a server fault as worth retrying, and a bad request as not', async () => {
    const at = async (status: number) => {
      resetHttpGate()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) }))
      return fetchQuoteJson(`${KYBER}?amountIn=${status}`).catch((e: unknown) => e)
    }

    expect(((await at(429)) as AggregatorHttpError).retryable).toBe(true)
    expect(((await at(502)) as AggregatorHttpError).retryable).toBe(true)
    // The pair or the amount is wrong; asking again changes nothing.
    expect(((await at(400)) as AggregatorHttpError).retryable).toBe(false)
  })

  it('carries the status, so a caller can say which failure it was', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }))

    const err = (await fetchQuoteJson(`${KYBER}?amountIn=10`).catch((e: unknown) => e)) as AggregatorHttpError
    expect(err.status).toBe(503)
  })

  it('does not cache the failure — the next ask hits the network again', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await fetchQuoteJson(`${KYBER}?amountIn=11`).catch(() => null)
    await fetchQuoteJson(`${KYBER}?amountIn=11`).catch(() => null)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('applies to abortable requests too, which skip the cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))

    await expect(
      fetchQuoteJson(`${KYBER}?amountIn=12`, { signal: new AbortController().signal }),
    ).rejects.toThrow(AggregatorHttpError)
  })
})

describe('rate limiting', () => {
  beforeEach(() => {
    resetHttpGate()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('allows at most 6 requests per second to one origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    // Distinct URLs so the quote cache can't collapse them.
    const inFlight = Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => limitedFetch(`${KYBER}?amountIn=${i}`)),
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(6)

    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(8)

    await inFlight
  })

  it('meters origins independently', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    const inFlight = Promise.all([
      ...[1, 2, 3, 4, 5, 6].map((i) => limitedFetch(`${KYBER}?amountIn=${i}`)),
      limitedFetch('https://open-api.openocean.finance/v3/1/quote?a=1'),
      limitedFetch('https://open-api.openocean.finance/v3/1/quote?a=2'),
    ])

    // KyberSwap's whole allowance plus two on a different origin — no cross-throttling.
    // A shared bucket would hold the last two back.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(8)

    await inFlight
  })
})
