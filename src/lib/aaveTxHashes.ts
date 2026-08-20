/**
 * Every transaction hash this wallet produced against an Aave market that could be one of ours.
 *
 * The starting point for hash-based discovery — see `hashSync`. A leveraged open is, from the
 * pool's point of view, an ordinary supply and borrow, so the indexer has a row for every one of
 * them. It does NOT record what the transaction was addressed to: every type in that schema
 * exposes the same five fields and `to` is not among them, which is why the receipt still has to
 * be read to tell one apart.
 *
 * The rows themselves come from `aaveUserHistory`, shared with the cost-basis replay. Only the
 * hash is taken from them: the amounts on these rows are Aave's, priced at its oracle, and the
 * fill this app cares about lives in the receipt instead.
 */
import type { Hex } from 'viem'
import type { HistoryItem } from './aaveUserHistory'

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
 * against this wallet, so it is never one of ours either.
 *
 * This used to be enforced by narrowing the GraphQL query. It is a filter now because the query is
 * shared with the basis replay, which does need liquidations — but the property that mattered was
 * never about what was asked for, it was that no receipt is ever fetched for a row that is
 * guaranteed to screen out. Dropping the row here keeps that exactly.
 */
const POSITION_TYPES = new Set([
  'UserSupplyTransaction',
  'UserBorrowTransaction',
  'UserWithdrawTransaction',
  'UserRepayTransaction',
])

/**
 * De-duplicated, oldest first as the indexer returns them.
 *
 * De-duplication matters more than it looks: one leveraged open shows up as a supply, a borrow and
 * a second supply, all under one hash. Three rows, one receipt to read.
 */
export function positionHashes(items: readonly HistoryItem[]): Hex[] {
  const seen = new Set<string>()
  const hashes: Hex[] = []

  for (const item of items) {
    if (!POSITION_TYPES.has(item.__typename)) continue
    const hash = item.txHash
    if (typeof hash !== 'string') continue
    const key = hash.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    hashes.push(hash as Hex)
  }

  return hashes
}
