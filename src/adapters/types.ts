export interface Asset {
  underlyingAsset: string;
  symbol: string;
  decimals: number;
  priceInUsd?: string;
  amount?: number;
}

/**
 * One hop of a split route.
 *
 * KyberSwap's own shape, adopted by any aggregator that reports its path in the same terms —
 * Nordstern maps onto it exactly, so the two share a renderer rather than growing a second one.
 */
export interface RouteHop {
  tokenIn: string;
  tokenOut: string;
  swapAmount: string;
  exchange?: string;
  poolType?: string;
  /** `_ce` present marks a hop that settles through a maker. See `isSmartSettlement`. */
  extra?: { _ce?: unknown };
}

/**
 * Per-aggregator route metadata for the UI, discriminated by `type`. Consumers must
 * narrow on `type` before reading anything else, which is what makes the route-details
 * panel type-safe without an escape hatch.
 */
export type RouteDetails =
  | { type: 'kyber' | 'nordstern'; totalAmountIn: bigint; paths: RouteHop[][] }
  | { type: 'odos-defillama' }
  | { type: 'cowswap' | '0x' | 'openocean' | 'paraswap' | 'socket'; info: string };

export interface QuoteResponse {
  aggregator: string;
  amountIn: string;
  amountOut: string;
  /**
   * The aggregator's OWN USD figures for both sides, untouched.
   *
   * Kept separate from `amountOutUsd`, which is deliberately re-priced against the Aave
   * oracle for ranking and display. Comparing a raw input against a re-priced output would
   * measure oracle-vs-market divergence as though it were route cost — these two must come
   * from the same pricing source to mean anything.
   */
  rawAmountInUsd?: string;
  rawAmountOutUsd?: string;
  /** Output value re-priced against the Aave oracle. Used for ranking and display. */
  amountOutUsd: string;
  /** Aggregator's gas estimate for the swap itself, in gas units. */
  gasEstimate?: string;
  gasUsd: string;
  netReturnUsd: number;
  routeDetails: RouteDetails;
  /**
   * The aggregator's own quote payload, replayed verbatim into `buildTransaction`.
   * Opaque by design — only the adapter that produced it knows the shape, so each
   * narrows it locally rather than leaking a shared `any` to every consumer.
   */
  rawQuote: unknown;
}

export interface TransactionPayload {
  to: string;
  data: string;
  value: string;
  spender: string; // The address that needs ERC20 approval
  /**
   * The aggregator's own output figure for THIS build, re-simulated at build time and
   * therefore authoritative over the quote's. It is what the router's `minReturnAmount` is
   * derived from, so any floor we enforce has to be derived from the same number.
   */
  amountOut?: string;
  /**
   * How far the built route moved from the quoted one, in percent (negative = worse). The
   * aggregator computes this itself; a materially negative value means the route degraded
   * between quote and build and the user is no longer getting what they reviewed.
   */
  outputChangePercent?: number;
  /**
   * Gas for the swap leg alone, in gas units, exactly as the aggregator reported it.
   *
   * Never padded. This reaches `validateSwapTx`, which compares it to the chain's
   * per-transaction cap — and there over-stating costs a route that would have run. Padding
   * belongs where a limit is SET, not where one is judged; see `pinnedGasLimit`.
   *
   * Undefined when the aggregator returned none. Absent is not zero.
   */
  gasEstimate?: string;
}

export interface Adapter {
  name: string;
  /** Whether this adapter supports on-chain execution (CowSwap = false) */
  supportsExecution: boolean;
  /**
   * Shortest gap between quotes the streaming screen may ask for, in ms. Default 1000.
   *
   * A property of the endpoint rather than of the caller: OpenOcean and Socket's public backend
   * both answer a per-second poll with 429s, and the shared HTTP gate cannot help — it meters
   * per origin against OUR budget, and these limits are shared with everyone else using them.
   */
  minQuoteIntervalMs?: number;
  /** `signal` aborts a superseded request so it stops consuming the aggregator. */
  getQuote: (fromAsset: Asset, toAsset: Asset, amountIn: string, slippage: number, chainId: number, signal?: AbortSignal) => Promise<QuoteResponse | null>;
  buildTransaction: (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number) => Promise<TransactionPayload>;
}
