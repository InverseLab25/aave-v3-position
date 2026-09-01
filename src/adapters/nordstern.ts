import type { Adapter, QuoteResponse, RouteHop, TransactionPayload } from './types';
import { fetchQuoteJson, limitedFetch } from './http';

/**
 * Nordstern's aggregator. One GET returns the quote AND the transaction — no separate build.
 *
 * Here for gas, not price. Measured on Base against KyberSwap seconds apart, it lands within
 * 0.02%–0.06% of Kyber's best output on 1M and 5M trades while using roughly a quarter of the
 * gas and about 1KB of calldata against Kyber's 43KB. Base caps a transaction at 16,777,216 and
 * our flows spend the swap's budget inside a flash loan, so that gap decides whether a large
 * position can be opened at all.
 */

/**
 * The Guard Contract per chain — the only address a Nordstern route may target.
 *
 * Their docs ask integrators to verify this, and on one path we have nothing else: the plain-swap
 * screen sends `tx.to` straight to the user's wallet to approve and call, with no on-chain
 * allowlist behind it. A wrong or swapped address there would be approved by the user.
 *
 * The contract flows are covered anyway — AaveV3Strategies only calls routers its owner has
 * allowlisted — so this is belt for the path that has no braces.
 *
 * Verified on Base: `AggregatorGuard`, source published, not a proxy, no owner, no pause.
 * A chain is supported only once its Guard is listed here.
 */
const GUARDS: Record<number, string> = {
  8453: '0xC87De04e2EC1F4282dFF2933A2D58199f688fC3d',
  // Byte-identical runtime code to Base's, checked with `eth_getCode` on both — 1852 bytes,
  // same hash — so the review above covers it without re-reading the source. Taken from a live
  // quote on Arbitrum, and allowlisted on the Strategies contract there.
  42161: '0x57f96440f1b1cAD53B40A8924BD540b1279A491c',
};

/**
 * `from` is encoded into the returned calldata, so a route belongs to one caller.
 *
 * Quoting does not need the real one — only `toAmount` is read — and the zero address is
 * accepted. The build re-asks with the caller that will actually execute.
 */
const QUOTE_PLACEHOLDER = '0x0000000000000000000000000000000000000000';

/** One leg of one path, as Nordstern names it. `type` is the venue ("uniswap_v4", …). */
interface NordsternLeg {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  type?: string;
  pool?: string;
}

/** One path of the split, with the share of the input it takes. */
interface NordsternSwap {
  amountIn: string;
  route?: NordsternLeg[];
}

/** The subset of the response this adapter reads. */
interface NordsternRoute {
  toAmount: string;
  minToAmount?: string;
  gasEstimate?: string;
  swaps?: NordsternSwap[];
  tx?: { to: string; data: string; value: string | number };
}

/**
 * Nordstern's split, in the shape the route panel already renders for KyberSwap.
 *
 * Each `swaps` entry is one path and carries its own share of the input, which is what the
 * panel's percentage is derived from; each leg inside it names the venue and the pair.
 */
const toPaths = (swaps: NordsternSwap[] | undefined): RouteHop[][] =>
  (swaps ?? []).map((path) =>
    (path.route ?? []).map((leg) => ({
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      // The PATH's input on the first leg, so the percentage reads against the whole trade the
      // way Kyber's does; every later leg carries its own.
      swapAmount: leg.amountIn,
      exchange: leg.type,
      poolType: leg.pool,
    })),
  );

/** What `buildTransaction` needs to re-ask for the same route, addressed to the real caller. */
interface NordsternQuote {
  src: string;
  dst: string;
  amount: string;
}

/**
 * Nordstern attributes API traffic by `Referer`. In the browser this is already handled: the
 * page's own origin is sent automatically, and `Referer` is a forbidden header name there, so
 * this object is dropped rather than applied. It is here for a caller outside the browser —
 * a test, a script, anything on Node — where nothing sets it for us.
 *
 * Nothing gates on it. Measured against the live API, sending no Referer, someone else's origin
 * and a string that is not a URL all return the same route, so a wrong value costs attribution
 * rather than access. Taken from the page it is running on so a preview or a rename attributes
 * itself, with the deployed origin standing in off-browser where there is no page to ask.
 */
