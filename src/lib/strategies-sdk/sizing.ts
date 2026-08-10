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

/** Which role the wallet's margin plays — picks the contract entry point and the math.
 *  Shared with `plan.ts`'s `resolveMode` so the two can never drift apart. */
export type MarginIn = "collateral" | "debt";

/**
 * Adds the ratchet path, where no margin is posted at all. `sizeOpen` never sees this: leverage
 * is a multiple of a margin base, and with no base the derived path is not merely unused but
 * undefined. Ratchet positions are sized by hand.
 */
export type MarginLocation = MarginIn | "none";

export type SizeOpenError =
  | "ZERO_MARGIN"
  | "ZERO_RATE"
  | "ZERO_PRICE"
  | "INVALID_LTV"
  | "LEVERAGE_TOO_LOW"
  | "LEVERAGE_ABOVE_LTV";

export interface SizeOpenInput {
  /** Which role the wallet's margin plays — picks the contract entry point and the math. */
  marginIn: MarginIn;
  /** Margin pulled from the wallet, in the asset named by `marginIn`. */
  marginAmount: bigint;
  /** Target leverage in bps: 30000n == 3.00x. */
  leverageBps: bigint;
  /** Collateral wei obtained per 1 debt wei, scaled by WAD. */
  rateWad: bigint;
  /** Aave oracle prices — any shared fixed-point scale, as long as both sides use it. */
  collateralPriceUsd: bigint;
  debtPriceUsd: bigint;
  collateralDecimals: number;
  debtDecimals: number;
  /** Aave reserve LTV, e.g. 7500n. Gates the borrow. */
  ltvBps: bigint;
  /** Aave liquidation threshold, e.g. 8000n. Drives the health factor. */
  liquidationThresholdBps: bigint;
  /** Rate safety margin, e.g. 50n = 0.5%. Oversizes the borrow so the swap clears the flash. */
  rateBufferBps: bigint;
  /** User slippage tolerance, e.g. 50n = 0.5%. Drives minOut. */
  slippageBps: bigint;
}

export interface OpenSize {
  /** `flashAmount` for the collateral-margin flow, `supplyAmount` for the debt-margin flow. */
  flashAmount: bigint;
  borrowAmount: bigint;
  minOut: bigint;
  expectedSwapOut: bigint;
  expectedCollateral: bigint;
  expectedDebt: bigint;
  /** Realized leverage in bps. Always >= the requested figure — surplus folds into the position. */
  expectedLeverageBps: bigint;
  expectedHealthFactorBps: bigint;
}

export type SizeOpenResult = { ok: true; size: OpenSize } | { ok: false; error: SizeOpenError };

/**
 * Solves margin + target leverage into the contract's amounts.
 *
 * Every division rounds so the error falls on the safe side: the borrow rounds UP, because
 * under-borrowing means the swap cannot repay the flash and the whole transaction reverts,
 * while over-borrowing merely folds surplus collateral into the position.
 */
export function sizeOpen(p: SizeOpenInput): SizeOpenResult {
  if (p.marginAmount <= 0n) return { ok: false, error: "ZERO_MARGIN" };
  if (p.rateWad <= 0n) return { ok: false, error: "ZERO_RATE" };
  if (p.collateralPriceUsd <= 0n || p.debtPriceUsd <= 0n) return { ok: false, error: "ZERO_PRICE" };
  if (p.leverageBps <= BPS) return { ok: false, error: "LEVERAGE_TOO_LOW" };

  // `maxLeverageForLtvBps` returns null for an LTV at or above 100%, which has no finite wall
  // and is not a valid Aave reserve config. Reject rather than let the arithmetic throw.
  const wall = maxLeverageForLtvBps(p.ltvBps);
  if (wall === null) return { ok: false, error: "INVALID_LTV" };

  const ceiling = (wall * LTV_CEILING_FACTOR_BPS) / BPS;
  if (p.leverageBps >= ceiling) return { ok: false, error: "LEVERAGE_ABOVE_LTV" };

  // The buffer is applied to the rate rather than to the borrow, so a thinner quoted rate and a
  // wider safety margin compose into one effective rate.
  const effRate = (p.rateWad * (BPS - p.rateBufferBps)) / BPS;
  if (effRate <= 0n) return { ok: false, error: "ZERO_RATE" };

  if (p.marginIn === "debt") {
    // Margin is spent inside the swap, so the exposure is the margin's USD value levered up,
    // expressed in collateral units.
    const supplyAmount =
      (p.marginAmount * p.leverageBps * p.debtPriceUsd * 10n ** BigInt(p.collateralDecimals)) /
      (BPS * p.collateralPriceUsd * 10n ** BigInt(p.debtDecimals));
    if (supplyAmount <= 0n) return { ok: false, error: "LEVERAGE_TOO_LOW" };

    const swapIn = ceilDiv(supplyAmount * WAD, effRate);
    // When the quoted rate beats the oracle-implied one, the margin can cover the whole swap
    // input on its own and there is nothing left to borrow. The contract reverts ZeroAmount on
    // a zero borrow, so reject rather than clamp.
    if (swapIn <= p.marginAmount) return { ok: false, error: "LEVERAGE_TOO_LOW" };
    const borrowAmount = swapIn - p.marginAmount;

    const expectedSwapOut = (swapIn * p.rateWad) / WAD;

    return {
      ok: true,
      size: finish(p, {
        flashAmount: supplyAmount,
        borrowAmount,
        expectedSwapOut,
        // The flash is repaid out of the output, so the position is the whole output — the
        // margin is already inside it and must not be added again.
        expectedCollateral: expectedSwapOut,
        minOut: max(supplyAmount, (expectedSwapOut * (BPS - p.slippageBps)) / BPS),
      }),
    };
  }

  // Collateral-margin flow: flash the exposure the margin does not provide, borrow to buy it back.
  const flashAmount = (p.marginAmount * (p.leverageBps - BPS)) / BPS;
  if (flashAmount <= 0n) return { ok: false, error: "LEVERAGE_TOO_LOW" };

  const borrowAmount = ceilDiv(flashAmount * WAD, effRate);
  if (borrowAmount <= 0n) return { ok: false, error: "LEVERAGE_TOO_LOW" };

  const expectedSwapOut = (borrowAmount * p.rateWad) / WAD;
  const expectedCollateral = p.marginAmount + expectedSwapOut;

  return {
    ok: true,
    size: finish(p, {
      flashAmount,
      borrowAmount,
      expectedSwapOut,
      expectedCollateral,
      minOut: max(flashAmount, (expectedSwapOut * (BPS - p.slippageBps)) / BPS),
    }),
  };
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Attaches the derived position metrics shared by both flows. */
function finish(
  p: SizeOpenInput,
  s: Omit<OpenSize, "expectedDebt" | "expectedLeverageBps" | "expectedHealthFactorBps"> & {
    borrowAmount: bigint;
  },
): OpenSize {
  const collUsd = (s.expectedCollateral * p.collateralPriceUsd) / 10n ** BigInt(p.collateralDecimals);
  const debtUsd = (s.borrowAmount * p.debtPriceUsd) / 10n ** BigInt(p.debtDecimals);
  const equityUsd = collUsd - debtUsd;

  return {
    ...s,
    expectedDebt: s.borrowAmount,
    expectedLeverageBps: equityUsd > 0n ? (collUsd * BPS) / equityUsd : 0n,
    expectedHealthFactorBps: debtUsd > 0n ? (collUsd * p.liquidationThresholdBps) / debtUsd : 0n,
  };
}
