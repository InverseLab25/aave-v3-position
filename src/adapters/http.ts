/**
 * Shared HTTP gate for aggregator APIs.
 *
 * Aggregators rate-limit per origin (KyberSwap allows 6 requests/second), and a single
 * deleverage preview fans out several quotes at sizes that depend on each other. Putting
 * the cap and the de-duplication here makes them structural: every call site gets them,
 * rather than each one having to remember.
 */

/**
 * Requests allowed per origin per `WINDOW_MS`. KyberSwap's ceiling for a whitelisted
 * client id, which its responses report as `x-ratelimit-limit: 60, 10` — 60 per 10s.
 * Held here as 6/s rather than 60/10s so a burst can't spend the whole ten-second budget
 * in one instant and then stall every later quote in the same window.
 */
const RATE_LIMIT = 6
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
 * How long an origin is left alone after it says it has had enough.
 *
 * Being throttled is self-reinforcing: the poll keeps firing, every request is refused, and the
 * window never gets a chance to clear. Long enough to actually stop asking, short enough that a
 * user who set an amount down and came back finds prices moving again.
 */
const COOLDOWN_MS = 15_000

/** Origins that refused, and the moment they may be asked again. */
const cooldowns = new Map<string, number>()

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
  if (!res.ok) {
    const error = new AggregatorHttpError(res.status, url)
    // Only for the refusals that asking again could fix. A 400 is a bad request and will be
    // just as bad in fifteen seconds; a 429 or a 5xx is the endpoint asking for room.
    if (error.retryable) cooldowns.set(originOf(url), Date.now() + COOLDOWN_MS)
    throw error
  }
  return res.json() as Promise<T>
}

/** Rate-limited `fetch`. Use for requests that must always hit the network (e.g. builds). */
export async function limitedFetch(url: string, init?: RequestInit): Promise<Response> {
  await acquireSlot(url)
  return fetch(url, init)
}

/**
 * One request, however many callers are waiting on it.
 *
 * `waiters` is what makes an abortable request shareable. A caller that passes a signal counts
 * itself in, and on abort counts itself back out; the underlying fetch is only cancelled once
 * the count reaches zero, i.e. once nobody is left who wants the answer. A caller that passes no
 * signal never counts back out, so its presence alone keeps the request alive — which is the
 * behaviour those callers already had.
 */
interface SharedQuote {
  at: number
  json: Promise<unknown>
  /** Cancels the fetch when the last waiter walks away. */
  controller: AbortController
  waiters: number
}

/** In-flight and recently-completed GETs, keyed by URL. */
const quoteCache = new Map<string, SharedQuote>()

/** What a caller's own signal rejects with. Named so adapters can tell it from a real failure. */
function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

/** Drops one waiter, and cancels the request itself once none are left. */
function releaseWaiter(url: string, entry: SharedQuote): void {
  entry.waiters -= 1
  if (entry.waiters > 0) return
  entry.controller.abort()
  // Only evict if this entry is still the installed one — a later call may have replaced it.
  if (quoteCache.get(url) === entry) quoteCache.delete(url)
}

/**
 * Rate-limited GET returning parsed JSON, with in-flight de-duplication and a short reuse
 * window. Two callers asking for the same URL at the same time share one request; a caller
 * repeating a URL within `QUOTE_TTL_MS` gets the previous response.
 *
 * Passing a signal no longer opts out of that sharing. It used to: cancelling a shared promise
 * would have cancelled it for everyone holding it, so an abortable caller was given its own
 * request. The close flow passes a signal on every quote, which meant its sizing rounds — which
 * ask the same URLs a preview just asked — paid full price for answers already in hand. What a
 * signal cancels now is the CALLER's wait; the request behind it only stops once every waiter
 * has gone.
 *
 * A rejected request is evicted immediately so a transient failure isn't cached.
 */
export function fetchQuoteJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const signal = init?.signal
  // Nothing to spend a rate-limit slot on: the caller stopped caring before it asked.
  if (signal?.aborted) return Promise.reject(abortError())

  // This origin asked for room and has not had it yet. Refused here rather than on the wire, so
  // a polling screen stops adding to the queue that is keeping the window shut. Deliberately
  // NOT applied to `limitedFetch`: a build is a user waiting on an action, and letting it try
  // is worth more than the request it spends.
  const until = cooldowns.get(originOf(url))
  if (until !== undefined) {
    if (Date.now() < until) return Promise.reject(new AggregatorHttpError(429, url))
    cooldowns.delete(originOf(url))
  }

  const now = Date.now()
  const hit = quoteCache.get(url)
  let entry: SharedQuote
  if (hit && now - hit.at < QUOTE_TTL_MS) {
    entry = hit
    entry.waiters += 1
  } else {
    // Nothing past the TTL can be reused — `hit` above already refuses it — so anything still in
    // the map at this point is dead weight. Swept on insert rather than on a timer: a KyberSwap
    // route response runs to tens of kilobytes and the solver asks for a different size every
    // few seconds, so a map that only ever grew held megabytes of quotes nobody could read.
    for (const [key, stale] of quoteCache) {
      if (now - stale.at >= QUOTE_TTL_MS) quoteCache.delete(key)
    }
    const controller = new AbortController()
    const json: Promise<unknown> = (async () => {
      await acquireSlot(url)
      // An entry every waiter has already abandoned is aborted by now, and fetch rejects on an
      // aborted signal without opening a connection — so a queued request nobody wants costs
      // nothing but the slot it had already reserved.
      return okJson<T>(await fetch(url, { ...init, signal: controller.signal }), url)
    })()
    entry = { at: now, json, controller, waiters: 1 }
    quoteCache.set(url, entry)
    json.catch(() => {
      // Only evict if this entry is still the one we installed — a later call may have
      // replaced it after the TTL expired, and that one is still good.
      if (quoteCache.get(url) === entry) quoteCache.delete(url)
    })
  }

  if (!signal) return entry.json as Promise<T>

  // The caller's own wait, which its signal ends. The shared request carries on unless this was
  // the last waiter, so a superseded preview stops consuming without cancelling a live one.
  return new Promise<T>((resolve, reject) => {
    const shared = entry
    const onAbort = () => {
      releaseWaiter(url, shared)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    shared.json.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v as T)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** Test support: how many quotes the reuse window is holding. */
export function cachedQuoteCount(): number {
  return quoteCache.size
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
  cooldowns.clear()
}
