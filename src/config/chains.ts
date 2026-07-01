import type { Asset } from '../adapters/types';

export interface ChainConfig {
  chainId: number;
  name: string;
  explorerUrl: string;
  aave: {
    poolAddress: `0x${string}`;
    uiPoolDataProvider: `0x${string}`;
    poolAddressesProvider: `0x${string}`;
  };
  adapters: string[];
  defaultTokens: Asset[];
}

export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    name: 'Ethereum',
    explorerUrl: 'https://etherscan.io',
    aave: {
      poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
      uiPoolDataProvider: '0x2dAd8162A989cd99D673dE4425Bb2298Db1E1aA2',
      poolAddressesProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
    },
    adapters: ['KyberSwap', 'OpenOcean', 'ParaSwap', 'CowSwap'],
    defaultTokens: [
      { underlyingAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
      { underlyingAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      { underlyingAsset: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    ],
  },
  11155111: {
    chainId: 11155111,
    name: 'Sepolia',
    explorerUrl: 'https://sepolia.etherscan.io',
    aave: {
      poolAddress: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
      uiPoolDataProvider: '0x69529987FA4A075D0C00B0128fa848dc9ebbE9CE',
      poolAddressesProvider: '0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A',
    },
    adapters: [],
    defaultTokens: [],
  },
};

export function getChainConfig(chainId: number | undefined): ChainConfig | null {
  if (!chainId) return null;
  return CHAIN_CONFIGS[chainId] ?? null;
}
