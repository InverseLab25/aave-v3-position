/**
 * The shape a history row is built from.
 *
 * There used to be a log scanner here, walking the chain from the deployment block in windows it
 * halved until a provider accepted them, plus the event definitions it filtered on. Discovery goes
 * through Aave's indexer now — see `hashSync` — which turns forty-odd range-capped `eth_getLogs`
 * into one receipt per candidate transaction, and the live subscription is gone too. Neither had a
 * caller left, so what remains is the record they decoded into.
 */
import type { Address, Hex } from 'viem'

/** One position event, reduced to what building a history row needs. */
export interface PositionEvent {
  hash: Hex
  blockNumber: bigint
  logIndex: number
  kind: 'open' | 'close'
  collateral: Address
  debtAsset: Address
}
