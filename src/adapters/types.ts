export interface Asset {
  underlyingAsset: string;
  symbol: string;
  decimals: number;
  priceInUsd?: string;
  amount?: number;
}

/** One hop of a KyberSwap split route. */
export interface KyberHop {
  tokenIn: string;
  tokenOut: string;
  swapAmount: string;
  exchange?: string;
  poolType?: string;
}

/**
 * Per-aggregator route metadata for the UI, discriminated by `type`. Consumers must
 * narrow on `type` before reading anything else, which is what makes the route-details
 * panel type-safe without an escape hatch.
 */
export type RouteDetails =
  | { type: 'kyber'; totalAmountIn: bigint; paths: KyberHop[][] }
  | { type: 'odos-defillama' }
  | { type: 'cowswap' | '0x' | 'openocean' | 'paraswap'; info: string };

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
   * Gas for the swap leg alone, in gas units, already carrying the adapter's headroom.
   * Undefined when the aggregator did not return one — absent is not zero, and a caller
   * that treats it as zero would pin a limit the swap cannot run in.
   */
  gasEstimate?: string;
}

export interface Adapter {
  name: string;
  /** Whether this adapter supports on-chain execution (CowSwap = false) */
  supportsExecution: boolean;
  /** `signal` aborts a superseded request so it stops consuming the aggregator. */
  getQuote: (fromAsset: Asset, toAsset: Asset, amountIn: string, slippage: number, chainId: number, signal?: AbortSignal) => Promise<QuoteResponse | null>;
  buildTransaction: (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number) => Promise<TransactionPayload>;
}
