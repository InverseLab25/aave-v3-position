/**
 * Brings local history up to date with the chain, once, for the chain the wallet is on.
 *
 * A position outlives the browser that opened it. `localStorage` is per-browser and per-device, so
 * a position opened on a laptop is invisible on a phone, and clearing site data loses the record
 * of one that plainly still exists on chain. `useRecordOutcome` covers only transactions this
 * browser sent while the app was open — and only if it stayed open long enough for the receipt.
 * This covers the rest, and repairs a row that was written wrong.
 *
 * It also feeds `historyBasis`, which replays these rows to price a position. With no rows there
 * is no average entry price, and the panel falls back to the indexer's oracle-priced figure.
 *
 * Once per connect, and nothing after: there used to be a `watchEvent` subscription per event per
 * chain polling forever — see the note further down for why it went.
 *
 * All of the reasoning lives in `lib/hashSync`; this is the wiring. Failures are reported and
 * retried, never thrown: nothing about reading history back is worth failing a screen for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChainId, useConfig, useConnection, useReadContracts } from 'wagmi'
import { getBlock, getTransactionReceipt } from 'viem/actions'
import {
  type Address,
  type Client,
} from 'viem'
import { getChainConfig, syncableChains } from '../config/chains'
import { uiPoolDataProviderAbi } from '../config/uiPoolDataProviderAbi'
import { browserStorage } from '../lib/delegationCache'
import { syncChainFromHashes, type HashSyncClient } from '../lib/hashSync'
import { fetchUserTxHashes } from '../lib/aaveTxHashes'
import { clearScreened } from '../lib/screenCache'
import { buildTokenMap, positionTokens, type TokenMeta } from '../lib/tokenMeta'

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
  const connectedChainId = useChainId()

  /**
   * The connected chain only, never every chain that has a deployment.
   *
   * Syncing all of them was speculative: the panel shows one chain's position and one chain's
   * history at a time, so a row recovered for a chain nobody is looking at is a request spent on
   * something invisible. Connected to Base and paying for Arbitrum reads is the whole of the cost
   * and none of the benefit — and switching chains re-runs this, which is when the other chain's
   * history is actually wanted.
   */
  const chains = useMemo(
    () => syncableChains().filter((c) => c.chainId === connectedChainId),
    [connectedChainId],
  )

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
   * There is no live subscription any more.
   *
   * There was one: a `watchEvent` filter per event per chain, polling every twelve seconds. With
   * two deployments that is four subscriptions calling `eth_getFilterChanges` — or `eth_getLogs`,
   * against a provider that will not hold a filter — forever, on chains the user was not on, and
   * competing for the same rate limit as the confirm modal's three-second re-quote.
   *
   * It bought very little. A transaction sent from this browser is recorded by `useRecordOutcome`
   * the moment its receipt lands, so the only thing the watcher added was noticing a position
   * opened on ANOTHER device — which the catch-up below finds on the next load, or immediately
   * when the user presses Resync.
   */

  const resync = useCallback(() => {
    clearScreened(browserStorage())
    setStatus((s) => ({ ...s, error: null }))
    setAttempt((n) => n + 1)
  }, [])

  return { status, resync }
}
