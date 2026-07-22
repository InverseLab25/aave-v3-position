import type { Adapter, Asset, QuoteResponse, TransactionPayload } from './types';
import { formatUnits } from 'viem';
import { isNativeAddress, NATIVE_ZERO_ADDRESS } from './native';

// DefiLlama's swap API represents native ETH as the zero address, not the 0xEeee… sentinel.
const toOdosToken = (addr: string) => (isNativeAddress(addr) ? NATIVE_ZERO_ADDRESS : addr);

// Odos routed through DefiLlama's meta-aggregator, so only the DefiLlama key is
// required (no separate Odos key). DefiLlama's dexAggregatorQuote is one-shot:
// the userAddress is baked into the returned calldata, so getQuote fetches price
// only and buildTransaction re-fetches with the real caller.
//
// Deleverager-compatible: for Odos the approval spender (tokenApprovalAddress)
// equals the router call target, and no per-swap signature is needed
// (isSignatureNeededForSwap === false). The contract's minOut check backstops
// any bad/mis-shaped quote — a wrong output reverts rather than losing funds.
const DEFILLAMA_BASE = 'https://swap-api.defillama.com';
const DEFILLAMA_API_KEY = import.meta.env.VITE_DEFILLAMA_API_KEY as string | undefined;

// DefiLlama chain slugs for the networks we configure.
const DEFILLAMA_CHAIN: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avax',
};

interface DefiLlamaReq {
  chain: string;
  from: string;
  to: string;
  amount: string;
  slippage: number;
}

function buildUrl(req: DefiLlamaReq, userAddress?: string): string {
  const params = new URLSearchParams({
    protocol: 'Odos',
    chain: req.chain,
    from: req.from,
    to: req.to,
    amount: req.amount,
    slippage: String(req.slippage),
  });
  if (userAddress) params.set('userAddress', userAddress);
  if (DEFILLAMA_API_KEY) params.set('api_key', DEFILLAMA_API_KEY);
  return `${DEFILLAMA_BASE}/dexAggregatorQuote?${params.toString()}`;
}

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
      const chain = DEFILLAMA_CHAIN[chainId];
      if (!chain) return null;
      const req: DefiLlamaReq = {
        chain,
        from: toOdosToken(fromAsset.underlyingAsset),
        to: toOdosToken(toAsset.underlyingAsset),
        amount: amountIn,
        slippage,
      };
      const res = await fetch(buildUrl(req));
      if (!res.ok) return null;
      const json = await res.json();
      const amountOut = json?.amountReturned;
      // Skip if Odos would need a signature the deleverager can't produce.
      if (!amountOut || json.isSignatureNeededForSwap === true) return null;

      const amountOutEth = Number(formatUnits(BigInt(amountOut), toAsset.decimals));
      const amountOutUsd = toAsset.priceInUsd ? amountOutEth * Number(toAsset.priceInUsd) : 0;

      return {
        aggregator: 'Odos',
        amountIn,
        amountOut: amountOut.toString(),
        amountOutUsd: amountOutUsd.toFixed(2),
        // DefiLlama returns gas in units, not USD here; rank on output.
        gasUsd: '0',
        netReturnUsd: amountOutUsd,
        rawQuote: { req }, // enough to re-fetch with userAddress in buildTransaction
        routeDetails: { type: 'odos-defillama' },
      };
    } catch (e) {
      console.error('Odos (DefiLlama) fetch error', e);
      return null;
    }
  },

  buildTransaction: async (
    quote: QuoteResponse,
    _slippage: number,
    walletAddress: string,
  ): Promise<TransactionPayload> => {
    const { req } = quote.rawQuote as { req: DefiLlamaReq };
    const res = await fetch(buildUrl(req, walletAddress));
    if (!res.ok) throw new Error(`Odos (DefiLlama) build failed: ${res.status}`);
    const json = await res.json();
    if (json?.isSignatureNeededForSwap === true) {
      throw new Error('Odos quote unexpectedly requires a signature');
    }
    const tx = json?.rawQuote?.transaction;
    const spender = json?.tokenApprovalAddress;
    if (!tx?.to || !tx?.data || !spender) {
      throw new Error('Odos (DefiLlama) returned no transaction');
    }
    return {
      to: tx.to,
      data: tx.data,
      value: tx.value != null ? tx.value.toString() : '0',
      spender, // Odos: tokenApprovalAddress === router === transaction.to
    };
  },
};
