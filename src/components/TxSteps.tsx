/**
 * How far through a multi-step transaction the user is: `✓ approved · ✓ signed · send`.
 *
 * Three flows wanted this and three flows had their own. The leverage open hard-coded the ticks
 * because its first two steps are always behind the user by the time its confirmation exists; the
 * swap executor derived two booleans and styled them inline; the close showed a scrolling list of
 * log lines instead, which is a different thing — a diagnostic record rather than a position in a
 * sequence, and it read as debug output in the middle of a transaction screen.
 *
 * Steps carry three states rather than two. A step not yet reached and a step happening right now
 * look the same if you only track done-ness, which makes a flow that has stalled indistinguishable
 * from one that is working.
 */
import { T } from '../styles/theme'

export interface TxStep {
  label: string
  /** Behind the user. Ticked. */
  done: boolean
  /** Happening now. Emphasised, but not ticked — it has not finished. */
  active?: boolean
}

export function TxSteps({ steps }: { steps: readonly TxStep[] }) {
  if (steps.length === 0) return null

  // One sentence to a screen reader. Read span by span it arrives as disconnected fragments —
  // "✓", "signed", "·" — which is noise rather than progress.
  const spoken = steps
    .map((s) => `${s.label} ${s.done ? 'done' : s.active ? 'in progress' : 'pending'}`)
    .join(', ')

  return (
    <div
      role="status"
      aria-label={`Progress: ${spoken}`}
      style={{ marginTop: T.space[4], fontSize: T.fontSize.sm, color: T.textMuted }}
    >
      {steps.map((step, i) => (
        <span key={step.label}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          <span
            style={{
              color: step.done || step.active ? T.text : T.textMuted,
              fontWeight: step.active ? 700 : 400,
            }}
          >
            {step.done ? `✓ ${step.label}` : step.label}
          </span>
        </span>
      ))}
    </div>
  )
}
