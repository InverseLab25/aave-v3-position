import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AggregatorHttpError, fetchQuoteJson, limitedFetch, clearQuoteCache, resetHttpGate,
  cachedQuoteCount,
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

  it('shares one request with an abortable caller too', async () => {
    // This is what the close flow gets back: it passes a signal on every quote, so before this
    // it re-asked the network for sizes a preview had just priced.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) })
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    await Promise.all([
      fetchQuoteJson(`${KYBER}?amountIn=9`),
      fetchQuoteJson(`${KYBER}?amountIn=9`, { signal: controller.signal }),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('lets one caller abort without cancelling another that is still waiting', async () => {
    // The property the old "never share an abortable request" rule was protecting. Sharing is
    // only safe while this holds.
    let settle: (v: unknown) => void = () => {}
    const fetchMock = vi.fn().mockReturnValue(
      new Promise((r) => { settle = r }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const leaving = new AbortController()
    const staying = fetchQuoteJson(`${KYBER}?amountIn=10`)
    const going = fetchQuoteJson(`${KYBER}?amountIn=10`, { signal: leaving.signal })
    await vi.advanceTimersByTimeAsync(0)

    leaving.abort()
    await expect(going).rejects.toThrow(/abort/i)

    settle({ ok: true, status: 200, json: async () => ({ code: 0 }) })
    await expect(staying).resolves.toEqual({ code: 0 })
  })

  it('cancels the request itself once every waiter has gone', async () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)

    const a = new AbortController()
    const b = new AbortController()
    const first = fetchQuoteJson(`${KYBER}?amountIn=13`, { signal: a.signal })
    const second = fetchQuoteJson(`${KYBER}?amountIn=13`, { signal: b.signal })
    await vi.advanceTimersByTimeAsync(0)

    const underlying = fetchMock.mock.calls[0][1] as { signal: AbortSignal }
    a.abort()
    await expect(first).rejects.toThrow(/abort/i)
    expect(underlying.signal.aborted).toBe(false) // b is still waiting on it

    b.abort()
    await expect(second).rejects.toThrow(/abort/i)
    expect(underlying.signal.aborted).toBe(true)
  })

  it('never reaches the network for a caller that gave up before asking', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    controller.abort()

    await expect(
      fetchQuoteJson(`${KYBER}?amountIn=14`, { signal: controller.signal }),
    ).rejects.toThrow(/abort/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not keep quotes nobody can read any more', async () => {
    // Every solver round asks about a different size, and a Kyber route response is tens of
    // kilobytes. Without the sweep the map grew for the life of the session.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) })
    vi.stubGlobal('fetch', fetchMock)

    for (const size of [1, 2, 3]) await fetchQuoteJson(`${KYBER}?amountIn=${size}00`)
    await vi.advanceTimersByTimeAsync(5_000)
    await fetchQuoteJson(`${KYBER}?amountIn=400`)

    // Only the entry just inserted survives; the three that timed out were swept with it.
    expect(cachedQuoteCount()).toBe(1)
  })

  it('stops asking an origin that said it has had enough', async () => {
    // Being throttled is self-reinforcing: the poll keeps firing, every request is refused, and
    // the window never gets room to clear. The next ask is refused locally instead.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchQuoteJson(`${KYBER}?amountIn=20`)).rejects.toThrow(AggregatorHttpError)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A different URL on the same origin, so the quote cache cannot be what refuses it.
    await expect(fetchQuoteJson(`${KYBER}?amountIn=21`)).rejects.toThrow(AggregatorHttpError)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Another origin is unaffected — one aggregator throttling is not evidence about the rest.
    await expect(fetchQuoteJson('https://open-api.openocean.finance/v4/base/quote?a=1'))
      .rejects.toThrow(AggregatorHttpError)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // And it is a pause, not a ban.
    await vi.advanceTimersByTimeAsync(16_000)
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 0 }) })
    await expect(fetchQuoteJson(`${KYBER}?amountIn=22`)).resolves.toEqual({ code: 0 })
  })

  it('lets a build through even while quotes are backing off', async () => {
    // A build is a user waiting on an action they took. Refusing it locally to save a request
    // trades their transaction for our tidiness.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchQuoteJson(`${KYBER}?amountIn=30`)).rejects.toThrow(AggregatorHttpError)
    await limitedFetch(`${KYBER}/build`, { method: 'POST' })

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

  it('does not cache the failure — a later ask hits the network again', async () => {
    // The property is that a failed request is never kept as the answer. The wait is the
    // back-off below, not the cache: asking the same URL the instant after a 429 is refused
    // locally now, which is the point of it.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)

    await fetchQuoteJson(`${KYBER}?amountIn=11`).catch(() => null)
    await vi.advanceTimersByTimeAsync(16_000)
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
