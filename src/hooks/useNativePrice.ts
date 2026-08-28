import { useState, useEffect } from 'react';
import { useChainId } from 'wagmi';
import { limitedFetch } from '../adapters/http';

const POLL_MS = 10_000;

/**
 * The WRAPPED native token per chain — what the price API knows the asset by.
 *
 * A chain absent here cannot be priced and the hook returns null, so the caller falls back to
 * the Aave oracle. Testnets are deliberately absent: no real liquidity to price against.
 */
const WRAPPED_NATIVE: Record<number, string> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',      // WETH
  10: '0x4200000000000000000000000000000000000006',     // WETH
  137: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',    // WPOL
  8453: '0x4200000000000000000000000000000000000006',   // WETH
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',  // WETH
};

const PRICES_URL = 'https://token-api.kyberswap.com/api/v1/public/tokens/prices';

/**
 * The price API answers with both sides of a spread. We take `PriceSell`.
 *
 * Which side is which is not obvious from the names, and the docs do not say — measured on Base,
 * `PriceSell` came back ABOVE `PriceBuy` (2465.75 against 2430.18, about 1.4% apart), so the
 * naming reads from the venue's side rather than ours. Do not reason from the names alone; if a
 * caller ever needs the other side, check the live pair first.
 */
interface PricesResponse {
  code: number;
  data?: Record<string, Record<string, { PriceBuy?: number; PriceSell?: number }>>;
}

/**
 * USD price of the connected chain's NATIVE currency — ETH on Ethereum and the L2s, but BNB on
 * BNB Chain, POL on Polygon, AVAX on Avalanche. Null when the chain cannot be priced.
 *
 * Callers multiply this by an amount denominated in the native token, so quoting mainnet ETH
 * everywhere — which this used to do, back when it was called `useEthPrice` — priced a sub-cent
 * Polygon transaction at ether rates.
 *
 * The price and the chain it was quoted on are stored TOGETHER, and the return is gated on them
 * agreeing. That is what makes a chain switch surface immediately: the moment `chainId` changes
 * the previous chain's price stops being returned, rather than lingering until the next poll
 * lands and briefly showing BNB's number labelled as ETH.
 *
 * `chainId` is a parameter rather than read from wagmi alone so view-mode, which resolves a
 * different chain than the connected one, prices the chain being VIEWED.
 */
export function useNativePrice(chainId?: number) {
  const connectedChainId = useChainId();
  const resolvedChainId = chainId ?? connectedChainId;
  const token = WRAPPED_NATIVE[resolvedChainId];

  // One piece of state, so the price can never be read against a chain it did not come from.
  const [quoted, setQuoted] = useState<{ chainId: number; price: number } | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fetchPrice = async () => {
      // A visibility change can fire while a poll is already running; without this the
      // `finally` below would schedule a second chain and the two would compound.
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        // A dedicated price endpoint, not a swap quote. The old version asked for a route from
        // 1 native into a stablecoin and read the output — which priced gas through whatever
        // liquidity happened to exist, and spent the swap adapter's rate-limit budget doing it.
        const res = await limitedFetch(PRICES_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [resolvedChainId]: [token] }),
        });
        if (!res.ok) return;
        const json = (await res.json()) as PricesResponse;
        // Keys come back as the API spelled them, which need not match our casing.
        const forChain = json.data?.[String(resolvedChainId)] ?? {};
        const entry = Object.entries(forChain)
          .find(([addr]) => addr.toLowerCase() === token.toLowerCase())?.[1];
        if (!cancelled && json.code === 0 && entry?.PriceSell) {
          setQuoted({ chainId: resolvedChainId, price: entry.PriceSell });
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
  }, [resolvedChainId, token]);

  // Derived, not stored: a price from the previous chain must stop being returned the instant
  // the chain changes, without a state write from render or an effect.
  return quoted?.chainId === resolvedChainId ? quoted.price : null;
}
