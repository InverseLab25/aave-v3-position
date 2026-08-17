/**
 * The bottom of a transaction screen: where you are, what went wrong, what settled, where to look.
 *
 * Both the open and the close ended with the same four things in the same order, assembled
 * separately in each file. Keeping the order in one place is most of the value — it is the thing
 * that makes the two screens read as the same application, and it is exactly what drifts when two
 * files own it.
 *
 * This is NOT the whole of either modal, and the two are not merged. The open is a confirmation:
 * its form is the panel behind it. The close is a form AND a confirmation in one screen — it picks
 * the collateral, takes the amount, and sends. What they genuinely share is the tail.
 */
import { ExplorerLink } from './ExplorerLink'
import { TxOutcomePanel, type TokenMeta } from './TxOutcome'
import { TxSteps, type TxStep } from './TxSteps'
import type { TxOutcome } from '../lib/txOutcome'
import { T } from '../styles/theme'

export interface TxReportProps {
  /** The waits this flow puts a user through. Empty for a flow with nothing to enumerate. */
  steps: readonly TxStep[]
  /** The attempt failed. Shown as a failure. */
  error?: string | null
  /** What to do about `error`, when the decoded revert suggests something. */
  errorHint?: string | null
  /**
   * Something true and worth saying that is NOT a failure — a receipt that never arrived, a step
   * in progress. Separate from `error` because a submitted transaction whose fate is unknown must
   * not be reported as one that failed.
   */
  note?: string | null
  /** What the transaction settled at, once its receipt is in. Null until then. */
  outcome: TxOutcome | null
  outcomeTokens: Record<string, TokenMeta>
  txHash: `0x${string}` | undefined
  chainId: number
}

export function TxReport({
  steps,
  error,
  errorHint,
  note,
  outcome,
  outcomeTokens,
  txHash,
  chainId,
}: TxReportProps) {
  return (
    <>
      <TxSteps steps={steps} />

      {error && (
        <div style={{ marginTop: T.space[3], fontSize: T.fontSize.sm, color: T.danger }}>
          {error}
          {errorHint && <span style={{ color: T.textMuted }}> {errorHint}</span>}
        </div>
      )}

      {note && !error && (
        <div style={{ marginTop: T.space[3], fontSize: T.fontSize.sm, color: T.textMuted }}>
          {note}
        </div>
      )}

      {/* Fills in when the receipt lands, which is a block or two after the send returns. Until
          then the hash below is the whole report — the transaction is out either way. */}
      <TxOutcomePanel outcome={outcome} tokens={outcomeTokens} />

      {txHash && (
        <div style={{ marginTop: T.space[4] }}>
          <ExplorerLink hash={txHash} chainId={chainId} />
        </div>
      )}
    </>
  )
}
