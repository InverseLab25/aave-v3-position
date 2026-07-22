import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';

/**
 * 0x Swap API v2 (AllowanceHolder), consumer-branded as "Matcha".
 *
 * Two-step like Odos: getQuote hits `/price` (indicative, no taker required) so it can
 * stream without a connected wallet; buildTransaction hits `/quote` with the real taker to
 * get the executable, unsigned transaction + the AllowanceHolder approval target (spender).
 *
 * Requires an API key in `VITE_ZEROX_API_KEY` (https://dashboard.0x.org). Without it every
 * request 401s and the adapter simply returns null (no route shown).
 *
 * 0x uses numeric chainId directly and the standard 0xEeee… sentinel for native ETH, so no
 * per-chain string map or native-address translation is needed. Slippage is passed in bps.
 */
const ZEROX_BASE = 'https://api.0x.org/swap/allowance-holder';
const ZEROX_API_KEY = import.meta.env.VITE_ZEROX_API_KEY as string | undefined;

// Chains we configure that 0x supports.
const ZEROX_CHAINS = new Set([1, 10, 56, 137, 8453, 42161, 43114]);

function zeroxHeaders(): HeadersInit {
  const h: Record<string, string> = { '0x-version': 'v2' };
  if (ZEROX_API_KEY) h['0x-api-key'] = ZEROX_API_KEY;
  return h;
}

export const zeroxAdapter: Adapter = {
  name: 'Matcha',
  supportsExecution: true,

  getQuote: async (fromAsset: Asset, toAsset: Asset, amountIn: string, slippage: number, chainId: number): Promise<QuoteResponse | null> => {
    try {
      if (!ZEROX_CHAINS.has(chainId)) return null;
      const params = new URLSearchParams({
        chainId: String(chainId),
        sellToken: fromAsset.underlyingAsset,
        buyToken: toAsset.underlyingAsset,
        sellAmount: amountIn,
        slippageBps: String(Math.round(slippage * 100)),
      });
      const res = await fetch(`${ZEROX_BASE}/price?${params.toString()}`, { headers: zeroxHeaders() });
      if (!res.ok) return null;
      const json = await res.json();
      if (json?.liquidityAvailable === false || !json?.buyAmount) return null;

      const amountOutEth = Number(formatUnits(BigInt(json.buyAmount), toAsset.decimals));
      const amountOutUsd = toAsset.priceInUsd ? amountOutEth * Number(toAsset.priceInUsd) : 0;

      return {
        aggregator: 'Matcha',
        amountIn: json.sellAmount ?? amountIn,
        amountOut: json.buyAmount,
        amountOutUsd: amountOutUsd.toFixed(2),
        // 0x returns gas as native wei (totalNetworkFee); without a native USD price we
        // can't convert it reliably, so rank on output like the other adapters do.
        gasUsd: '0',
        netReturnUsd: amountOutUsd,
        // Re-fetched with the real taker in buildTransaction.
        rawQuote: {
          chainId,
          sellToken: fromAsset.underlyingAsset,
          buyToken: toAsset.underlyingAsset,
          sellAmount: amountIn,
        },
        routeDetails: { type: '0x', info: 'Aggregated via 0x / Matcha' },
      };
    } catch (e) {
      console.error('0x (Matcha) fetch error', e);
      return null;
    }
  },

  buildTransaction: async (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number): Promise<TransactionPayload> => {
    const rq = quote.rawQuote as { chainId: number; sellToken: string; buyToken: string; sellAmount: string };
    const params = new URLSearchParams({
      chainId: String(rq.chainId ?? chainId),
      sellToken: rq.sellToken,
      buyToken: rq.buyToken,
      sellAmount: rq.sellAmount,
      taker: walletAddress,
      slippageBps: String(Math.round(slippage * 100)),
    });
    const res = await fetch(`${ZEROX_BASE}/quote?${params.toString()}`, { headers: zeroxHeaders() });
    if (!res.ok) throw new Error(`0x (Matcha) build failed: ${res.status}`);
    const json = await res.json();
    const tx = json?.transaction;
    if (json?.liquidityAvailable === false || !tx?.to || !tx?.data) {
      throw new Error(json?.reason || 'Failed to build 0x (Matcha) transaction');
    }

    // ERC-20 approval target for the AllowanceHolder flow (native sells need no approval).
    const spender = json.issues?.allowance?.spender ?? json.allowanceTarget ?? tx.to;
    return {
      to: tx.to,
      data: tx.data,
      value: tx.value ?? '0',
      spender,
    };
  },
};
