/**
 * Keeps local history in step with the chain, for every chain this wallet could have used one on.
 *
 * There is no backend to push from, so the closest equivalent is built here: the node holds an
 * event filter keyed to this wallet's address, and the app asks it what has changed. A catch-up
 * scan runs when a wallet connects, and a `watchEvent` subscription covers everything after that
 * — including a position opened from another device, which the live recorder can never see.
 *
 * All of the reasoning lives in `lib/historySync`; this is the wiring. Failures are reported and
 * retried, never thrown: nothing about reading history back is worth failing a screen for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfig, useConnection, useReadContracts } from 'wagmi'
import { getBlock, getTransactionReceipt, watchEvent } from 'viem/actions'
import {
  type Address,
  type Client,
} from 'viem'
import { getChainConfig, syncableChains } from '../config/chains'
import { uiPoolDataProviderAbi } from '../config/uiPoolDataProviderAbi'
import { browserStorage } from '../lib/delegationCache'
import { syncChainFromHashes, type HashSyncClient } from '../lib/hashSync'
import { fetchUserTxHashes } from '../lib/aaveTxHashes'
import {
  POSITION_CLOSED,
  POSITION_OPENED,
} from '../lib/strategiesLogs'
import { clearScreened } from '../lib/screenCache'
import { buildTokenMap, positionTokens, type TokenMeta } from '../lib/tokenMeta'

/**
 * How often the live subscription asks the node what has changed.
 *
 * Slower than the wallet-facing default because nothing here is being waited on: a position opened
 * on another device showing up ten seconds later than it could have costs nothing, and a filter
 * per chain polling every four seconds is background traffic a user never asked for.
 */
const WATCH_INTERVAL_MS = 12_000

/** Reserve lists change when Aave lists a market. Once per session is more than often enough. */
const RESERVE_STALE_MS = 10 * 60_000

export interface HistorySyncStatus {
  /** A catch-up scan is in flight on at least one chain. */
  scanning: boolean
  /** The most recent failure, or null. Reported rather than thrown. */
  error: string | null
  /** When the last chain finished successfully, in unix milliseconds. */
  syncedAt: number | null
}

export interface HistorySync {
  status: HistorySyncStatus
  /** Forgets every cursor and re-reads each chain from its deployment block. */
  resync: () => void
}

/** What a reserve read gives back, reduced to the two questions a history row asks of it. */
interface ReserveShape {
  symbol: string
  decimals: bigint
  underlyingAsset: Address
  aTokenAddress: Address
  variableDebtTokenAddress: Address
}

interface ChainMeta {
  tokens: Record<string, TokenMeta>
  hidden: Address[]
}

/**
 * viem's tree-shaken actions against a wagmi client, in the shape `syncChain` asks for.
 *
 * `config.getClient` returns the client built in `config/wagmi.ts` — batching and all — rather
 * than a second one pointed at the same RPC. It carries no public actions of its own, hence the
 * standalone action imports.
 */
function syncClient(client: Client): HashSyncClient {
  return {
    getTransactionReceipt: async ({ hash }) => {
      const receipt = await getTransactionReceipt(client, { hash })
      return {
        hash,
        to: receipt.to,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs,
      }
    },
    getBlock: ({ blockNumber }) => getBlock(client, { blockNumber }),
  }
}

