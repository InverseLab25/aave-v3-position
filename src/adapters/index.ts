import type { Adapter, QuoteResponse, QuotesRequest } from './types';
import { solverAdapter } from './solver';

/**
 * Every quote goes through the solver, alone. It asks every provider server-side and simulates
 * each route from whichever contract or wallet will execute it, so nothing in the browser holds
 * a provider key or talks to an aggregator.
 */
export function leverageAdapters(): Adapter[] {
  return [solverAdapter];
}

/**
 * Every route one adapter offers for a trade, as a list.
 *
 * `caller` matters more here than it looks: an adapter implementing `getQuotes` quotes for that
 * address and hands back calldata already addressed to it, so building costs no further request.
 * Passing the wrong one produces routes that revert rather than routes that are merely worse.
 */
export async function quoteField(adapter: Adapter, args: QuotesRequest): Promise<QuoteResponse[]> {
  if (adapter.getQuotes) return adapter.getQuotes(args);
  const quote = await adapter.getQuote(
    args.fromAsset, args.toAsset, args.amountIn, args.slippage, args.chainId, args.signal,
  );
  return quote ? [quote] : [];
}

export * from './types';
