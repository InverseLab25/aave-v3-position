import type { Adapter, QuoteResponse, TransactionPayload } from './types';
import { fetchQuoteJson, limitedFetch } from './http';

/**
 * Socket (formerly Bungee), quoting same-chain swaps only.
 *
 * Socket is a router over routers: one request returns several routes across DEXs, bridges and
 * solvers. Setting `originChainId` equal to `destinationChainId` keeps it entirely on-chain
 * through DEX liquidity, which is the only shape this app has any use for.
 *
 * NOT a candidate for `COMPATIBLE_ADAPTERS`, and not for the reason the other exclusions are.
 * The approval spender and the call target are the same contract — Socket's AllowanceHolder,
 * with the router call wrapped inside the returned calldata — so it would pass `validateSwapTx`.
 * What stops it is `contractCaller`: a route executed BY a contract rather than by the signer
 * has to be quoted with that contract named up front, or it reverts with `CallerNotSignedUser`.
 * Wiring that means quoting per strategy contract, and the Guard would still need allowlisting
 * on chain. Quote-and-swap from the user's own wallet needs none of it.
 */

/** The public endpoint: no auth, shared rate limit, documented for testing and prototyping.
 *
 *  The keyed endpoint is deliberately not used. Socket's own guidance is to keep `x-api-key`
 *  server-side, and this app has no server to keep it on — a key in a Vite bundle is a published
 *  key. `backend.socket.tech` is the middle option: same lack of a secret, but a quota of its
 *  own rather than one shared with every other developer prototyping against the public one.
 *  Point `VITE_SOCKET_BASE` at it once the domain is whitelisted. */
const SOCKET_BASE =
  (import.meta.env.VITE_SOCKET_BASE as string | undefined) ?? 'https://public-backend.socket.tech';

/** Attribution, when one is configured. Socket asks for it on every request. */
const SOCKET_AFFILIATE = import.meta.env.VITE_SOCKET_AFFILIATE as string | undefined;

/** Chains this app configures that Socket serves. */
const SOCKET_CHAINS = new Set([1, 10, 137, 8453, 42161]);

/**
 * The address a quote is taken for, before the real caller is known.
 *
 * Socket requires both `userAddress` and `receiverAddress` and bakes them into the calldata, so
 * a quote is addressed to one caller the way Nordstern's is. This is the address Socket's own
 * same-chain example uses; the zero address is not documented as accepted, and only `amount` is
 * read from the placeholder round anyway. `buildTransaction` re-asks with the real caller.
 */
const QUOTE_PLACEHOLDER = '0x1111111111111111111111111111111111111111';

/** The subset of a route this adapter reads. */
interface SocketRoute {
  quoteId?: string;
  /** Unix seconds. A route past it fails on chain, so it is never built. */
  expiresAt?: number;
  output?: { amount: string; valueInUsd?: number };
  /** `dexDetails` on a same-chain route; the protocol underneath is the only label worth showing. */
  routeDetails?: { dexDetails?: { protocol?: { displayName?: string } } | null };
  approval?: { spenderAddress: string } | null;
  txData?: { kind: string; object?: { to: string; data: string; value: string | number } };
  gasFee?: { gasLimit?: string; feeInUsd?: number };
}

/**
 * The live response wraps everything in an envelope the published example omits.
 *
 * Reading `routes` off the top level finds nothing, and an adapter that always answers null is
 * an aggregator that silently never appears.
 */
interface SocketQuoteResponse {
  success?: boolean;
  result?: {
    input?: { amount: string; valueInUsd?: number };
    routes?: SocketRoute[];
  };
}

/** What `buildTransaction` needs to re-ask for the same trade, addressed to the real caller. */
interface SocketQuote {
  chainId: number;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
}

const quoteUrl = (q: SocketQuote, slippage: number, caller: string) =>
  `${SOCKET_BASE}/v3/swap/quote?` +
  new URLSearchParams({
    userOps: 'tx',
    // Socket's default, sent explicitly: the input is the amount we hold and the output is
    // whatever it fetches. Every sizing loop in this app solves for an exact INPUT, so a quote
    // pinned to an exact output would answer a question nothing here asks.
    quoteType: 'EXACT_INPUT',
    // Same chain on both sides: no bridge leg, no destination to wait on, no status to poll.
    originChainId: String(q.chainId),
    destinationChainId: String(q.chainId),
    inputToken: q.inputToken,
    outputToken: q.outputToken,
    inputAmount: q.inputAmount,
    userAddress: caller,
    receiverAddress: caller,
    // A decimal percentage, not basis points.
    slippage: String(slippage),
    // Socket simulates each DEX route and drops the ones that revert. Its own guidance is to
    // turn this on for same-chain swaps, where the whole route is simulatable.
    simulatedQuotesRequired: 'true',
  }).toString();

const headers = (): HeadersInit =>
  SOCKET_AFFILIATE ? { affiliate: SOCKET_AFFILIATE } : {};

