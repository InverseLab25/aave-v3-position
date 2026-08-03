import { useState, useEffect } from 'react';

export function useEthPrice() {
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const url = `https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE&tokenOut=0xdAC17F958D2ee523a2206206994597C13D831ec7&amountIn=1000000000000000000`
        const res = await fetch(url)
        const json = await res.json()
        
        if (json.code === 0 && json.data?.routeSummary?.amountOut) {
          // USDT has 6 decimals
          setPrice(Number(json.data.routeSummary.amountOut) / 1e6)
        }
      } catch (e) {
        console.error('Failed to fetch ETH price from Kyberswap', e)
      }
    };

    fetchPrice();
    const interval = setInterval(fetchPrice, 5000);
    return () => clearInterval(interval);
  }, []);

  return price;
}
