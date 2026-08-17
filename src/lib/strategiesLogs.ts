/**
 * The two events an AaveV3Strategies position produces, and the shape a history row is built from.
 *
 * There used to be a log scanner here as well, walking the chain from the deployment block in
 * windows it halved until a provider accepted them. Discovery goes through Aave's indexer now —
 * see `hashSync` — which turns forty-odd range-capped `eth_getLogs` into one receipt per candidate
 * transaction. What remains is what both the live subscription and `receiptScreen` still need: the
 * event definitions to filter on, and the record they decode into.
 */
import type { Address, Hex } from 'viem'
import { aaveV3StrategiesAbi } from './strategies-sdk/abi'

type StrategiesEvent = Extract<(typeof aaveV3StrategiesAbi)[number], { type: 'event' }>

const eventNamed = (name: string): StrategiesEvent =>
  aaveV3StrategiesAbi.find(
    (item): item is StrategiesEvent => item.type === 'event' && item.name === name,
  )!

export const POSITION_OPENED = eventNamed('PositionOpened')
export const POSITION_CLOSED = eventNamed('PositionClosed')

/** The two events a scan asks for, out of the full contract ABI. */
export const POSITION_EVENTS = [POSITION_OPENED, POSITION_CLOSED] as const

/** One position event, reduced to what building a history row needs. */
export interface PositionEvent {
  hash: Hex
  blockNumber: bigint
  logIndex: number
  kind: 'open' | 'close'
  collateral: Address
  debtAsset: Address
}
