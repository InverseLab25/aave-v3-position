import { http, createConfig } from 'wagmi'
import { mainnet, sepolia, arbitrum, optimism, polygon, base, avalanche, bsc, baseSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

// batch: true coalesces concurrent eth_calls into a single JSON-RPC HTTP request.
// The Aave dashboard fires many reads per load (account data + reserves + user
// reserves, plus the deleverager's token/balance reads), so this cuts round-trips.
const batched = (url?: string) => http(url, { batch: true })

export const config = createConfig({
  chains: [mainnet, arbitrum, optimism, polygon, base, avalanche, bsc, sepolia, baseSepolia],
  connectors: [
    injected(),
  ],
  transports: {
    [mainnet.id]: batched(import.meta.env.VITE_RPC_URL),
    [arbitrum.id]: batched(),
    [optimism.id]: batched(),
    [polygon.id]: batched(),
    [base.id]: batched(),
    [avalanche.id]: batched(),
    [bsc.id]: batched(),
    [sepolia.id]: batched(),
    [baseSepolia.id]: batched(),
  },
})
