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
