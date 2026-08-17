/**
 * Every transaction hash this wallet produced against an Aave market, from Aave's own indexer.
 *
 * The starting point for hash-based discovery — see `hashSync`. A leveraged open is, from the
 * pool's point of view, an ordinary supply and borrow, so the indexer has a row for every one of
 * them. It does NOT record what the transaction was addressed to: every type in that schema
 * exposes the same five fields and `to` is not among them, which is why the receipt still has to
 * be read to tell one apart.
 *
 * Only `txHash` is selected. The amounts on these rows are Aave's, priced at its oracle, and the
 * fill this app cares about lives in the receipt instead.
 */
import type { Address, Hex } from 'viem'

const AAVE_GRAPHQL_URL = 'https://api.v3.aave.com/graphql'

/**
 * Pages to follow before giving up.
 *
 * Matches `useAaveHistoricalInterest`, and for the same reason: an unbounded loop against a remote
 * API is a worse failure than a truncated list. A truncation here costs an unrecovered position,
 * never a wrong number — a hash that is never seen is simply never filed.
 */
export const MAX_HISTORY_PAGES = 20

/**
 * The four movements a leveraged position can show up as, and no others.
 *
 * An open borrows and supplies; a close withdraws and repays. It is tempting to keep only the
 * first pair, since an open is the interesting case — but a close appears ONLY as a withdraw and
 * a repay, so dropping them loses every close, and with it the reset that stops a position
 * exited months ago from pricing one opened yesterday.
 *
 * The two left out cannot cost anything. A standalone collateral toggle emits no swap and no
 * position event, so its receipt could only ever be rejected; when it accompanies a real open it
 * shares that open's hash and arrives anyway. A liquidation is somebody else's transaction
 * against this wallet, so it is never one of ours either. Both were pure fetches with a
 * guaranteed negative verdict.
 */
const QUERY = `
  query UserTxHashes($user: EvmAddress!, $chainId: ChainId!, $market: EvmAddress!, $cursor: Cursor) {
    userTransactionHistory(request: { user: $user, chainId: $chainId, market: $market, cursor: $cursor }) {
      pageInfo { next }
      items {
        __typename
        ... on UserSupplyTransaction { txHash }
        ... on UserBorrowTransaction { txHash }
        ... on UserWithdrawTransaction { txHash }
        ... on UserRepayTransaction { txHash }
      }
    }
  }
`

interface HashItem {
  txHash?: string
}

interface HashResponse {
  userTransactionHistory?: {
    items?: HashItem[]
    pageInfo?: { next?: string | null }
  }
}

export interface TxHashRequest {
  user: Address
  chainId: number
  /** Aave's Pool address for this chain — the indexer's notion of a "market". */
  market: Address
  signal?: AbortSignal
}

/**
 * De-duplicated, oldest first as the indexer returns them.
 *
 * De-duplication matters more than it looks: one leveraged open shows up as a supply, a borrow and
 * a second supply, all under one hash. Three rows, one receipt to read.
 *
 * THROWS on any failure, leaving the caller to decide. A partial list is indistinguishable from a
 * wallet with less history, and `hashSync` would record verdicts for a round that never finished.
 */
export async function fetchUserTxHashes({
  user,
  chainId,
  market,
  signal,
}: TxHashRequest): Promise<Hex[]> {
  const seen = new Set<string>()
  const hashes: Hex[] = []
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

    const history = (json.data as HashResponse)?.userTransactionHistory
    for (const item of history?.items ?? []) {
      const hash = item.txHash
      if (typeof hash !== 'string') continue
      const key = hash.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      hashes.push(hash as Hex)
    }

    cursor = history?.pageInfo?.next ?? null
    if (!cursor) break
  }

  return hashes
}
