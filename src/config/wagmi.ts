import { http, createConfig } from 'wagmi'
import { createClient } from 'viem'
import { mainnet, sepolia, arbitrum, optimism, polygon, base, avalanche, bsc, baseSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

/** Per-chain RPC overrides. Chains without an entry fall back to the chain's public RPC. */
const RPC_URLS: Partial<Record<number, string>> = {
  [mainnet.id]: import.meta.env.VITE_RPC_URL,
  // Also lets a chain be pointed at a local fork for testing, without touching the others.
  [base.id]: import.meta.env.VITE_RPC_URL_8453,
}

export const config = createConfig({
  chains: [mainnet, arbitrum, optimism, polygon, base, avalanche, bsc, sepolia, baseSepolia],
  connectors: [injected()],
  // A client factory rather than a `transports` map, because `batch.multicall` is a viem
  // client option and is not reachable through `transports`.
  client({ chain }) {
    return createClient({
      chain,
      // Transport-level batching: coalesce concurrent JSON-RPC requests into one HTTP POST.
      transport: http(RPC_URLS[chain.id], { batch: true }),
      // eth_call-level batching: aggregate independent contract reads issued in the same
      // tick into a single Multicall3 call. Every chain configured above has Multicall3 at
      // the canonical 0xca11bde0…76ca11, so this applies everywhere.
      //
      // These two compose rather than overlap. Transport batching still sends N eth_calls,
      // just in one POST; multicall collapses them into one eth_call, so the node does one
      // state lookup instead of N. The dashboard issues several independent reads per load
      // (account data, e-mode, reserves, user reserves, then per-token balances and
      // allowances), which is exactly the shape this targets.
      batch: { multicall: true },
    })
  },
})
