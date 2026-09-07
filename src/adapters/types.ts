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
  | { type: 'cowswap' | '0x' | 'openocean' | 'paraswap' | 'socket' | 'solver'; info: string };

export interface QuoteResponse {
  /**
   * Which adapter produced this, and therefore which one builds it. Matched by name against
   * the adapter list, so it is the adapter's name and never the underlying venue's.
   */
  aggregator: string;
  /**
   * What to call this ROW, where that differs from the adapter that fetched it.
   *
   * Socket answers one request with a route per underlying venue, so `aggregator` is 'Socket'
   * five times over — which collides as a key and reads as five identical rows on screen. This
   * names the venue instead ('0x', 'Bitget'), unique within one adapter's answer. Everything
   * that keys or labels a route by identity goes through `routeKey`, which falls back to
   * `aggregator` for the adapters that return one route and need none of this.
   */
  routeId?: string;
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
  /** `signal` aborts a superseded request so it stops consuming the aggregator. */
  getQuote: (fromAsset: Asset, toAsset: Asset, amountIn: string, slippage: number, chainId: number, signal?: AbortSignal) => Promise<QuoteResponse | null>;
  /**
   * Every route this aggregator offers, rather than only its best.
   *
   * Optional, and only worth implementing for an aggregator that is itself a router over
   * routers. Socket answers one request with a route per underlying aggregator — 0x, Bitget,
   * Fynd and the rest — and those differ from each other as much as two adapters do. Returning
   * only the winner throws away the field the caller is meant to rank on measured output.
   *
   * Unlike {@link getQuote} this takes the REAL caller rather than a placeholder, because the
   * quotes it returns carry executable calldata addressed to that caller. That is the point:
   * `buildTransaction` on one of these needs no second request, which removes a round trip per
   * candidate from a preview that refreshes every few seconds.
   */
  getQuotes?: (args: QuotesRequest) => Promise<QuoteResponse[]>;
  buildTransaction: (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number) => Promise<TransactionPayload>;
}

/** A signature as the solver takes it: decimal strings for the numbers, hex for r and s. */
export interface SolverSig { deadline: string; r: string; s: string; v: number }

export interface QuotesRequest {
  fromAsset: Asset;
  toAsset: Asset;
  amountIn: string;
  /** A decimal percentage, as `getQuote` takes it. */
  slippage: number;
  chainId: number;
  /** Who will send the transaction. Baked into the returned calldata. */
  caller: string;
  /**
   * Where the output should land, when that is not the caller.
   *
   * A separate field because Socket treats them separately: `userAddress` is who the route is
   * signed for and `receiverAddress` is who receives, and collapsing the two into one address
   * makes a swap that pays somebody else inexpressible. Defaults to `caller`, which is what
   * every flow here wants today — the leverage and close swaps run inside AaveV3Strategies
   * mid-flash-loan and the output has to come back to the contract that owes the loan.
   */
  receiver?: string;
  /**
   * The connected wallet, when there is one. The solver needs it because Socket signs its
   * route for a wallet; nothing in the browser adapters reads it.
   */
  owner?: string;
  /**
   * Whose close this swap sits inside, when it does. The solver then runs each route as the
   * whole close through the Strategies contract instead of as a bare swap, and reports what
   * it repaid, withdrew and returned. Amounts are wei strings, or 'all'.
   */
  close?: {
    user: string; collateralToWithdraw: 'all' | string; debtRepay: 'all' | string;
    /** On the final ask only: the solver then returns the transaction to send, signatures inside. */
    permit?: SolverSig & { amount: string }; revokePermit?: SolverSig;
  };
  /**
   * Whose open this swap sits inside, when it does. The solver then runs each route as the
   * whole open through the Strategies contract, with the margin's balance and allowance
   * overridden for the wallet so it works before the approve. `amountIn` is what the contract
   * swaps; without `flashAmount` each route is flashed its own quote less 1%.
   */
  open?: { user: string; margin: 'debt' | 'collateral'; marginAmount: string; flashAmount?: string; delegation?: SolverSig };
  signal?: AbortSignal;
}
