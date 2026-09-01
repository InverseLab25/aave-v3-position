import { T } from '../styles/theme'

/**
 * Reads the same rate from the other end of the pair — which side is quoted as 1, nothing more.
 *
 * Shared by the open and close modals so the control looks and reads identically in both. A rate
 * has two readings and only one is legible for a given pair; the default picks one and this is
 * for the reader who wants the other.
 */
export function FlipRateButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Flip rate direction"
      style={{
        background: 'none', border: 'none', padding: 0, marginLeft: T.space[2],
        cursor: 'pointer', color: T.textMuted, fontSize: T.fontSize.sm, lineHeight: 1,
      }}
    >
      ⇄
    </button>
  )
}