const ATTRIBUTION = {
  Referer:
    typeof location !== 'undefined' ? location.origin : 'https://defi-route.siddhnathbrass.in',
};

const routeUrl = (chainId: number, q: NordsternQuote, slippage: number, from: string) =>
  `https://api.nordstern.finance/aggregator/${chainId}` +
  `?src=${q.src}&dst=${q.dst}&amount=${q.amount}&from=${from}&slippage=${slippage}`;

export const nordsternAdapter: Adapter = {
  name: 'Nordstern',
  supportsExecution: true,

  getQuote: async (fromAsset, toAsset, amountIn, slippage, chainId, signal): Promise<QuoteResponse | null> => {
    if (!GUARDS[chainId]) return null;
    const q: NordsternQuote = {
      src: fromAsset.underlyingAsset,
      dst: toAsset.underlyingAsset,
      amount: amountIn,
    };
    try {
      const route = await fetchQuoteJson<NordsternRoute>(
        routeUrl(chainId, q, slippage, QUOTE_PLACEHOLDER),
        { signal, headers: ATTRIBUTION },
      );
      if (!route?.toAmount) return null;

      const outUnits = Number(route.toAmount) / 10 ** toAsset.decimals;
      const amountOutUsd = toAsset.priceInUsd ? outUnits * Number(toAsset.priceInUsd) : 0;

      return {
        aggregator: 'Nordstern',
        amountIn,
        amountOut: route.toAmount,
        amountOutUsd: amountOutUsd.toFixed(2),
        // Reported as given. Their docs say to add 20% before using it, and measured against a
        // Tenderly simulation it ran ~100% under — but this figure reaches `validateSwapTx`,
        // where over-stating costs a route that would have run. Padding belongs where a limit is
        // set, not where one is judged.
        gasEstimate: route.gasEstimate,
        // No USD figures of its own, so `routeCostPercent` cannot be derived the way KyberSwap's
        // is. Left at zero rather than invented; the caller reads it as "unpriced".
        gasUsd: '0',
        netReturnUsd: amountOutUsd,
        rawQuote: q,
        routeDetails: {
          type: 'nordstern',
          totalAmountIn: BigInt(amountIn),
          paths: toPaths(route.swaps),
        },
      };
    } catch (e) {
      // An abort is the caller withdrawing interest, not a fault. Same reading as KyberSwap's.
      if ((e as Error)?.name === 'AbortError' || signal?.aborted) return null;
      throw e;
    }
  },

  buildTransaction: async (quote, slippage, walletAddress, chainId): Promise<TransactionPayload> => {
    const guard = GUARDS[chainId];
    if (!guard) throw new Error(`Nordstern: unsupported chain ${chainId}`);
    // Re-asked rather than carried over: the quote was addressed to a placeholder, and the
    // recipient is inside the calldata. Not cacheable for the same reason KyberSwap's build is not.
    const res = await limitedFetch(
      routeUrl(chainId, quote.rawQuote as NordsternQuote, slippage, walletAddress),
      { headers: ATTRIBUTION },
    );
    if (!res.ok) throw new Error(`Nordstern: build failed (HTTP ${res.status})`);
    const route = (await res.json()) as NordsternRoute;
    if (!route?.tx?.data) throw new Error('Nordstern: build returned no transaction');
    // Anything not addressed to the Guard is not a Nordstern route, whatever the response says.
    if (route.tx.to?.toLowerCase() !== guard.toLowerCase()) {
      throw new Error(`Nordstern: route targets ${route.tx.to}, not the Guard ${guard}`);
    }

    return {
      to: route.tx.to,
      data: route.tx.data,
      value: String(route.tx.value ?? 0),
      // The Guard is both call target and approval target — it pulls with
      // `transferFrom(msg.sender, …)`. `validateSwapTx` rejects a build where the two differ.
      spender: route.tx.to,
      amountOut: route.toAmount,
      gasEstimate: route.gasEstimate,
    };
  },
};
