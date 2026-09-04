import type { Adapter, QuoteResponse, QuotesRequest } from './types';
import { kyberSwapAdapter } from './kyberswap';
import { nordsternAdapter } from './nordstern';
import { openOceanAdapter } from './openocean';
import { paraSwapAdapter } from './paraswap';
import { socketAdapter } from './socket';
import { cowSwapAdapter } from './cowswap';
// import { odosAdapter } from './odos';
import { zeroxAdapter } from './zerox';

export const allAdapters: Adapter[] = [
  kyberSwapAdapter,
  nordsternAdapter,
  openOceanAdapter,
  paraSwapAdapter,
  socketAdapter,
  cowSwapAdapter,
  // odosAdapter,
  zeroxAdapter
];

/** Returns only the adapters available on the given chain */
export function getAdaptersForChain(allowedNames: string[]): Adapter[] {
  if (allowedNames.length === 0) return [];
  return allAdapters.filter(a => allowedNames.includes(a.name));
}

/**
 * Every route one adapter offers for a trade, as a list.
 *
 * Most aggregators have exactly one answer and come back as a single-entry list. Socket is a
 * router over routers and returns a route per underlying aggregator, which the caller ranks
 * against each other and against the rest of the field.
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
