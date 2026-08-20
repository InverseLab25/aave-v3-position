import { http, createConfig } from 'wagmi'
import { createClient } from 'viem'
import { mainnet, sepolia, arbitrum, optimism, polygon, base, avalanche, bsc, baseSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

/**
 * Per-chain RPC overrides, `VITE_RPC_URL_<chainId>`. Chains without an entry fall back to the
 * chain's public RPC, which is a shared node with a rate limit meant for occasional use.
 *
 * Written out one line per chain rather than looked up by id, because Vite only substitutes
 * literal `import.meta.env.X` accesses at build time — a computed key reads as undefined in a
 * production bundle, which fails the same silent way as having no entry at all. `chains.ts` spells
 * its `VITE_STRATEGIES_ADDRESS_*` reads out for the same reason.
 *
 * Also lets a chain be pointed at a local fork for testing, without touching the others.
 */
const RPC_URLS: Partial<Record<number, string>> = {
  // `VITE_RPC_URL` is the original, pre-per-chain name for this one. Still honoured so an
  // existing .env keeps working; `VITE_RPC_URL_1` wins where both are set.
  [mainnet.id]: import.meta.env.VITE_RPC_URL_1 ?? import.meta.env.VITE_RPC_URL,
  [optimism.id]: import.meta.env.VITE_RPC_URL_10,
  [bsc.id]: import.meta.env.VITE_RPC_URL_56,
  [polygon.id]: import.meta.env.VITE_RPC_URL_137,
  [base.id]: import.meta.env.VITE_RPC_URL_8453,
  [arbitrum.id]: import.meta.env.VITE_RPC_URL_42161,
  [avalanche.id]: import.meta.env.VITE_RPC_URL_43114,
  [sepolia.id]: import.meta.env.VITE_RPC_URL_11155111,
  [baseSepolia.id]: import.meta.env.VITE_RPC_URL_84532,
}

/**
 * Calls per JSON-RPC POST.
 *
 * viem's default is 1000, which no public node accepts. Base's is the strictest of the ones this
 * app talks to and answers a batch of eleven with `-32014 maximum 10 calls in 1 batch` — the whole
 * array, so one oversized POST loses every read in it, not just the eleventh. A history sync runs
 * twenty receipt reads at once (`RECEIPT_CONCURRENCY`), so that was every sync.
 *
 * Kept at 10 even for chains pointed at a paid endpoint: the cost of splitting is one extra POST,
 * and a limit that only holds when the env is fully configured is a limit that breaks on the first
 * machine that isn't.
 */
const RPC_BATCH_SIZE = 10

export const config = createConfig({
  chains: [mainnet, arbitrum, optimism, polygon, base, avalanche, bsc, sepolia, baseSepolia],
  connectors: [injected()],
  // A client factory rather than a `transports` map, because `batch.multicall` is a viem
  // client option and is not reachable through `transports`.
  client({ chain }) {
    return createClient({
      chain,
      // Transport-level batching: coalesce concurrent JSON-RPC requests into one HTTP POST.
      transport: http(RPC_URLS[chain.id], { batch: { batchSize: RPC_BATCH_SIZE } }),
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
