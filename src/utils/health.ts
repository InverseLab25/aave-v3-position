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
