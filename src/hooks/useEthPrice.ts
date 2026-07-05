import { useState, useEffect } from 'react';

export function useEthPrice() {
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const apiKey = import.meta.env.VITE_ETHERSCAN_API_KEY || '';
        const url = `https://api.etherscan.io/v2/api?chainid=1&module=stats&action=ethprice&apikey=${apiKey}`;
        const res = await fetch(url);
        const json = await res.json();
        
        if (json.status === '1' && json.result?.ethusd) {
          setPrice(Number(json.result.ethusd));
        }
      } catch (e) {
        console.error('Failed to fetch ETH price from Etherscan', e);
      }
    };

    fetchPrice();
    // ETH price for a header badge doesn't need 5s granularity; 30s cuts the
    // Etherscan request volume ~6x (and the on-chain WETH price is preferred
    // when a position is loaded — see App.tsx).
    const interval = setInterval(fetchPrice, 30000);
    return () => clearInterval(interval);
  }, []);

  return price;
}
