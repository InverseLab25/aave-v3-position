export interface Asset {
  underlyingAsset: string;
  symbol: string;
  decimals: number;
  priceInUsd?: string;
  amount?: number;
}

export interface QuoteResponse {
  aggregator: string;
  amountIn: string;
  amountOut: string;
  amountOutUsd: string;
  gasUsd: string;
  netReturnUsd: number;
  routeDetails: any;
  rawQuote: any;
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
