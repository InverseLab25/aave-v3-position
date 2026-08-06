// src/lib/leverage-sdk/params.ts
import type { Address, Hex } from "viem";
import { FULL_CLOSE } from "./abi";

export interface ContractPermit { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex }
export interface ContractRevoke { deadline: bigint; v: number; r: Hex; s: Hex }

const ZERO_B32 = `0x${"00".repeat(32)}` as Hex;
/** Existing-allowance path: the contract skips a permit whose value is 0. Always pair with
 *  ZERO_REVOKE — a non-zero permit must ship with a non-zero revoke deadline. */
export const ZERO_PERMIT: ContractPermit = { value: 0n, deadline: 0n, v: 0, r: ZERO_B32, s: ZERO_B32 };
/** No-permit path: the contract skips a revoke whose deadline is 0. Always pair with
 *  ZERO_PERMIT — a non-zero revoke deadline must ship with a non-zero permit. */
export const ZERO_REVOKE: ContractRevoke = { deadline: 0n, v: 0, r: ZERO_B32, s: ZERO_B32 };

export interface OpenParams {
  collateral: Address; debtAsset: Address; marginAmount: bigint; flashAmount: bigint;
  /** Must be non-zero; pulled via a prior approval — the open leg has no permit. */
  minCollateralOut: bigint; router: Address; swapData: Hex;
  delegation: ContractPermit;
}

export interface CloseParams {
  collateral: Address; debtAsset: Address;
  /** Defaults to FULL_CLOSE (repay the entire variable debt). */
  repayAmount?: bigint;
  /** Defaults to FULL_CLOSE (drain the whole aToken balance). */
  collateralToWithdraw?: bigint;
  minOut: bigint; router: Address; swapData: Hex;
  permit: ContractPermit; revokePermit: ContractRevoke;
}

/** Args tuple for `writeContract({ functionName: "openPosition", args })`. */
export function buildOpenArgs(p: OpenParams) {
  return [
    p.collateral, p.debtAsset, p.marginAmount, p.flashAmount, p.minCollateralOut,
    p.router, p.swapData, p.delegation,
  ] as const;
}

/** Args tuple for `writeContract({ functionName: "closePosition", args })`. */
export function buildCloseArgs(p: CloseParams) {
  return [
    p.collateral, p.debtAsset, p.repayAmount ?? FULL_CLOSE, p.collateralToWithdraw ?? FULL_CLOSE,
    p.minOut, p.router, p.swapData, p.permit, p.revokePermit,
  ] as const;
}

export interface SizingInput {
  totalCollateral: bigint; totalDebt: bigint; repayAmount: bigint;
  /** Oracle prices in any shared fixed-point scale (both sides must use the same). */
  collateralPriceUsd: bigint; debtPriceUsd: bigint;
  collateralDecimals: number; debtDecimals: number;
  /** Aave liquidation threshold, e.g. 8000 = 80%. */
  liquidationThresholdBps: bigint;
  /** Post-close health-factor floor, e.g. 15000 = 1.5. Must be > 10000. */
  targetHealthFactorBps: bigint;
}

/**
 * Max `collateralToWithdraw` for a partial close keeping
 * HF = collateralUsd * LT / debtUsd >= target after repaying `repayAmount`.
 * Mirrors the on-chain reality: Aave enforces HF >= 1 inside withdraw; the target
 * adds headroom on top. Returns FULL_CLOSE when the remaining debt is zero.
 */
export function maxSafeCollateralWithdraw(p: SizingInput): bigint {
  const remainingDebt = p.repayAmount >= p.totalDebt ? 0n : p.totalDebt - p.repayAmount;
  if (remainingDebt === 0n) return FULL_CLOSE;

  const debtUsd = remainingDebt * p.debtPriceUsd; // scale: 10^debtDecimals * priceScale
  // requiredCollateralUsd = debtUsd * targetHF / LT, then back to collateral token units.
  // Ceil-divide both steps so rounding always errs toward MORE collateral kept.
  const requiredUsd = ceilDiv(debtUsd * p.targetHealthFactorBps, p.liquidationThresholdBps);
  // tokenUnits(coll) = requiredUsd * 10^collDecimals / (collPrice * 10^debtDecimals)
  const requiredCollateral = ceilDiv(
    requiredUsd * 10n ** BigInt(p.collateralDecimals),
    p.collateralPriceUsd * 10n ** BigInt(p.debtDecimals),
  );

  return requiredCollateral >= p.totalCollateral ? 0n : p.totalCollateral - requiredCollateral;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
