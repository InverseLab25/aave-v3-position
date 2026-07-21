import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';

const getOpenOceanChain = (chainId: number): string | null => {
  switch (chainId) {
    case 1: return 'eth';
    case 10: return 'optimism';
    case 56: return 'bsc';
    case 137: return 'polygon';
    case 250: return 'fantom';
    case 8453: return 'base';
    case 42161: return 'arbitrum';
    case 43114: return 'avax';
    default: return null; // unsupported chain — don't silently quote on eth
  }
};

export const openOceanAdapter: Adapter = {
  name: 'OpenOcean',
  supportsExecution: true,
  getQuote: async (fromAsset: Asset, toAsset: Asset, amountIn: string, slippage: number, chainId: number): Promise<QuoteResponse | null> => {
    try {
      const chainStr = getOpenOceanChain(chainId);
      if (!chainStr) return null;
      const gasRes = await fetch(`https://open-api.openocean.finance/v4/${chainStr}/gasPrice`);
      const gasText = await gasRes.text();
      let gasJson;
      try {
        gasJson = JSON.parse(gasText);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
// eslint-disable-next-line preserve-caught-error
        throw new Error("OpenOcean blocked (gas): " + gasText.slice(0, 50));
      }
      const gasPrice = gasJson.data?.fast?.maxFeePerGas ?? gasJson.data?.fast ?? 500000000;
      const formattedAmount = formatUnits(BigInt(amountIn), fromAsset.decimals);

      // OpenOcean v4 expects slippage as a PERCENT (1 = 1%), unlike Kyber/Paraswap which take
      // basis points. `slippage` is already a percent here, so pass it through directly —
      // multiplying by 100 sends e.g. 100 for a 1% setting, which OpenOcean rejects (and 50 = 50%).
      const url = `https://open-api.openocean.finance/v4/${chainStr}/quote?inTokenAddress=${fromAsset.underlyingAsset}&outTokenAddress=${toAsset.underlyingAsset}&amount=${formattedAmount}&gasPrice=${gasPrice}&slippage=${slippage}`;
      const res = await fetch(url);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
// eslint-disable-next-line preserve-caught-error
        throw new Error("OpenOcean blocked (swap): " + text.slice(0, 50));
      }

      // 429 / 403 API Error blocks disguised as 200 JSON
      if (json.code !== 200 && json.error) throw new Error("OpenOcean API Error: " + json.error);
      if (!json || !json.data || !json.data.outAmount) return null;

      // Extract swap result nested inside data object
      const result = json.data;

      const estimatedGasWei = BigInt(result.estimatedGas || '200000') * BigInt(gasPrice);
      const gasEth = Number(formatUnits(estimatedGasWei, 18));
      const gasUsd = gasEth * (result.outToken?.price || 2000);

      const amountOutEth = Number(formatUnits(BigInt(result.outAmount), result.outToken?.decimals || 18));
      const amountOutUsd = toAsset.priceInUsd
        ? amountOutEth * Number(toAsset.priceInUsd)
        : amountOutEth * (result.outToken?.price || 0);

      return {
        aggregator: 'OpenOcean',
        amountIn: result.inAmount,
        amountOut: result.outAmount,
        amountOutUsd: amountOutUsd.toFixed(2),
        gasUsd: gasUsd.toFixed(2),
        netReturnUsd: amountOutUsd - gasUsd,
        rawQuote: result,
        routeDetails: {
          type: 'openocean',
          info: 'Aggregated via OpenOcean Core'
        }
      };
    } catch (e) {
      console.error('OpenOcean fetch error', e);
      return null;
    }
  },

  buildTransaction: async (quote: QuoteResponse, slippage: number, walletAddress: string, chainId: number): Promise<TransactionPayload> => {
    const chainStr = getOpenOceanChain(chainId);
    if (!chainStr) throw new Error(`OpenOcean: unsupported chain ${chainId}`);
    const gasPrice = quote.rawQuote.gasPrice || 500000000;
    const formattedAmount = formatUnits(BigInt(quote.rawQuote.inAmount), quote.rawQuote.inToken.decimals);
    // OpenOcean v4 slippage is a PERCENT (1 = 1%), not basis points — pass `slippage` as-is.
    const url = `https://open-api.openocean.finance/v4/${chainStr}/swap?inTokenAddress=${quote.rawQuote.inToken.address}&outTokenAddress=${quote.rawQuote.outToken.address}&amount=${formattedAmount}&gasPrice=${gasPrice}&slippage=${slippage}&account=${walletAddress}`;
    
    const res = await fetch(url);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
// eslint-disable-next-line preserve-caught-error
      throw new Error("OpenOcean API blocked: " + text.slice(0, 50));
    }

    if (json.code !== 200 && json.error) throw new Error("OpenOcean API Error: " + json.error);
    if (!json || !json.data || !json.data.data) throw new Error("Failed to build OpenOcean transaction");

    return {
      to: json.data.to,
      data: json.data.data,
      value: json.data.value || "0",
      spender: json.data.to // OpenOcean router is also the spender
    };
  }
};