/** The route with the most output. Socket ranks its own with tags; this app ranks on output. */
const bestRoute = (routes: SocketRoute[] | undefined): SocketRoute | null => {
  let best: SocketRoute | null = null;
  // The winner's amount is carried alongside it rather than re-parsed each time round. Socket
  // returns a route per underlying aggregator, so the list is not short — and holding the value
  // also retires the non-null assertion that reaching back into `best.output` needed.
  let bestOut = 0n;
  for (const route of routes ?? []) {
    if (!route.output?.amount) continue;
    const out = BigInt(route.output.amount);
    if (best === null || out > bestOut) {
      best = route;
      bestOut = out;
    }
  }
  return best;
};

export const socketAdapter: Adapter = {
  name: 'Socket',
  supportsExecution: true,
  // The public endpoint shares one quota across everyone using it, and answers a per-second
  // poll with 429s. The shared HTTP gate cannot help: it meters per origin, and the limit here
  // is not ours to spend.
  minQuoteIntervalMs: 5_000,

  getQuote: async (fromAsset, toAsset, amountIn, slippage, chainId, signal): Promise<QuoteResponse | null> => {
    if (!SOCKET_CHAINS.has(chainId)) return null;
    const q: SocketQuote = {
      chainId,
      inputToken: fromAsset.underlyingAsset,
      outputToken: toAsset.underlyingAsset,
      inputAmount: amountIn,
    };
    try {
      const json = await fetchQuoteJson<SocketQuoteResponse>(
        quoteUrl(q, slippage, QUOTE_PLACEHOLDER),
        { headers: headers(), signal },
      );
      const route = bestRoute(json.result?.routes);
      if (!route?.output?.amount) return null;

      const outUnits = Number(route.output.amount) / 10 ** toAsset.decimals;
      // Re-priced against the Aave oracle where the caller has a price, exactly as KyberSwap's
      // is; Socket's own figure is the fallback rather than the default.
      const amountOutUsd = toAsset.priceInUsd
        ? outUnits * Number(toAsset.priceInUsd)
        : route.output.valueInUsd ?? 0;
      const gasUsd = route.gasFee?.feeInUsd ?? 0;

      return {
        aggregator: 'Socket',
        amountIn,
        amountOut: route.output.amount,
        // Socket prices both sides itself, so `routeCostPercent` works here — unlike the
        // aggregators that report no USD at all and leave it null.
        rawAmountInUsd: json.result?.input?.valueInUsd?.toString(),
        rawAmountOutUsd: route.output.valueInUsd?.toString(),
        amountOutUsd: amountOutUsd.toFixed(2),
        gasEstimate: route.gasFee?.gasLimit,
        gasUsd: gasUsd.toFixed(2),
        netReturnUsd: amountOutUsd - gasUsd,
        rawQuote: q,
        routeDetails: {
          type: 'socket',
          // Socket routes through other aggregators, so naming the one underneath is the whole
          // of what this row can say — "Socket" alone would hide that it is often KyberSwap.
          info: route.routeDetails?.dexDetails?.protocol?.displayName ?? 'Routed via Socket',
        },
      };
    } catch (e) {
      // An abort is the caller withdrawing interest, not a fault. Same reading as KyberSwap's.
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return null;
      throw e;
    }
  },

  buildTransaction: async (quote, slippage, walletAddress, chainId): Promise<TransactionPayload> => {
    if (!SOCKET_CHAINS.has(chainId)) throw new Error(`Socket: unsupported chain ${chainId}`);
    // Re-asked rather than carried over: the quote was addressed to a placeholder, and both the
    // caller and the recipient are inside the calldata.
    const res = await limitedFetch(
      quoteUrl(quote.rawQuote as SocketQuote, slippage, walletAddress),
      { headers: headers() },
    );
    if (!res.ok) throw new Error(`Socket: build failed (HTTP ${res.status})`);
    const route = bestRoute(((await res.json()) as SocketQuoteResponse).result?.routes);
    if (!route) throw new Error('Socket: no route to build');

    // Anything but a plain EVM transaction belongs to a chain family this app does not reach.
    if (route.txData?.kind !== 'evm_tx' || !route.txData.object?.data) {
      throw new Error(`Socket: route is not an EVM transaction (${route.txData?.kind ?? 'none'})`);
    }
    // Checked here rather than left to the chain: an expired quote is documented to fail on
    // chain, and finding that out costs the user the gas.
    if (route.expiresAt !== undefined && route.expiresAt * 1000 <= Date.now()) {
      throw new Error('Socket: route expired before it could be submitted');
    }

    const tx = route.txData.object;
    return {
      to: tx.to,
      // Submitted exactly as returned. Socket wraps the router call inside the AllowanceHolder's
      // calldata, so anything rebuilt here would not be the route that was quoted.
      data: tx.data,
      value: String(tx.value ?? '0'),
      // The AllowanceHolder, which is also the call target. Absent for a native input, which
      // needs no approval at all.
      spender: route.approval?.spenderAddress ?? tx.to,
      amountOut: route.output?.amount,
      gasEstimate: route.gasFee?.gasLimit,
    };
  },
};
