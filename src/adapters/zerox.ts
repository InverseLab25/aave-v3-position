import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';

/**
 * 0x Swap API v2 (AllowanceHolder). Named `0x` here; Socket's route through the same venue is
 * `Socket/0x`, so the two never share a key.
 *
 * Two-step like Odos: getQuote hits `/price` (indicative, no taker required) so it can
 * stream without a connected wallet; buildTransaction hits `/quote` with the real taker to
 * get the executable, unsigned transaction + the AllowanceHolder approval target (spender).
 *
 * Requests go through the same-origin `/api/zerox`, served by `api/zerox.js` deployed, which
 * adds the key (`ZEROX_API_KEY`, https://dashboard.0x.org) and the version header on the way
 * through. Without a key every request 401s and the adapter simply returns null (no route shown).
 *
 * 0x uses numeric chainId directly and the standard 0xEeee… sentinel for native ETH, so no
 * per-chain string map or native-address translation is needed. Slippage is passed in bps.
 */
const ZEROX_BASE = '/api/zerox/swap/allowance-holder';

// Chains we configure that 0x supports.
const ZEROX_CHAINS = new Set([1, 10, 137, 8453, 42161]);

export const zeroxAdapter: Adapter = {
  name: '0x',
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
      const res = await fetch(`${ZEROX_BASE}/price?${params.toString()}`);
      if (!res.ok) return null;
      const json = await res.json();
      if (json?.liquidityAvailable === false || !json?.buyAmount) return null;

      const amountOutEth = Number(formatUnits(BigInt(json.buyAmount), toAsset.decimals));
      const amountOutUsd = toAsset.priceInUsd ? amountOutEth * Number(toAsset.priceInUsd) : 0;

      return {
        aggregator: '0x',
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
        routeDetails: { type: '0x', info: 'Aggregated via 0x' },
      };
    } catch (e) {
      console.error('0x fetch error', e);
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
    const res = await fetch(`${ZEROX_BASE}/quote?${params.toString()}`);
    if (!res.ok) throw new Error(`0x build failed: ${res.status}`);
    const json = await res.json();
    const tx = json?.transaction;
    if (json?.liquidityAvailable === false || !tx?.to || !tx?.data) {
      throw new Error(json?.reason || 'Failed to build 0x transaction');
    }

    // ERC-20 approval target for the AllowanceHolder flow (native sells need no approval).
    const spender = json.issues?.allowance?.spender ?? json.allowanceTarget ?? tx.to;
    return {
      to: tx.to,
      data: tx.data,
      value: tx.value ?? '0',
      spender,
      // The build's own figure, so the route ranks on it when nothing simulates; and the
      // quoted gas, so the per-chain gas bar in validateSwapTx can refuse an oversized route.
      amountOut: json.buyAmount,
      gasEstimate: tx.gas,
    };
  },
};
