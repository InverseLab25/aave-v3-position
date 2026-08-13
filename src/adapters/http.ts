/**
 * Shared HTTP gate for aggregator APIs.
 *
 * Aggregators rate-limit per origin (KyberSwap allows 3 requests/second), and a single
 * deleverage preview fans out several quotes at sizes that depend on each other. Putting
 * the cap and the de-duplication here makes them structural: every call site gets them,
 * rather than each one having to remember.
 */

/** Requests allowed per origin per `WINDOW_MS`. KyberSwap's documented ceiling. */
const RATE_LIMIT = 3
const WINDOW_MS = 1000

/**
 * How long a quote stays reusable. Quotes are a pure function of
 * (chain, tokenIn, tokenOut, amountIn), so within this window an identical request can be
 * answered from the last response.
 *
 * Deliberately short: this collapses the bursts a single sizing pass produces — concurrent
 * re-renders, a re-quote at a size already probed — without ever showing a price that has
 * had time to move. It is a de-duplication window, not a price cache.
 */
const QUOTE_TTL_MS = 4_000

/**
 * Per-origin start times, ascending — both already-started requests still inside the
 * window and ones reserved for the future. A single global bucket would throttle unrelated
 * aggregators against each other's limits, so each API host gets its own.
 */
const buckets = new Map<string, number[]>()

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * Reserves this request's start time and resolves when it is due.
 *
 * The reservation is made synchronously, before any await, so concurrent callers cannot
 * all observe the same free slot and burst past the limit — the Nth caller in a burst
 * always lands on the Nth slot.
 */
function acquireSlot(url: string): Promise<void> {
  const origin = originOf(url)
  const starts = buckets.get(origin) ?? []
  const now = Date.now()

  // Drop starts that have fallen out of the trailing window; they no longer constrain.
  while (starts.length > 0 && starts[0] <= now - WINDOW_MS) starts.shift()

  // At most RATE_LIMIT starts may fall in any WINDOW_MS. With the survivors sorted
  // ascending, this request must wait a full window after the RATE_LIMIT-th most recent.
  const startAt =
    starts.length < RATE_LIMIT ? now : starts[starts.length - RATE_LIMIT] + WINDOW_MS

  starts.push(startAt)
  buckets.set(origin, starts)

  const delay = startAt - now
  return delay <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, delay))
}

/**
 * An aggregator answered, but not with a quote — a rate limit, an outage, a rejected request.
 *
 * Worth its own type because the alternative is indistinguishable from "this pair has no
 * liquidity": every adapter reports failure by returning null, and a caller seeing null from all
 * of them says NO_ROUTE. Being throttled and having nothing to trade are very different problems
 * for the user, and only one of them is fixed by waiting.
 */
export class AggregatorHttpError extends Error {
  readonly status: number
  readonly url: string

  constructor(status: number, url: string) {
    super(`Aggregator responded ${status}`)
    this.name = 'AggregatorHttpError'
    this.status = status
    this.url = url
  }

  /** Whether asking again could plausibly work: throttled or faulting, rather than refused. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500
  }
}

/** Parsed JSON, or a typed failure. A non-2xx body is never worth parsing as a quote. */
async function okJson<T>(res: Response, url: string): Promise<T> {
  if (!res.ok) throw new AggregatorHttpError(res.status, url)
  return res.json() as Promise<T>
}

/** Rate-limited `fetch`. Use for requests that must always hit the network (e.g. builds). */
export async function limitedFetch(url: string, init?: RequestInit): Promise<Response> {
  await acquireSlot(url)
  return fetch(url, init)
}

/** In-flight and recently-completed GETs, keyed by URL. */
const quoteCache = new Map<string, { at: number; json: Promise<unknown> }>()

/**
 * Rate-limited GET returning parsed JSON, with in-flight de-duplication and a short reuse
 * window. Two callers asking for the same URL at the same time share one request; a caller
 * repeating a URL within `QUOTE_TTL_MS` gets the previous response.
 *
 * A rejected request is evicted immediately so a transient failure isn't cached.
 */
export async function fetchQuoteJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  // An abortable request cannot be shared: cancelling it would cancel it for every other
  // caller holding the same promise. Callers that pass a signal want to be able to stop
  // consuming the aggregator when their result stops mattering, so they opt out of sharing.
  if (init?.signal) {
    await acquireSlot(url)
    return okJson<T>(await fetch(url, init), url)
  }

  const hit = quoteCache.get(url)
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.json as Promise<T>

  const json: Promise<T> = (async () => {
    await acquireSlot(url)
    return okJson<T>(await fetch(url, init), url)
  })()

  quoteCache.set(url, { at: Date.now(), json })
  json.catch(() => {
    // Only evict if this entry is still the one we installed — a later call may have
    // replaced it after the TTL expired, and that one is still good.
    if (quoteCache.get(url)?.json === json) quoteCache.delete(url)
  })
  return json
}

/**
 * Drop every cached quote. Wired to the UI's explicit Refresh, which exists precisely to
 * ask for prices newer than whatever is on screen.
 */
export function clearQuoteCache(): void {
  quoteCache.clear()
}

/**
 * Test support: also drops the rate-limiter's reservations. Production never needs this —
 * `Date.now()` only moves forward there, so old reservations age out on their own. Under
 * fake timers the clock restarts each test, which would otherwise leave reservations
 * sitting in the future.
 */
export function resetHttpGate(): void {
  quoteCache.clear()
  buckets.clear()
}
