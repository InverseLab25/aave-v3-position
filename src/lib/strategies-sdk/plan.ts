import type { Address, Hex } from "viem";
import { FULL_CLOSE, type StrategiesPermit, type StrategiesSig } from "./abi";
import type { MarginIn } from "./sizing";

/**
 * 1 = long X holding X · 2 = long X holding stable ·
 * 3 = short X holding X · 4 = short X holding stable.
 * Longs collateralize X and borrow the stable; shorts collateralize the stable and borrow X.
 * Modes 1/4 bring margin in the collateral asset; modes 2/3 bring it in the debt asset.
 */
export type OpenMode = 1 | 2 | 3 | 4;

export interface PlanOpenInput {
  mode: OpenMode;
  /** The asset being longed/shorted (X). */
  volatile: Address;
  stable: Address;
  /** Collateral flash-borrowed and supplied. */
  flashAmount: bigint;
  /** Debt borrowed on the user's credit delegation. */
  borrowAmount: bigint;
  /** Margin pulled from the wallet — in `marginAsset` of the returned plan. */
  marginAmount: bigint;
  /** Swap-output floor; must also cover `flashAmount` (the contract enforces both). */
  minOut: bigint;
  router: Address;
  swapData: Hex;
  /** Signed over exactly `borrowAmount`; deadline 0n relies on an existing delegation. */
  delegation: StrategiesSig;
}

export interface OpenPlan {
  functionName: "openWithCollateralMargin" | "openWithDebtMargin";
  collateral: Address;
  debtAsset: Address;
  /** What the wallet must have approved (and holds): tells the FE which allowance to check. */
  marginAsset: Address;
  args: readonly [Address, Address, bigint, bigint, bigint, bigint, Address, Hex, StrategiesSig];
}

export interface PlanCloseInput {
  collateral: Address;
  debtAsset: Address;
  /** Defaults to FULL_CLOSE (drain the whole aToken balance). */
  collateralToWithdraw?: bigint;
  /** Defaults to FULL_CLOSE (repay the entire variable debt). */
  debtRepay?: bigint;
  minOut: bigint;
  router: Address;
  permit: StrategiesPermit;
  /** Always required — the contract zeroes the aToken allowance on every close. */
  revokePermit: StrategiesSig;
  swapData: Hex;
}

export interface ClosePlan {
  functionName: "closePositionWithPermit";
  args: readonly [
    Address, Address, bigint, bigint, bigint, Address, StrategiesPermit, StrategiesSig, Hex,
  ];
}

export interface ResolveModeInput {
  mode: OpenMode;
  /** The asset being longed/shorted (X). */
  volatile: Address;
  stable: Address;
}

export interface ResolvedMode {
  collateral: Address;
  debtAsset: Address;
  /** Feeds `sizeOpen`'s `marginIn` directly — imported from `sizing.ts` so the two can never
   *  drift apart. */
  marginIn: MarginIn;
}

/**
 * Derives which asset plays which role for a UX mode. This is the single source of truth
 * `planOpen` and the phase-2 sizing hook must both consume: `sizeOpen` takes `marginIn` as an
 * input, and it must agree with the entry point `planOpen` picks for the same mode.
 */
export function resolveMode(p: ResolveModeInput): ResolvedMode {
  if (p.mode !== 1 && p.mode !== 2 && p.mode !== 3 && p.mode !== 4) {
    throw new Error(`invalid open mode: ${p.mode}`);
  }
  const long = p.mode === 1 || p.mode === 2;
  return {
    collateral: long ? p.volatile : p.stable,
    debtAsset: long ? p.stable : p.volatile,
    marginIn: p.mode === 1 || p.mode === 4 ? "collateral" : "debt",
  };
}

/** Maps a UX mode onto the contract call: which entry point, and which asset plays which role. */
export function planOpen(p: PlanOpenInput): OpenPlan {
  const { collateral, debtAsset, marginIn } = resolveMode(p);
  const collateralMargin = marginIn === "collateral";

  return {
    functionName: collateralMargin ? "openWithCollateralMargin" : "openWithDebtMargin",
    collateral,
    debtAsset,
    marginAsset: collateralMargin ? collateral : debtAsset,
    args: [
      collateral, debtAsset, p.flashAmount, p.borrowAmount, p.marginAmount,
      p.minOut, p.router, p.swapData, p.delegation,
    ] as const,
  };
}

/** Args tuple for the single close entry point. Note the ABI order: withdraw before repay. */
export function planClose(p: PlanCloseInput): ClosePlan {
  return {
    functionName: "closePositionWithPermit",
    args: [
      p.collateral, p.debtAsset,
      p.collateralToWithdraw ?? FULL_CLOSE,
      p.debtRepay ?? FULL_CLOSE,
      p.minOut, p.router, p.permit, p.revokePermit, p.swapData,
    ] as const,
  };
}
