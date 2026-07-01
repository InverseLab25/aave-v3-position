import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';

const getKyberChain = (chainId: number): string => {
  switch (chainId) {
    case 1: return 'ethereum';
    case 10: return 'optimism';
    case 56: return 'bsc';
    case 137: return 'polygon';
    case 250: return 'fantom';
    case 8453: return 'base';
    case 42161: return 'arbitrum';
    case 43114: return 'avalanche';
    default: return 'ethereum';
  }
};

export const kyberSwapAdapter: Adapter = {
  name: 'KyberSwap',
  supportsExecution: true,
  getQuote: async (fromAsset: Asset, toAsset: Asset, amountIn: string, _slippage: number, chainId: number): Promise<QuoteResponse | null> => {
    try {
      const chainStr = getKyberChain(chainId);
      const url = `https://aggregator-api.kyberswap.com/${chainStr}/api/v1/routes?tokenIn=${fromAsset.underlyingAsset}&tokenOut=${toAsset.underlyingAsset}&amountIn=${amountIn}&gasInclude=true`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.code !== 0 || !json.data?.routeSummary) return null;

      const amountOutEth = Number(formatUnits(BigInt(json.data.routeSummary.amountOut), toAsset.decimals));
      const amountOutUsd = toAsset.priceInUsd 
        ? amountOutEth * Number(toAsset.priceInUsd)
        : Number(json.data.routeSummary.amountOutUsd);
      const gasUsd = Number(json.data.routeSummary.gasUsd);

      return {
        aggregator: 'KyberSwap',
        amountIn: json.data.routeSummary.amountIn,
        amountOut: json.data.routeSummary.amountOut,
        amountOutUsd: amountOutUsd.toFixed(2),
        gasUsd: gasUsd.toFixed(2),
        netReturnUsd: amountOutUsd - gasUsd,
        rawQuote: json.data.routeSummary,
        routeDetails: {
          type: 'kyber',
          totalAmountIn: BigInt(json.data.routeSummary.amountIn),
          paths: json.data.routeSummary.route
        }
      };
    } catch (e) {
      console.error('KyberSwap fetch error', e);
      return null;
    }
  },
  
  buildTransaction: async (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number): Promise<TransactionPayload> => {
    const chainStr = getKyberChain(chainId);
    const url = `https://aggregator-api.kyberswap.com/${chainStr}/api/v1/route/build`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routeSummary: quote.rawQuote,
        sender: walletAddress,
        recipient: walletAddress,
        slippageTolerance: slippage * 100
      })
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.message);
    
    return {
      to: json.data.routerAddress,
      data: json.data.data,
      value: "0",
      spender: json.data.routerAddress
    };
  }
};
