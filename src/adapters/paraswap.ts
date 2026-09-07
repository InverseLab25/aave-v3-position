import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';

/** Attribution. Velora keys its free-tier quota (1 RPS, 5k req/day) on this string, so sending
 *  our own puts us in our own bucket instead of sharing `anon` with every other integrator.
 *  It does not by itself collect a partner fee — that needs a registered ID, see Monetization. */
const PARTNER = (import.meta.env.VITE_VELORA_PARTNER as string | undefined) ?? 'defi-route';

/** The fields this adapter reads back out of ParaSwap's priceRoute payload. */
interface ParaSwapPriceRoute {
  srcToken: string;
  srcDecimals: number;
  destToken: string;
  destDecimals: number;
  srcAmount: string;
}

export const paraSwapAdapter: Adapter = {
  name: 'ParaSwap',
  supportsExecution: true,
  // Velora's free tier is 1 RPS and 5,000 requests/day counted against PARTNER across every
  // user we have, not per browser. The 2s refresh burns that in under an hour of real traffic,
  // so hold the floor here. Raising it only helps so far — the cap is global, this is not.
  minQuoteIntervalMs: 5_000,
  getQuote: async (fromAsset: Asset, toAsset: Asset, amountIn: string, _slippage: number, chainId: number): Promise<QuoteResponse | null> => {
    try {
      const url = `https://api.velora.xyz/prices/?srcToken=${fromAsset.underlyingAsset}&destToken=${toAsset.underlyingAsset}&amount=${amountIn}&srcDecimals=${fromAsset.decimals}&destDecimals=${toAsset.decimals}&partner=${PARTNER}&version=6.2&side=SELL&network=${chainId}&excludeDEXS=ParaSwapPool,ParaSwapLimitOrders`;
      
      const res = await fetch(url);
      const data = await res.json();
      
      if (!data.priceRoute) return null;

      const destAmount = data.priceRoute.destAmount;

      const amountOutEth = Number(formatUnits(BigInt(destAmount), toAsset.decimals));
      
      const destUSD = Number(data.priceRoute.destUSD || 0);
      const gasUSD = Number(data.priceRoute.gasCostUSD || 0);
      
      let amountOutUsd = destUSD;
      if (toAsset.priceInUsd) {
        amountOutUsd = amountOutEth * Number(toAsset.priceInUsd);
      }

      return {
        aggregator: 'ParaSwap',
        amountIn: data.priceRoute.srcAmount || amountIn,
        amountOut: destAmount,
        amountOutUsd: amountOutUsd.toFixed(2),
        gasUsd: gasUSD.toFixed(2),
        netReturnUsd: amountOutUsd - gasUSD,
        rawQuote: data.priceRoute,
        routeDetails: {
          type: 'paraswap',
          info: 'Aggregated via ParaSwap (Velora) v6.2'
        }
      };
    } catch (e) {
      console.error('ParaSwap fetch error', e);
      return null;
    }
  },

  buildTransaction: async (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number): Promise<TransactionPayload> => {
    const priceRoute = quote.rawQuote as ParaSwapPriceRoute;
    
    const url = `https://api.velora.xyz/transactions/${chainId}?ignoreChecks=true`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        srcToken: priceRoute.srcToken,
        srcDecimals: priceRoute.srcDecimals,
        destToken: priceRoute.destToken,
        destDecimals: priceRoute.destDecimals,
        slippage: slippage * 100,
        userAddress: walletAddress,
        partner: PARTNER,
        positiveSlippageToUser: false,
        priceRoute: priceRoute,
        srcAmount: priceRoute.srcAmount
      })
    });
    
    const json = await res.json();
    if (!json.to || !json.data) throw new Error(json.error || "Failed to build ParaSwap transaction");

    return {
      to: json.to,
      data: json.data,
      value: json.value || "0",
      // Augustus v6.2 has no separate TokenTransferProxy: the call target is the spender.
      spender: json.to
    };
  }
};
