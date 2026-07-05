import { http, createConfig } from 'wagmi'
import { mainnet, sepolia, arbitrum, optimism, polygon, base, avalanche, bsc, baseSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export const config = createConfig({
  chains: [mainnet, arbitrum, optimism, polygon, base, avalanche, bsc, sepolia, baseSepolia],
  connectors: [
    injected(),
  ],
  transports: {
    [mainnet.id]: http(import.meta.env.VITE_RPC_URL),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [base.id]: http(),
    [avalanche.id]: http(),
    [bsc.id]: http(),
    [sepolia.id]: http(),
    [baseSepolia.id]: http(),
  },
})
