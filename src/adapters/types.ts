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
  amountOutUsd: string;
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
}

export interface Adapter {
  name: string;
  /** Whether this adapter supports on-chain execution (CowSwap = false) */
  supportsExecution: boolean;
  getQuote: (fromAsset: Asset, toAsset: Asset, amountIn: string, slippage: number, chainId: number) => Promise<QuoteResponse | null>;
  buildTransaction: (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number) => Promise<TransactionPayload>;
}
