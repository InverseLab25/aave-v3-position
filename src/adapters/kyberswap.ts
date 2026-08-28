import type { Adapter, Asset, KyberHop, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';
import { AggregatorHttpError, fetchQuoteJson, limitedFetch } from './http';

// KyberSwap requires an x-client-id header on both /routes and /route/build.
const KYBER_CLIENT_ID = 'defi-route';

/**
 * Whether any hop settles through a maker rather than a pool.
 *
 * Kyber's own frontend derives it exactly this way and buffers gas 50% when true — which is
 * where {@link GAS_LIMIT_BUFFER_PERCENT} comes from. Every Base route measured so far is true,
 * so nothing branches on it yet; it is here to display and for the chain where it is false.
 */
export const isSmartSettlement = (route: KyberHop[][]): boolean =>
  route.some((path) => path.some((hop) => Boolean(hop.extra?._ce)));

/** The subset of `/routes` this adapter reads. `routeSummary` is replayed verbatim into /route/build. */
interface KyberRoutesResponse {
  code: number;
  data?: {
    routeSummary?: {
      amountIn: string;
      amountInUsd: string;
      amountOut: string;
      amountOutUsd: string;
      gas: string;
      gasUsd: string;
      route: KyberHop[][];
    };
  };
}

/** The subset of `/route/build` this adapter reads. */
interface KyberBuildResponse {
  code: number;
  message?: string;
  data?: {
    routerAddress: string;
    data: string;
    transactionValue?: string;
    /** Re-simulated at build time; differs from the quote's and is what minReturnAmount uses. */
    amountOut?: string;
    outputChange?: { percent?: number };
    /** Route-level gas estimate for the built calldata. Padded before it leaves the adapter. */
    gas?: string;
  };
}

/**
 * Deadline written into the router calldata, in seconds. Matches KyberSwap's own interface
 * default. Sent explicitly rather than inheriting whatever the API would pick, so the window
 * the transaction stays valid for is one we chose.
 */
const BUILD_DEADLINE_S = 20 * 60;

const getKyberChain = (chainId: number): string | null => {
  switch (chainId) {
    case 1: return 'ethereum';
    case 10: return 'optimism';
    case 137: return 'polygon';
    case 250: return 'fantom';
    case 8453: return 'base';
    case 42161: return 'arbitrum';
    default: return null; // unsupported chain — don't silently quote on ethereum
  }
};

export const kyberSwapAdapter: Adapter = {
  name: 'KyberSwap',
  supportsExecution: true,
  getQuote: async (fromAsset: Asset, toAsset: Asset, amountIn: string, _slippage: number, chainId: number, signal?: AbortSignal): Promise<QuoteResponse | null> => {
    try {
      const chainStr = getKyberChain(chainId);
      if (!chainStr) return null;
      const url = `https://aggregator-api.kyberswap.com/${chainStr}/api/v1/routes?tokenIn=${fromAsset.underlyingAsset}&tokenOut=${toAsset.underlyingAsset}&amountIn=${amountIn}&gasInclude=true`;
      // Routed through the shared gate: the response depends only on the URL, so identical
      // requests (concurrent re-renders, a re-quote at a size already probed, the preview
      // being rebuilt for execution) collapse to one call, under KyberSwap's 3/s ceiling.
      const json = await fetchQuoteJson<KyberRoutesResponse>(url, { headers: { 'x-client-id': KYBER_CLIENT_ID }, signal });
      const summary = json.data?.routeSummary;
      if (json.code !== 0 || !summary) return null;

      const amountOutEth = Number(formatUnits(BigInt(summary.amountOut), toAsset.decimals));
      const amountOutUsd = toAsset.priceInUsd
        ? amountOutEth * Number(toAsset.priceInUsd)
        : Number(summary.amountOutUsd);
      const gasUsd = Number(summary.gasUsd);

      return {
        aggregator: 'KyberSwap',
        amountIn: summary.amountIn,
        amountOut: summary.amountOut,
        rawAmountInUsd: summary.amountInUsd,
        rawAmountOutUsd: summary.amountOutUsd,
        amountOutUsd: amountOutUsd.toFixed(2),
        gasEstimate: summary.gas,
        gasUsd: gasUsd.toFixed(2),
        netReturnUsd: amountOutUsd - gasUsd,
        rawQuote: summary,
        routeDetails: {
          type: 'kyber',
          totalAmountIn: BigInt(summary.amountIn),
          paths: summary.route
        }
      };
    } catch (e) {
      // An abort is the caller withdrawing interest in the answer — a superseded preview,
      // or a closed modal. Routine, and not something to report as a fault.
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return null;
      // Rethrown rather than flattened to null: null means "no route for this pair", and a
      // caller that cannot tell the two apart tells the user to go looking for liquidity when
      // the actual problem is that we are being throttled.
      if (e instanceof AggregatorHttpError) throw e;
      console.error('KyberSwap fetch error', e);
      return null;
    }
  },
  
  buildTransaction: async (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number): Promise<TransactionPayload> => {
    const chainStr = getKyberChain(chainId);
    if (!chainStr) throw new Error(`KyberSwap: unsupported chain ${chainId}`);
    const url = `https://aggregator-api.kyberswap.com/${chainStr}/api/v1/route/build`;
    // Not cacheable — the body carries a per-call sender/recipient — but still metered, so a
    // build can't push the origin over its limit while quotes are in flight.
    const res = await limitedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': KYBER_CLIENT_ID },
      body: JSON.stringify({
        routeSummary: quote.rawQuote,
        sender: walletAddress,
        recipient: walletAddress,
        slippageTolerance: slippage * 100,
        deadline: Math.floor(Date.now() / 1000) + BUILD_DEADLINE_S,
        source: KYBER_CLIENT_ID,
        // Both of these must stay off, and for the same reason: the deleverager never holds
        // the collateral outside the transaction — it only has it mid-flash-loan. Any
        // server-side execution against `sender` therefore reverts with
        // TRANSFER_FROM_FAILED and the build returns code 4227 instead of calldata.
        //
        // Verified against the live API: `enableGasEstimation: true` fails every build even
        // when `skipSimulateTx` is true, because the gas estimate is its own on-chain call.
        // With both off the response still carries `amountOut` and `outputChange`, which is
        // everything the caller needs. Swap gas comes from the /routes quote instead, and the
        // close is simulated end-to-end by the caller — strictly more complete than either.
        skipSimulateTx: true,
      })
    });
    // Checked before parsing, for the same reason as the quote: a 429 body is not calldata, and
    // reading it as one turns "slow down" into an unexplained build failure.
    if (!res.ok) throw new AggregatorHttpError(res.status, url);
    const json: KyberBuildResponse = await res.json();
    if (json.code !== 0 || !json.data) throw new Error(json.message ?? 'KyberSwap: route build failed');

    return {
      to: json.data.routerAddress,
      data: json.data.data,
      value: json.data.transactionValue ?? "0",
      spender: json.data.routerAddress,
      amountOut: json.data.amountOut,
      outputChangePercent: json.data.outputChange?.percent,
      gasEstimate: json.data.gas,
    };
  }
};