export function useHistorySync(): HistorySync {
  const { address: wallet } = useConnection()
  const config = useConfig()

  // Static config, so the list is fixed for the life of the app — but a fresh array every call
  // would restart every effect below on each render.
  const chains = useMemo(() => syncableChains(), [])

  const { data: reserveData } = useReadContracts({
    contracts: chains.map((chain) => ({
      chainId: chain.chainId,
      address: getChainConfig(chain.chainId)?.aave.uiPoolDataProvider,
      abi: uiPoolDataProviderAbi,
      functionName: 'getReservesData',
      args: [getChainConfig(chain.chainId)?.aave.poolAddressesProvider],
    })),
    query: { enabled: !!wallet && chains.length > 0, staleTime: RESERVE_STALE_MS },
  })

  /**
   * Token names and position tokens per chain.
   *
   * The panel only ever loads reserves for the chain being VIEWED, so without this a backfilled
   * Arbitrum row would read "1234567 raw units" against a bare address — and the aToken and
   * variable-debt rows, which Aave mints straight to the user, would pad every entry with a second
   * copy of what the position panel already says.
   */
  const meta = useMemo(() => {
    const byChain = new Map<number, ChainMeta>()
    chains.forEach((chain, i) => {
      const result = reserveData?.[i]
      if (result?.status !== 'success') return
      const [reserves] = result.result as unknown as [readonly ReserveShape[], unknown]
      const sources = reserves.map((r) => ({
        symbol: r.symbol,
        decimals: Number(r.decimals),
        underlyingAsset: r.underlyingAsset,
        aTokenAddress: r.aTokenAddress,
        variableDebtTokenAddress: r.variableDebtTokenAddress,
      }))
      byChain.set(chain.chainId, { tokens: buildTokenMap(sources), hidden: positionTokens(sources) })
    })
    return byChain
  }, [chains, reserveData])

  const [status, setStatus] = useState<HistorySyncStatus>({
    scanning: false,
    error: null,
    syncedAt: null,
  })

  /** Chains with a scan in flight, so a watcher firing mid-scan does not start a second one. */
  const running = useRef(new Set<number>())
  /** Bumped by `resync` to re-run the catch-up effect on demand. */
  const [attempt, setAttempt] = useState(0)

  const runChain = useCallback(
    async (chainId: number) => {
      const chain = chains.find((c) => c.chainId === chainId)
      const chainMeta = meta.get(chainId)
      if (!wallet || !chain || !chainMeta || running.current.has(chainId)) return

      running.current.add(chainId)
      setStatus((s) => ({ ...s, scanning: true }))
      try {
        // Cast at this one boundary: `getClient` is typed to the configured chain ids, and
        // `syncableChains` only ever yields ids that are in that list.
        const client = config.getClient({ chainId: chainId as (typeof config.chains)[number]['id'] })

        // Discovery goes through Aave's indexer. A leveraged open is a supply and a borrow, so
        // it has a row for every one — which turns discovery into a point lookup per candidate
        // transaction instead of walking the chain from the deployment block in windows a
        // provider may cap at any size. On a real Base account that is three receipts rather than
        // roughly forty `eth_getLogs`, and zero receipts once the screen cache is warm.
        const market = getChainConfig(chainId)?.aave.poolAddress
        if (!market) return

        await syncChainFromHashes({
          client: syncClient(client),
          storage: browserStorage(),
          strategies: chain.address,
          wallet,
          chainId,
          hashes: await fetchUserTxHashes({ user: wallet, chainId, market }),
          tokens: chainMeta.tokens,
          hidden: chainMeta.hidden,
        })
        setStatus((s) => ({ ...s, error: null, syncedAt: Date.now() }))
      } catch (error) {
        // Reported, never thrown. A rate-limited RPC must not take a position panel down with it,
        // and `syncChainFromHashes` has already guaranteed that a failure changed nothing.
        setStatus((s) => ({ ...s, error: error instanceof Error ? error.message : 'sync failed' }))
      } finally {
        running.current.delete(chainId)
        if (running.current.size === 0) setStatus((s) => ({ ...s, scanning: false }))
      }
    },
    [chains, config, meta, wallet],
  )

  // The catch-up. Runs per wallet, once the reserves needed to name what it finds have loaded.
  useEffect(() => {
    if (!wallet) return
    for (const chain of chains) {
      if (meta.has(chain.chainId)) void runChain(chain.chainId)
    }
  }, [wallet, chains, meta, runChain, attempt])

  /**
   * The live subscription — the part standing in for a backend.
   *
   * One filter per chain covering both events, narrowed to this wallet by the node. A matching log
   * only TRIGGERS a sync rather than being decoded here, so every row still arrives through the
   * same scan-build-merge path, cursor and all.
   */
  useEffect(() => {
    if (!wallet) return
    const unwatchers = chains.flatMap((chain) => {
      try {
        const client = config.getClient({
          chainId: chain.chainId as (typeof config.chains)[number]['id'],
        })
        // One watcher per event: an `args` filter needs a single event, and letting the node do
        // the narrowing is what keeps this from waking on every other user's position.
        return [POSITION_OPENED, POSITION_CLOSED].map((event) =>
          watchEvent(client, {
            address: chain.address,
            event,
            args: { user: wallet },
            pollingInterval: WATCH_INTERVAL_MS,
            onLogs: () => void runChain(chain.chainId),
            // A provider that cannot hold a filter falls back to polling `getLogs`; either way a
            // subscription that errors must not become an unhandled rejection.
            onError: () => {},
          }),
        )
      } catch {
        return []
      }
    })
    return () => unwatchers.forEach((unwatch) => unwatch())
  }, [wallet, chains, config, runChain])

  const resync = useCallback(() => {
    clearScreened(browserStorage())
    setStatus((s) => ({ ...s, error: null }))
    setAttempt((n) => n + 1)
  }, [])

  return { status, resync }
}
