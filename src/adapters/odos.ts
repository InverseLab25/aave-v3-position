import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';

const ODOS_BASE = 'https://api.odos.xyz';

// Chains where Odos is live (superset of the Aave V3 networks we configure).
const ODOS_CHAINS = new Set([1, 10, 56, 137, 250, 324, 5000, 8453, 34443, 42161, 43114, 59144, 534352]);

// Optional Odos API key (public frontend var). Without it the endpoint works but
// is heavily rate-limited. Odos passes the key in the Authorization header.
const ODOS_API_KEY = import.meta.env.VITE_ODOS_API_KEY as string | undefined;
const odosHeaders = (): Record<string, string> => {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ODOS_API_KEY) h['Authorization'] = ODOS_API_KEY;
  return h;
};

/**
 * Odos aggregator. Two-step API: POST /sor/quote/v3 returns a `pathId`, then
 * POST /sor/assemble turns that pathId into an executable transaction.
 *
 * Deleverager-compatible: the assembled tx's approval spender equals its call
 * target (`transaction.to` is both the router and the ERC20 spender), it needs
 * no per-swap signature (Permit2 is opt-in only), and `receiver` directs the
 * output to any address — so the contract can approve `to`, call `to`, and
 * receive the output itself.
 */
export const odosAdapter: Adapter = {
  name: 'Odos',
  supportsExecution: true,

  getQuote: async (
    fromAsset: Asset,
    toAsset: Asset,
    amountIn: string,
    slippage: number,
    chainId: number,
  ): Promise<QuoteResponse | null> => {
    try {
      if (!ODOS_CHAINS.has(chainId)) return null;
      const res = await fetch(`${ODOS_BASE}/sor/quote/v3`, {
        method: 'POST',
        headers: odosHeaders(),
        body: JSON.stringify({
          chainId,
          inputTokens: [{ tokenAddress: fromAsset.underlyingAsset, amount: amountIn }],
          outputTokens: [{ tokenAddress: toAsset.underlyingAsset, proportion: 1 }],
          slippageLimitPercent: slippage,
          disableRFQs: true,
          compact: true,
        }),
      });
      if (!res.ok) return null;
      const json = await res.json();
      const amountOut = json?.outAmounts?.[0];
      if (!json?.pathId || !amountOut) return null;

      const amountOutEth = Number(formatUnits(BigInt(amountOut), toAsset.decimals));
      const amountOutUsd = toAsset.priceInUsd
        ? amountOutEth * Number(toAsset.priceInUsd)
        : Number(json.outValues?.[0] ?? 0);
      const gasUsd = Number(json.gasEstimateValue ?? 0);

      return {
        aggregator: 'Odos',
        amountIn,
        amountOut: amountOut.toString(),
        amountOutUsd: amountOutUsd.toFixed(2),
        gasUsd: gasUsd.toFixed(2),
        netReturnUsd: amountOutUsd - gasUsd,
        rawQuote: json, // holds pathId, needed by /sor/assemble
        routeDetails: { type: 'odos', pathId: json.pathId },
      };
    } catch (e) {
      console.error('Odos fetch error', e);
      return null;
    }
  },

  buildTransaction: async (
    quote: QuoteResponse,
    _slippage: number,
    walletAddress: string,
  ): Promise<TransactionPayload> => {
    const res = await fetch(`${ODOS_BASE}/sor/assemble`, {
      method: 'POST',
      headers: odosHeaders(),
      body: JSON.stringify({
        userAddr: walletAddress,
        pathId: quote.rawQuote.pathId,
        receiver: walletAddress, // send output to the caller (the deleverager on the close path)
        simulate: false, // caller may not hold the input yet (flash-loan flow) — skip the balance sim
      }),
    });
    if (!res.ok) throw new Error(`Odos assemble failed: ${res.status}`);
    const json = await res.json();
    const tx = json?.transaction;
    if (!tx?.to || !tx?.data) throw new Error('Odos assemble returned no transaction');

    return {
      to: tx.to,
      data: tx.data,
      value: tx.value != null ? tx.value.toString() : '0',
      spender: tx.to, // Odos: approval target === router === transaction.to
    };
  },
};
