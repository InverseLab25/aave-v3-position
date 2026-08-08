/** Basis-point scale: 10000n == 1.0. Leverage, LTV, LT and health factors all use it. */
export const BPS = 10_000n;

/** Fixed-point scale for swap rates. */
export const WAD = 10n ** 18n;

/**
 * How close to the exact LTV wall sizing is allowed to land. The wall is exact and the borrow
 * reverts *at* it, so sizing must stay strictly below; 0.98 is the haircut.
 */
export const LTV_CEILING_FACTOR_BPS = 9800n;

/** Smallest n such that n * b >= a. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * The hard leverage wall: Aave's `borrow` requires debt <= collateral * LTV, and
 * L = C/(C-D), so L <= 1/(1-LTV). Exceed it and the borrow reverts.
 * LTV 7500 -> 40000 (4.00x).
 *
 * Returns null when `ltvBps >= BPS`: an LTV at or above 100% has no finite leverage wall and is
 * not a valid Aave reserve configuration.
 */
export function maxLeverageForLtvBps(ltvBps: bigint): bigint | null {
  if (ltvBps >= BPS) return null;
  return (BPS * BPS) / (BPS - ltvBps);
}

/**
 * The soft ceiling for a UI slider: at leverage L, HF = L*LT/(L-1), which inverts to
 * L = HF/(HF-LT). LT 8000 with a target HF of 15000 -> 21428 (2.14x).
 *
 * Returns null when `targetHfBps <= ltBps`: HF decays toward LT as leverage rises, so LT is an
 * asymptote no finite leverage reaches, and the constraint is simply not binding.
 */
export function maxLeverageForHealthFactorBps(ltBps: bigint, targetHfBps: bigint): bigint | null {
  if (targetHfBps <= ltBps) return null;
  return (targetHfBps * BPS) / (targetHfBps - ltBps);
}
