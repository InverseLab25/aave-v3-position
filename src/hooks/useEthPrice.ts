import { useState, useEffect } from 'react';
import { useChainId } from 'wagmi';
import { fetchQuoteJson } from '../adapters/http';

const POLL_MS = 10_000;

/** The de-facto native-token sentinel every aggregator here accepts. */
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** One native token, priced in one unit. `amountIn` is always 1e18 — every native here is 18dp. */
const ONE_NATIVE = '1000000000000000000';

interface NativeQuote {
  /** KyberSwap's own chain slug. Matches `getKyberChain` in adapters/kyberswap.ts. */
  slug: string;
  /** The stablecoin to price against, and ITS decimals — which are not always six. */
  stable: string;
  decimals: number;
}

/**
 * How to price each chain's native currency.
 *
 * A per-chain stablecoin rather than one address reused everywhere, because the "same" stable has
 * a different address on every chain and several chains carry both a native and a bridged version
 * that can trade apart. Each entry below was confirmed against the live API to return a quote at a
 * sane price — a wrong address does not error, it returns a plausible number for the wrong token.
 *
 * BSC's USDT is EIGHTEEN decimals. Reading it as six would report BNB at ~1e12 dollars.
 *
 * A chain absent here cannot be priced, and the hook returns null so the caller falls back to the
 * Aave oracle. Testnets are deliberately absent: there is no real liquidity to quote.
 */
const NATIVE_QUOTES: Record<number, NativeQuote> = {
  1: { slug: 'ethereum', stable: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  10: { slug: 'optimism', stable: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
  56: { slug: 'bsc', stable: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  137: { slug: 'polygon', stable: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  8453: { slug: 'base', stable: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  42161: { slug: 'arbitrum', stable: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  43114: { slug: 'avalanche', stable: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
};

const quoteUrl = (q: NativeQuote) =>
  `https://aggregator-api.kyberswap.com/${q.slug}/api/v1/routes` +
  `?tokenIn=${NATIVE_SENTINEL}&tokenOut=${q.stable}&amountIn=${ONE_NATIVE}`;

interface KyberRoutesResponse {
  code: number;
  data?: { routeSummary?: { amountOut: string } };
}

/**
 * USD price of the connected chain's NATIVE currency — ETH on Ethereum and the L2s, but BNB on
 * BNB Chain, POL on Polygon, AVAX on Avalanche. Null when the chain cannot be priced.
 *
 * Named `useEthPrice` for its call sites' sake; it is really "native price". Callers multiply it
 * by a gas amount denominated in the native token, so quoting mainnet ETH everywhere — which this
 * used to do — priced a sub-cent Polygon transaction at ether rates.
 *
 * The price and the chain it was quoted on are stored TOGETHER, and the return is gated on them
 * agreeing. That is what makes a chain switch surface immediately: the moment `chainId` changes
 * the previous chain's price stops being returned, rather than lingering until the next poll
 * lands and briefly showing BNB's number labelled as ETH.
 *
 * `chainId` is a parameter rather than read from wagmi alone so view-mode, which resolves a
 * different chain than the connected one, prices the chain being VIEWED.
 */
export function useEthPrice(chainId?: number) {
  const connectedChainId = useChainId();
  const resolvedChainId = chainId ?? connectedChainId;
  const quote = NATIVE_QUOTES[resolvedChainId];

  // One piece of state, so the price can never be read against a chain it did not come from.
  const [quoted, setQuoted] = useState<{ chainId: number; price: number } | null>(null);

  useEffect(() => {
    if (!quote) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fetchPrice = async () => {
      // A visibility change can fire while a poll is already running; without this the
      // `finally` below would schedule a second chain and the two would compound.
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        // Through the shared gate rather than a bare fetch: this hits the SAME origin as the
        // swap-quote adapter, so an unmetered poll here spends part of KyberSwap's 3/s budget
        // without the limiter knowing, and can push a sizing burst over the limit into 429s.
        const json = await fetchQuoteJson<KyberRoutesResponse>(quoteUrl(quote));
        const amountOut = json.data?.routeSummary?.amountOut;
        if (!cancelled && json.code === 0 && amountOut) {
          setQuoted({
            chainId: resolvedChainId,
            price: Number(amountOut) / 10 ** quote.decimals,
          });
        }
      } catch (e) {
        if (!cancelled) console.error('Failed to fetch native price from Kyberswap', e);
      } finally {
        inFlight = false;
        // Schedule the next poll only once this one has settled. `setInterval` fired on a
        // fixed cadence regardless of whether the previous request had returned, so a slow
        // or hung response (there is no timeout on the network) let calls overlap and stack.
        if (!cancelled) {
          clearTimeout(timer);
          timer = setTimeout(fetchPrice, POLL_MS);
        }
      }
    };

    fetchPrice();

    // Browsers throttle timers in hidden tabs — Chrome drops them to roughly once a minute,
    // and harder still after a few minutes backgrounded. That, not anything resetting the
    // interval, is why the poll stops landing every 10s. Nothing can raise the ceiling on a
    // hidden tab, so instead re-fetch the moment the tab is looked at again: a returning user
    // sees a current price rather than whatever survived the throttle.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') fetchPrice();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
    // Re-quotes from scratch on a chain switch, which is the point.
  }, [resolvedChainId, quote]);

  // Derived, not stored: a price from the previous chain must stop being returned the instant
  // the chain changes, without a state write from render or an effect.
  return quoted?.chainId === resolvedChainId ? quoted.price : null;
}
