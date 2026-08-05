import { useState, useEffect } from 'react';
import { fetchQuoteJson } from '../adapters/http';

const POLL_MS = 10_000;

// Native ETH -> USDT on mainnet. USDT has 6 decimals.
const PRICE_URL =
  'https://aggregator-api.kyberswap.com/ethereum/api/v1/routes' +
  '?tokenIn=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' +
  '&tokenOut=0xdAC17F958D2ee523a2206206994597C13D831ec7' +
  '&amountIn=1000000000000000000';

interface KyberRoutesResponse {
  code: number;
  data?: { routeSummary?: { amountOut: string } };
}

export function useEthPrice() {
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
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
        const json = await fetchQuoteJson<KyberRoutesResponse>(PRICE_URL);
        const amountOut = json.data?.routeSummary?.amountOut;
        if (!cancelled && json.code === 0 && amountOut) {
          setPrice(Number(amountOut) / 1e6);
        }
      } catch (e) {
        if (!cancelled) console.error('Failed to fetch ETH price from Kyberswap', e);
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
  }, []);

  return price;
}
