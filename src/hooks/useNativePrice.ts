import { useState, useEffect } from 'react';
import { formatUnits } from 'viem';
import { useChainId } from 'wagmi';
import { limitedFetch } from '../adapters/http';
import { NATIVE_ADDRESS } from '../adapters/native';
import { nordsternAdapter } from '../adapters/nordstern';

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

/** One native token, priced in one unit. `amountIn` is always 1e18 — every native here is 18dp. */
const ONE_NATIVE = '1000000000000000000';

/**
 * The stablecoin each chain's native token is priced against, and ITS decimals — which are not
 * always six on every chain, so the pair is carried together.
 *
 * Only used by the sources that have no price endpoint and have to be asked for a route instead.
 * A per-chain address rather than one reused everywhere, because the "same" stablecoin has a
 * different address on every chain and several chains carry both a native and a bridged version
 * that can trade apart. Each entry was confirmed against the live API to return a sane price — a
 * wrong address does not error, it returns a plausible number for the wrong token.
 */
const STABLE: Record<number, { address: string; decimals: number }> = {
  1: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },      // USDT
  10: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },     // USDC
  137: { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },    // USDC
  8453: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },   // USDC
  42161: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },  // USDC
};

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
 * A source that threw is a source that did not answer.
 *
 * Caught per source rather than around the pair, so one being down cannot cost us the other's
 * price — but still reported, because a source that has stopped answering entirely is worth
 * seeing in a console rather than silently halving where the price comes from.
 */
const reportAndSkip = (source: string) => (e: unknown): null => {
  console.error(`Failed to fetch native price from ${source}`, e);
  return null;
};

/**
 * USD per native from KyberSwap's price endpoint. Null when it does not answer.
 *
 * A dedicated price endpoint, not a swap quote. The old version asked for a route from 1 native
 * into a stablecoin and read the output — which priced gas through whatever liquidity happened
 * to exist, and spent the swap adapter's rate-limit budget doing it.
 */
async function kyberPrice(chainId: number, token: string): Promise<number | null> {
  const res = await limitedFetch(PRICES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [chainId]: [token] }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as PricesResponse;
  if (json.code !== 0) return null;
  // Keys come back as the API spelled them, which need not match our casing.
  const forChain = json.data?.[String(chainId)] ?? {};
  const entry = Object.entries(forChain)
    .find(([addr]) => addr.toLowerCase() === token.toLowerCase())?.[1];
  return entry?.PriceSell ?? null;
}

/**
 * USD per native from Nordstern, which publishes no price endpoint — so this IS a swap quote:
 * one native token into the chain's stablecoin, priced at what the route returns.
 *
 * Null on any chain Nordstern does not serve, which the adapter decides for itself by whether it
 * has a Guard address for that chain. Quoted through the adapter rather than by hand so the
 * Guard check, the attribution header and the shared rate-limit gate all still apply.
 */
async function nordsternPrice(chainId: number): Promise<number | null> {
  const stable = STABLE[chainId];
  if (!stable) return null;
  const quote = await nordsternAdapter.getQuote(
    { underlyingAsset: NATIVE_ADDRESS, symbol: '', decimals: 18 },
    { underlyingAsset: stable.address, symbol: '', decimals: stable.decimals },
    ONE_NATIVE,
    // Slippage does not touch `toAmount`, which is the pre-slippage output — it only sets the
    // floor written into calldata this never asks for. Their documented default.
    0.5,
    chainId,
  );
  if (!quote) return null;
  const price = Number(formatUnits(BigInt(quote.amountOut), stable.decimals));
  return price > 0 ? price : null;
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
        // Asked together, and one failing does not take the other down — either source alone is
        // a usable price, and dropping both because one 500'd leaves the caller on the oracle.
        const [kyber, nordstern] = await Promise.all([
          kyberPrice(resolvedChainId, token).catch(reportAndSkip('KyberSwap')),
          nordsternPrice(resolvedChainId).catch(reportAndSkip('Nordstern')),
        ]);

        // The best rate on offer, which for the token you are SPENDING on gas is the highest
        // figure: it is the most USD anyone will give you for one native token. It also errs in
        // the safe direction for the callers — a higher native price reserves more for gas in
        // `maxAmount` and quotes a slightly dearer fee, rather than under-reserving.
        const best = Math.max(...[kyber, nordstern].filter((p): p is number => p !== null && p > 0));
        if (!cancelled && Number.isFinite(best)) {
          setQuoted({ chainId: resolvedChainId, price: best });
        }
      } catch (e) {
        if (!cancelled) console.error('Failed to fetch native price', e);
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
