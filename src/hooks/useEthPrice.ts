import { useState, useEffect } from 'react';
import { useChainId } from 'wagmi';
import { fetchQuoteJson } from '../adapters/http';
import { getChainConfig } from '../config/chains';

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

/**
 * Spot price of the chain's native currency in USD, or null when it cannot be priced here.
 *
 * The quote below is hardcoded to MAINNET ETH, so it is only the right answer on chains whose
 * native currency is ether. On BNB Chain, Polygon and Avalanche it is not — and since callers
 * multiply this by a gas amount denominated in the native token, returning it there prices a
 * sub-cent Polygon transaction at ETH rates. Null is the honest answer on those chains, and it
 * routes callers to their existing fallback: the chain's own wrapped-native reserve, priced by
 * Aave's oracle.
 *
 * `chainId` is a parameter rather than read from wagmi alone so view-mode (which resolves a
 * different chain than the connected one) prices the chain being VIEWED.
 */
export function useEthPrice(chainId?: number) {
  const connectedChainId = useChainId();
  const resolvedChainId = chainId ?? connectedChainId;
  // Same convention the rest of the app uses for "the chain's wrapped native": the first
  // default token. WETH means the native currency is ether.
  const nativeIsEth =
    getChainConfig(resolvedChainId)?.defaultTokens?.[0]?.symbol?.toUpperCase() === 'WETH';

  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    // Don't poll at all for a chain this quote cannot price. The stale value is not cleared
    // here — setting state from an effect is what `react-hooks/set-state-in-effect` forbids,
    // and it is unnecessary: the return below gates the value rather than the store.
    if (!nativeIsEth) return;
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
  }, [nativeIsEth]);

  // Derived, not stored: switching to a non-ETH chain must not leave the previous chain's
  // price readable, and gating here does that without a state write.
  return nativeIsEth ? price : null;
}
