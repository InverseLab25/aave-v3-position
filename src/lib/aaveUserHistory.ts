/**
 * This wallet's Aave transaction history, fetched once and shared.
 *
 * Two things need it and used to fetch it separately. `useAaveHistoricalInterest` replays the
 * amounts to price a position; `useHistorySync` wants only the hashes, so it can read each receipt
 * and recover positions this browser never saw. Both walked the same paginated endpoint, with the
 * same user, chain and market, at the same time — two round trips of roughly a second each for one
 * answer, and two shares of the indexer's rate limit.
 *
 * One query now selects the union of what they ask for, and both read it out of the same
 * react-query entry. The hash side derives its list with `positionHashes` rather than by narrowing
 * the query, which is what keeps the merge from costing it anything — see the note there.
 *
 * The result is also kept in `localStorage`. Nothing else on the dashboard waits on a third party
 * the way cost basis does: collateral, debt and health factor come off the chain and paint
 * immediately, so a page load showed a position with its profit column blank for about a second,
 * every time. A snapshot fills that in from the last load and revalidates behind it.
 */
import type { Address } from 'viem'
import type { DelegationStorage } from './delegationCache'

const AAVE_GRAPHQL_URL = 'https://api.v3.aave.com/graphql'

/**
 * Pages to follow before giving up.
 *
 * `userTransactionHistory` is paginated, so a single request returns only the newest page — and a
 * partial replay produces a plausible-looking average entry price computed from an incomplete
 * ledger, with nothing to indicate anything is missing. Following the cursor fixes that; the cap
 * is here because an unbounded loop against a remote API is a worse failure than a truncated
 * basis, and a history longer than this is pathological.
 */
export const MAX_HISTORY_PAGES = 20

/** History changes slowly, and a replay of it is expensive enough to be worth not repeating. */
const USER_HISTORY_STALE_MS = 5 * 60_000

/**
 * The union of what both readers need: `txHash` for discovery, the rest for cost basis.
 *
 * Liquidations are in here for the basis, which has to realize P&L against them. They carry no
 * `txHash` field on purpose — a liquidation is somebody else's transaction against this wallet, so
 * discovery would only ever screen it out.
 */
const QUERY = `
  query UserHistory($user: EvmAddress!, $chainId: ChainId!, $market: EvmAddress!, $cursor: Cursor) {
    userTransactionHistory(request: { user: $user, chainId: $chainId, market: $market, cursor: $cursor }) {
      pageInfo { next }
      items {
        __typename
        ... on UserSupplyTransaction {
          txHash
          timestamp
          amount { amount { value } usd usdPerToken }
          reserve { underlyingToken { address } }
        }
        ... on UserWithdrawTransaction {
          txHash
          timestamp
          amount { amount { value } usd usdPerToken }
          reserve { underlyingToken { address } }
        }
        ... on UserBorrowTransaction {
          txHash
          timestamp
          amount { amount { value } usd usdPerToken }
          reserve { underlyingToken { address } }
        }
        ... on UserRepayTransaction {
          txHash
          timestamp
          amount { amount { value } usd usdPerToken }
          reserve { underlyingToken { address } }
        }
        ... on UserLiquidationCallTransaction {
          timestamp
          collateral {
            amount { amount { value } usd usdPerToken }
            reserve { underlyingToken { address } }
          }
          debtRepaid {
            amount { amount { value } usd usdPerToken }
            reserve { underlyingToken { address } }
          }
        }
      }
    }
  }
`

interface TxAmount {
  amount: { value: string }
  usd?: number
  usdPerToken?: number
}

interface TxReserve {
  underlyingToken: { address: string }
}

export interface HistoryItem {
  __typename: string
  txHash?: string
  amount?: TxAmount
  reserve?: TxReserve
  collateral?: { amount: TxAmount; reserve: TxReserve }
  debtRepaid?: { amount: TxAmount; reserve: TxReserve }
}

interface HistoryResponse {
  userTransactionHistory?: { items?: HistoryItem[]; pageInfo?: { next?: string | null } }
}

interface UserHistoryRequest {
  user: Address
  chainId: number
  /** Aave's Pool address for this chain — the indexer's notion of a "market". */
  market: Address
  signal?: AbortSignal
}

