/**
 * healthFactor — Aave health factor = weighted collateral / debt.
 *
 * Callers pass the liquidation-threshold-weighted collateral USD as the
 * numerator and the debt USD as the denominator. Returns '∞' when there is
 * no debt (no liquidation risk).
 */
export function healthFactor(weightedCollateralUsd: number, debtUsd: number): string {
  return debtUsd > 0 ? (weightedCollateralUsd / debtUsd).toFixed(2) : '∞'
}

/** Projected HF below this → the transaction is blocked (1.0 + a safety buffer). */
export const HF_BLOCK = 1.03
/** Projected HF below this (but at/above HF_BLOCK) → a non-blocking warning. */
export const HF_WARN = 1.5

export type HfLevel = 'ok' | 'warn' | 'block'

export interface HfEvaluation {
  level: HfLevel
  /** User-facing message; undefined when level is 'ok'. */
  message?: string
}

/**
 * evaluateHf — classify a projected (post-transaction) health factor into a
 * guard level for the action modals.
 *
 * Accepts the numeric HF or the '∞' string that healthFactor() returns when
 * there is no debt. Anything non-finite (∞, NaN, unavailable) is treated as
 * 'ok' so we fall back to the on-chain simulate-then-write revert instead of
 * blocking on missing data — and so a first supply (no debt) is never blocked.
 */
export function evaluateHf(projectedHf: string | number): HfEvaluation {
  const hf = typeof projectedHf === 'number' ? projectedHf : parseFloat(projectedHf)
  if (!Number.isFinite(hf)) return { level: 'ok' }
  if (hf < HF_BLOCK) {
    return {
      level: 'block',
      message: `This would lower your health factor to ${hf.toFixed(2)} — too close to liquidation. Reduce the amount to keep it above ${HF_BLOCK.toFixed(2)}.`,
    }
  }
  if (hf < HF_WARN) {
    return {
      level: 'warn',
      message: `Heads up: this leaves a low health factor of ${hf.toFixed(2)}. If it falls below 1.0 your position can be liquidated.`,
    }
  }
  return { level: 'ok' }
}
