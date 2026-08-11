/**
 * The user's slippage tolerance, as the contract wants it.
 *
 * The panel works in percent because that is what the field shows; everything downstream —
 * `solveBorrow`, the `minOut` floor, the contract itself — works in basis points. This is the one
 * place the two meet, so it is also the one place the bad inputs get caught.
 */

/** The same three the close flow offers, so one habit works in both places. */
export const SLIPPAGE_PRESETS = [0.1, 0.5, 1] as const

/** What the leverage panel starts on. */
export const DEFAULT_SLIPPAGE_PERCENT = 0.5

/**
 * Beyond this a tolerance stops being a tolerance. `minOut` is the route's output less this, so
 * at 100% the swap guarantees nothing at all and the only remaining floor is the flash
 * repayment — which is a much weaker promise than the user thinks they are setting.
 */
export const MAX_SLIPPAGE_PERCENT = 50

export function toSlippageBps(percent: number): bigint {
  // `parseFloat('')` is NaN and `BigInt(NaN)` throws, which would unmount the panel on a cleared
  // field. Every non-number becomes zero, which is the safe end of the range.
  if (!Number.isFinite(percent)) return 0n
  const clamped = Math.min(Math.max(percent, 0), MAX_SLIPPAGE_PERCENT)
  return BigInt(Math.round(clamped * 100))
}
