import type { Asset } from '../adapters/types';

export interface ChainConfig {
  chainId: number;
  name: string;
  explorerUrl: string;
  aave: {
    poolAddress: `0x${string}`;
    uiPoolDataProvider: `0x${string}`;
    poolAddressesProvider: `0x${string}`;
    wethGateway?: `0x${string}`;
    deleverager?: `0x${string}`;
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
      wethGateway: '0xd01607c3C5eCABa394D8be377a08590149325722',
      deleverager: (import.meta.env.VITE_DELEVERAGER_ADDRESS_1 ?? '') as `0x${string}`,
    },
    adapters: ['KyberSwap', 'OpenOcean', 'ParaSwap', 'CowSwap', 'Odos'],
    defaultTokens: [
      { underlyingAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
      { underlyingAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      { underlyingAsset: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    ],
  },
  10: {
    chainId: 10,
    name: 'Optimism',
    explorerUrl: 'https://optimistic.etherscan.io',
    aave: {
      poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      uiPoolDataProvider: '0x68100bD5345eA474D93577127C11F39FF8463e93',
      poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
      wethGateway: '0x5f2508cAE9923b02316254026CD43d7902866725',
      deleverager: (import.meta.env.VITE_DELEVERAGER_ADDRESS_10 ?? '') as `0x${string}`,
    },
    adapters: ['KyberSwap', 'OpenOcean', 'ParaSwap', 'Odos'],
    defaultTokens: [
      { underlyingAsset: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
      { underlyingAsset: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', symbol: 'USDC', decimals: 6 },
      { underlyingAsset: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6 },
    ],
  },
  56: {
    chainId: 56,
    name: 'BNB Chain',
    explorerUrl: 'https://bscscan.com',
    aave: {
      poolAddress: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
      uiPoolDataProvider: '0x68100bD5345eA474D93577127C11F39FF8463e93',
      poolAddressesProvider: '0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D',
      wethGateway: '0x0c2C95b24529664fE55D4437D7A31175CFE6c4f7',
      deleverager: (import.meta.env.VITE_DELEVERAGER_ADDRESS_56 ?? '') as `0x${string}`,
    },
    adapters: ['KyberSwap', 'OpenOcean', 'ParaSwap', 'Odos'],
    defaultTokens: [
      { underlyingAsset: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', decimals: 18 },
      { underlyingAsset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
      { underlyingAsset: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    ],
  },
  137: {
    chainId: 137,
    name: 'Polygon',
    explorerUrl: 'https://polygonscan.com',
    aave: {
      poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      uiPoolDataProvider: '0x66E1aBdb06e7363a618D65a910c540dfED23754f',
      poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
      wethGateway: '0xBC302053db3aA514A3c86B9221082f162B91ad63',
      deleverager: (import.meta.env.VITE_DELEVERAGER_ADDRESS_137 ?? '') as `0x${string}`,
    },
    adapters: ['KyberSwap', 'OpenOcean', 'ParaSwap', 'Odos'],
    defaultTokens: [
      { underlyingAsset: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WPOL', decimals: 18 },
      { underlyingAsset: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC', decimals: 6 },
      { underlyingAsset: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6 },
    ],
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    explorerUrl: 'https://basescan.org',
    aave: {
      poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
      uiPoolDataProvider: '0x0C6BC4a12039788be08F87e87Cff87FEDbd1D386',
      poolAddressesProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
      wethGateway: '0xa0d9C1E9E48Ca30c8d8C3B5D69FF5dc1f6DFfC24',
      deleverager: (import.meta.env.VITE_DELEVERAGER_ADDRESS_8453 ?? '') as `0x${string}`,
    },
    adapters: ['KyberSwap', 'OpenOcean', 'ParaSwap', 'Odos'],
    defaultTokens: [
      { underlyingAsset: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
      { underlyingAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
    ],
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum',
    explorerUrl: 'https://arbiscan.io',
    aave: {
      poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      uiPoolDataProvider: '0x91E04cf78e53aEBe609e8a7f2003e7EECD743F2B',
      poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
      wethGateway: '0x5283BEcEd7ADF6D003225C13896E536f2D4264FF',
      deleverager: (import.meta.env.VITE_DELEVERAGER_ADDRESS_42161 ?? '') as `0x${string}`,
    },
    adapters: ['KyberSwap', 'OpenOcean', 'ParaSwap', 'CowSwap', 'Odos'],
    defaultTokens: [
      { underlyingAsset: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
      { underlyingAsset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
      { underlyingAsset: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
    ],
  },
  43114: {
    chainId: 43114,
    name: 'Avalanche',
    explorerUrl: 'https://snowtrace.io',
    aave: {
      poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      uiPoolDataProvider: '0xFBa4Df643205c5400BC3e05a1E67E0dFaEeeb41F',
      poolAddressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
      wethGateway: '0x2825cE5921538d17cc15Ae00a8B24fF759C6CDaE',
      deleverager: (import.meta.env.VITE_DELEVERAGER_ADDRESS_43114 ?? '') as `0x${string}`,
    },
    adapters: ['KyberSwap', 'OpenOcean', 'ParaSwap', 'Odos'],
    defaultTokens: [
      { underlyingAsset: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', symbol: 'WAVAX', decimals: 18 },
      { underlyingAsset: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', decimals: 6 },
      { underlyingAsset: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', decimals: 6 },
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
      wethGateway: '0x387d311e47e80b498169e6fb51d3193167d89F7D',
    },
    adapters: [],
    defaultTokens: [],
  },
  84532: {
    chainId: 84532,
    name: 'Base Sepolia',
    explorerUrl: 'https://sepolia.basescan.org',
    aave: {
      poolAddress: '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27',
      uiPoolDataProvider: '0x3cB7B00B6C09B71998124196691e8bF2694De863',
      poolAddressesProvider: '0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00',
      wethGateway: '0x0568130e794429D2eEBC4dafE18f25Ff1a1ed8b6',
    },
    adapters: [],
    defaultTokens: [],
  },
};

export function getChainConfig(chainId: number | undefined): ChainConfig | null {
  if (!chainId) return null;
  return CHAIN_CONFIGS[chainId] ?? null;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The configured deleverager for a chain, or null when unset/zero/malformed. */
export function getDeleveragerAddress(chainId: number | undefined): `0x${string}` | null {
  const addr = getChainConfig(chainId)?.aave.deleverager;
  if (!addr || addr === ZERO_ADDRESS || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  return addr;
}
