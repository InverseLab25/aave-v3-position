import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';

const PARASWAP_TOKEN_TRANSFER_PROXY = '0x216B4B4Ba9F3e719726886d34a177484278Bfcae';

export const paraSwapAdapter: Adapter = {
  name: 'ParaSwap',
  supportsExecution: true,
  getQuote: async (fromAsset: Asset, toAsset: Asset, amountIn: string, _slippage: number, chainId: number): Promise<QuoteResponse | null> => {
    try {
      const partner = 'llamaswap';
      const url = `https://apiv5.paraswap.io/prices/?srcToken=${fromAsset.underlyingAsset}&destToken=${toAsset.underlyingAsset}&amount=${amountIn}&srcDecimals=${fromAsset.decimals}&destDecimals=${toAsset.decimals}&partner=${partner}&side=SELL&network=${chainId}&excludeDEXS=ParaSwapPool,ParaSwapLimitOrders`;
      
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
          info: 'Aggregated via ParaSwap v5'
        }
      };
    } catch (e) {
      console.error('ParaSwap fetch error', e);
      return null;
    }
  },

  buildTransaction: async (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number): Promise<TransactionPayload> => {
    const partner = 'llamaswap';
    const priceRoute = quote.rawQuote;
    
    const url = `https://apiv5.paraswap.io/transactions/${chainId}?ignoreChecks=true`;
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
        partner: partner,
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
      spender: PARASWAP_TOKEN_TRANSFER_PROXY
    };
  }
};
