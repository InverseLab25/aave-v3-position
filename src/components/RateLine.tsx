/**
 * One fill, stated as a price, in whichever direction the reader wants it.
 *
 * Extracted from the history list so the settled panel in the open and close modals states its
 * rate the same way. A rate has two readings and only one of them is legible for a given pair —
 * "1 WETH = 1,876.21 USDT" against "1 USDT = 0.000533 WETH" — and which one that is depends on the
 * pair rather than on the direction the swap happened to run.
 */
import { useState } from 'react'
import { quoteRate } from '../lib/deleverage'
import { preferInverted } from '../lib/swapRoute'
import { T } from '../styles/theme'

interface RateLineProps {
  srcSymbol: string
  srcDecimals: number
  dstSymbol: string
  dstDecimals: number
  /** What went in, in `srcSymbol` units. */
  spentAmount: bigint
  /** What came back, in `dstSymbol` units. */
  returnAmount: bigint
}

/** Rates carry their own precision from `quoteRate`; this only groups the thousands. */
function format(value: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return n >= 1
    ? n.toLocaleString(undefined, { maximumFractionDigits: 4 })
    : n.toLocaleString(undefined, { maximumSignificantDigits: 6 })
}

export function RateLine({
  srcSymbol, srcDecimals, dstSymbol, dstDecimals, spentAmount, returnAmount,
}: RateLineProps) {
  // Quote the volatile leg per stable, or the base asset per whatever bought it — that is the
  // reading people hold prices in. Falls back to the swap's own direction when neither applies.
  const [inverted, setInverted] = useState(preferInverted(srcSymbol, dstSymbol))

  // A leg of zero has no ratio in EITHER direction, so the check cannot be left to `quoteRate` —
  // that only guards its own denominator, and would report the other direction as a flat zero.
  if (spentAmount <= 0n || returnAmount <= 0n) return null

  // Both directions come from the AMOUNTS. Dividing into an already-rounded rate is what turned a
  // 0.000532989 fill into 1,879.6992 instead of 1,876.2123.
  const shown = inverted
    ? quoteRate(spentAmount, returnAmount, dstDecimals, srcDecimals)
    : quoteRate(returnAmount, spentAmount, srcDecimals, dstDecimals)

  if (shown === null) return null

  const [unit, quote] = inverted ? [dstSymbol, srcSymbol] : [srcSymbol, dstSymbol]

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      {`1 ${unit} = ${format(shown)} ${quote}`}
      <button
        type="button"
        onClick={() => setInverted(!inverted)}
        title="Swap rate direction"
        style={{
          background: 'none', border: 'none', padding: 0,
          cursor: 'pointer', opacity: 0.6, display: 'flex', alignItems: 'center',
          color: T.text,
        }}
      >
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M7 16V4M7 4L3 8M7 4L11 8M17 8V20M17 20L21 16M17 20L13 16" />
        </svg>
      </button>
    </span>
  )
}
