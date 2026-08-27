/**
 * What became of a submitted transaction — decided once, reported by each flow in its own words.
 *
 * The open and the close both write, wait for a receipt, and then have to work out which of four
 * things happened. They had that logic twice, and it had drifted: the close distinguished a timeout
 * from a receipt that could not be read, while the open caught both in one empty block and said
 * nothing at all. The close's reading is the better one and this is it, extracted.
 *
 * Deliberately NOT a merge of the two flows. What they do with each answer differs for good
 * reasons — the open must not call a timeout a failure, because the user may well hold the position
 * — so this returns a value to switch on and leaves the wording, the step transitions and the
 * logging where they belong.
 */
import { WaitForTransactionReceiptTimeoutError, type Address, type Hex } from 'viem'
import { readOutcome, type ReceiptLog, type TxOutcome } from './txOutcome'

/**
 * How long to wait for a receipt before giving up on it.
 *
 * Five minutes is well past any chain this app runs on, so reaching it means the transaction is
 * genuinely missing rather than merely slow. Previously defined in both hooks with the same value,
 * which is the kind of pair that stays equal right up until someone tunes one of them.
 */
export const RECEIPT_TIMEOUT_MS = 5 * 60 * 1000

/** Just enough of a receipt to settle it. Structural, so a viem receipt fits unchanged. */
interface SettleReceipt {
  status: 'success' | 'reverted'
  logs?: readonly ReceiptLog[]
}

export interface SettleClient {
  waitForTransactionReceipt(args: { hash: Hex; timeout: number }): Promise<SettleReceipt>
}

/**
 * The four things that can happen, plus the one that means nobody is listening.
 *
 * `reverted` and `timeout` are the pair worth keeping apart. An MEV-protected RPC includes only
 * transactions that would succeed, so one that would revert simply never appears — which arrives
 * here as a timeout. Reporting that as a revert would state as fact something that was a guess,
 * and send a user to redo work they may already have done.
 */
type Settlement =
  | { kind: 'settled'; receipt: SettleReceipt; outcome: TxOutcome | null }
  | { kind: 'reverted'; receipt: SettleReceipt }
  | { kind: 'timeout' }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'abandoned' }

interface SettleInput {
  client: SettleClient
  hash: Hex
  wallet: Address
  /** The swap this flow was quoting, so the fill can be matched out of everything the receipt has. */
  pair: { srcToken: Address; dstToken: Address }
  expectedOut: bigint
  minOut: bigint
  /**
   * Whether this send is still the one on screen. Checked AFTER the wait, since a user can abandon
   * a flow during it — the open guards on its own send ref for exactly this. Absent means always.
   */
  isCurrent?: () => boolean
}

export async function settleTransaction({
  client,
  hash,
  wallet,
  pair,
  expectedOut,
  minOut,
  isCurrent,
}: SettleInput): Promise<Settlement> {
  let receipt: SettleReceipt
  try {
    receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
  } catch (error) {
    // Timed out, not failed: it may still land later, or may never have been included at all.
    if (error instanceof WaitForTransactionReceiptTimeoutError) return { kind: 'timeout' }
    // The receipt READ failed — an RPC error, a dropped connection. That says nothing about the
    // transaction itself, which is why it cannot be reported as one.
    const detail =
      (error as { shortMessage?: string }).shortMessage ?? (error as Error).message ?? String(error)
    return { kind: 'unreadable', detail }
  }

  // Checked here rather than before the wait: the abandonment happens DURING it.
  if (isCurrent && !isCurrent()) return { kind: 'abandoned' }

  if (receipt.status !== 'success') return { kind: 'reverted', receipt }

  return {
    kind: 'settled',
    receipt,
    // Null when the receipt says nothing about this wallet at all, which `readOutcome` reports by
    // returning null rather than an empty report — an empty one reads as a failed decode.
    outcome: readOutcome({
      logs: receipt.logs ?? [],
      wallet,
      pair,
      expectedOut,
      minOut,
    }),
  }
}
