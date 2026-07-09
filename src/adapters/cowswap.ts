import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';

const getCowChain = (chainId: number): string => {
  switch (chainId) {
    case 1: return 'mainnet';
    case 100: return 'xdai';
    case 42161: return 'arbitrum_one';
    default: return 'mainnet';
  }
};

export const cowSwapAdapter: Adapter = {
  name: 'CowSwap',
  supportsExecution: false, // CowSwap uses EIP-712 signatures, not standard txs
  getQuote: async (fromAsset: Asset, toAsset: Asset, amountIn: string, _slippage: number, chainId: number): Promise<QuoteResponse | null> => {
    try {
      const chainStr = getCowChain(chainId);
      const url = `https://api.cow.fi/${chainStr}/api/v1/quote`;
      
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sellToken: fromAsset.underlyingAsset,
          buyToken: toAsset.underlyingAsset,
          receiver: '0x0000000000000000000000000000000000000000',
          appData: '0xf249b3db926aa5b5a1b18f3fec86b9cc99b9a8a99ad7e8034242d2838ae97422',
          partiallyFillable: false,
          sellTokenBalance: 'erc20',
          buyTokenBalance: 'erc20',
          from: '0x0000000000000000000000000000000000000000',
          signingScheme: 'eip712',
          onchainOrder: false,
          kind: 'sell',
          sellAmountBeforeFee: amountIn
        })
      });

      const data = await res.json();
      if (!data.quote || !data.quote.buyAmount) return null;

      const buyAmount = data.quote.buyAmount;
      const amountOutEth = Number(formatUnits(BigInt(buyAmount), toAsset.decimals));
      
      let amountOutUsd = 0;
      if (toAsset.priceInUsd) {
        amountOutUsd = amountOutEth * Number(toAsset.priceInUsd);
      } else {
        amountOutUsd = amountOutEth * 2000;
      }

      return {
        aggregator: 'CowSwap',
        amountIn: amountIn,
        amountOut: buyAmount,
        amountOutUsd: amountOutUsd.toFixed(2),
        gasUsd: '0.00',
        netReturnUsd: amountOutUsd,
        rawQuote: data.quote,
        routeDetails: {
          type: 'cowswap',
          info: 'Gasless batch execution via CowSwap'
        }
      };
    } catch (e) {
      console.error('CowSwap fetch error', e);
      return null;
    }
  },

 
 
 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
  buildTransaction: async (_quote: QuoteResponse, _slippage: number, _walletAddress: string, _chainId: number): Promise<TransactionPayload> => {
    throw new Error('CowSwap execution is not supported yet. It requires EIP-712 off-chain signatures.');
  }
};
