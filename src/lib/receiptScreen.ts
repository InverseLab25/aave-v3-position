/**
 * Deciding whether a transaction was one of ours, from its receipt alone.
 *
 * Aave's indexer hands back a `txHash` for every supply, borrow, withdraw and repay this wallet
 * made — but nothing about the transaction itself. From its point of view a leveraged open IS an
 * ordinary supply and borrow by the user; it never sees that a contract arranged them. Every
 * transaction type in that schema exposes the same five fields, and `to` is not among them.
 *
 * So the separation happens here, against the receipt. That costs nothing extra: the receipt is
 * already required to read the `Swapped` event the fill price comes from, and one
 * `eth_getTransactionReceipt` answers both questions at once. It is also a point lookup, so unlike
 * a log scan no provider caps it by block range.
 */
import { getAddress, type Address, type Hex } from 'viem'
import type { PositionEvent } from './strategiesLogs'
import type { ReceiptLog } from './txOutcome'

/** `keccak256("PositionOpened(address,address,address,uint256,uint256,uint256)")`. */
export const POSITION_OPENED_TOPIC =
  '0x189eb591404f8ec246d924067851a6025e0254e8961c7fade58bcf95da1c120b' as const

/** `keccak256("PositionClosed(address,address,address,uint256,uint256,uint256)")`. */
export const POSITION_CLOSED_TOPIC =
  '0x3c8c232e82302c21fafdb08b09fa67de2937f94bf1558fad7b17019c0ea8170e' as const

/** What the screen needs from a receipt. Structural, so a viem receipt fits unchanged. */
export interface ScreenedReceipt {
  hash: Hex
  /** Null for a contract creation, which can never be one of ours. */
  to: Address | null
  status: 'success' | 'reverted'
  blockNumber: bigint
  logs: readonly ReceiptLog[]
}

/** An indexed address argument, unpadded back to an address. */
const addressFromTopic = (topic: Hex): Address | null => {
  if (topic.length !== 66) return null
  try {
    return getAddress(`0x${topic.slice(26)}`)
  } catch {
    return null
  }
}

/**
 * The position event this transaction produced, or null if it produced none.
 *
 * The log is the authority, not `to`. A wallet that batches — a Safe, or an account delegated
 * under 7702 — puts ITSELF in `to` and calls the strategies contract internally, so a `to` test
 * alone would file those as ordinary Aave activity. What cannot be faked from outside is which
 * contract EMITTED the event, so that is what is checked: the log's own address.
 *
 * Which also means `to` is not consulted at all. It was the obvious filter and it is the weaker
 * one; keeping it as well would only widen the net to transactions that emitted nothing worth
 * recording, and those have no amounts to read.
 */
export function positionEventFromReceipt(
  receipt: ScreenedReceipt,
  strategies: Address,
): PositionEvent | null {
  // A reverted transaction moved nothing, whatever it was addressed to.
  if (receipt.status !== 'success') return null

  const emitter = strategies.toLowerCase()

  for (const [index, log] of receipt.logs.entries()) {
    if (log.address.toLowerCase() !== emitter) continue
    const topic = log.topics[0]
    const kind =
      topic === POSITION_OPENED_TOPIC ? 'open' : topic === POSITION_CLOSED_TOPIC ? 'close' : null
    if (kind === null) continue

    // user, collateral, debtAsset — all three indexed, so all three are topics.
    const collateral = log.topics[2] ? addressFromTopic(log.topics[2]) : null
    const debtAsset = log.topics[3] ? addressFromTopic(log.topics[3]) : null
    if (!collateral || !debtAsset) continue

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      logIndex: index,
      kind,
      collateral,
      debtAsset,
    }
  }

  return null
}