/**
 * Every page, oldest first as the indexer returns them.
 *
 * THROWS on any failure, leaving the caller to decide. A partial list is indistinguishable from a
 * wallet with less history: the basis would quietly average an incomplete ledger, and `hashSync`
 * would record verdicts for a round that never finished.
 */
export async function fetchUserHistory({
  user,
  chainId,
  market,
  signal,
}: UserHistoryRequest): Promise<HistoryItem[]> {
  const items: HistoryItem[] = []
  let cursor: string | null = null

  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const res = await fetch(AAVE_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { user, chainId, market, cursor } }),
      signal,
    })
    if (!res.ok) throw new Error(`Aave GraphQL ${res.status}`)
    const json = await res.json()
    if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'Aave GraphQL error')

    const history = (json.data as HistoryResponse)?.userTransactionHistory
    items.push(...(history?.items ?? []))
    cursor = history?.pageInfo?.next ?? null
    if (!cursor) break
  }

  return items
}

/** Shared so both readers land on the same cache entry and dedupe into one request. */
export const userHistoryQueryKey = (user: string | undefined, chainId: number, market: string | undefined) =>
  ['aaveUserHistory', user?.toLowerCase(), chainId, market?.toLowerCase()] as const

const HISTORY_SNAPSHOT_KEY = 'defi-route.aavehistory.v1'

/**
 * How old a snapshot may be and still be worth painting.
 *
 * A snapshot is only ever a first frame — react-query treats it as stale on arrival and refetches
 * — so the age limit is not about correctness of the final number, it is about the first one. An
 * entry price from last week against today's price is a wrong profit shown confidently, and a week
 * is long enough that the position it describes may not exist any more.
 */
export const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60_000

interface Snapshot {
  items: HistoryItem[]
  updatedAt: number
}

type SnapshotStore = Record<string, Snapshot>

const snapshotScope = (user: string, chainId: number, market: string) =>
  `${user.toLowerCase()}:${chainId}:${market.toLowerCase()}`

function readStore(storage: DelegationStorage | null): SnapshotStore {
  if (!storage) return {}
  try {
    const raw = storage.getItem(HISTORY_SNAPSHOT_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as SnapshotStore
  } catch {
    // Same posture as the other caches here: this is an optimisation, and losing it costs one
    // load with a blank profit column rather than any data.
    return {}
  }
}

export function readHistorySnapshot(
  storage: DelegationStorage | null,
  user: string | undefined,
  chainId: number,
  market: string | undefined,
  now: number = Date.now(),
): Snapshot | null {
  if (!user || !market) return null
  const entry = readStore(storage)[snapshotScope(user, chainId, market)]
  if (!entry || !Array.isArray(entry.items) || typeof entry.updatedAt !== 'number') return null
  if (now - entry.updatedAt > MAX_SNAPSHOT_AGE_MS) return null
  return entry
}

export function writeHistorySnapshot(
  storage: DelegationStorage | null,
  user: string | undefined,
  chainId: number,
  market: string | undefined,
  items: HistoryItem[],
  now: number = Date.now(),
): void {
  if (!storage || !user || !market) return
  try {
    const store = readStore(storage)
    store[snapshotScope(user, chainId, market)] = { items, updatedAt: now }
    storage.setItem(HISTORY_SNAPSHOT_KEY, JSON.stringify(store))
  } catch {
    // A full or blocked quota costs a blank profit column for one load, nothing more.
  }
}

/**
 * The react-query entry both readers share.
 *
 * Handed out as options rather than as a hook so `useHistorySync` can pull the same entry through
 * `queryClient.fetchQuery` from inside an effect. Same key, so whichever asks second either gets
 * the cached rows or joins the request already in flight — which is the whole point, and is
 * exactly what two hand-rolled fetchers could not do.
 *
 * The snapshot is written here because this is the only place fresh rows appear.
 */
export function userHistoryQuery(
  storage: DelegationStorage | null,
  user: string | undefined,
  chainId: number,
  market: string | undefined,
) {
  return {
    queryKey: userHistoryQueryKey(user, chainId, market),
    queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<HistoryItem[]> => {
      const items = await fetchUserHistory({
        user: user as Address,
        chainId,
        market: market as Address,
        signal,
      })
      writeHistorySnapshot(storage, user, chainId, market, items)
      return items
    },
    staleTime: USER_HISTORY_STALE_MS,
  }
}
