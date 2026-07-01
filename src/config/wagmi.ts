import { http, createConfig } from 'wagmi'
import { mainnet, sepolia, arbitrum, polygon } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export const config = createConfig({
  chains: [mainnet, sepolia, arbitrum, polygon],
  connectors: [
    injected(),
  ],
  transports: {
    [mainnet.id]: http(import.meta.env.VITE_RPC_URL),
    [sepolia.id]: http(),
    [arbitrum.id]: http(),
    [polygon.id]: http(),
  },
})
