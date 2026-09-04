import { http, createConfig } from 'wagmi'
import { createClient } from 'viem'
import { mainnet, sepolia, arbitrum, optimism, polygon, base, baseSepolia } from 'wagmi/chains'
import { RPC_URLS } from './rpc'


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
  chains: [mainnet, arbitrum, optimism, polygon, base, sepolia, baseSepolia],
  // None configured explicitly, deliberately. wagmi's EIP-6963 discovery is on by default, so
  // every installed wallet announces itself under its own name — and a generic `injected()`
  // alongside it is the SAME provider listed a second time, which is a duplicate row in the
  // picker and a `ConnectorAlreadyConnectedError` if the user takes the wrong one. Discovery
  // also means a wallet only appears when it is actually installed.
  connectors: [],
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
