import { parseAbi, type Address, type Hex } from "viem";
import type { StrategiesPermit, StrategiesSig } from "./abi";
import { BPS, LTV_CEILING_FACTOR_BPS, maxLeverageForLtvBps, WAD } from "./sizing";

export type SizeFlipError =
  | "ZERO_COLLATERAL"
  | "ZERO_RATE"
  | "ZERO_PRICE"
  | "INVALID_LTV"
  | "LEVERAGE_TOO_LOW"
  | "LEVERAGE_ABOVE_LTV"
  | "RATE_ABOVE_LEVERAGE"
  | "UNDERWATER";

/**
 * `from` is the asset held as collateral today and owed as debt once the flip lands — the one
 * flashed and sold. `to` is its mirror: owed today, held as collateral after. A long and a short
 * differ only in which asset fills which role, so both directions size through this one path.
 */
export interface SizeFlipInput {
  /** Whole aToken balance of the `from` asset. A flip unwinds the position entirely. */
  collateralAmount: bigint;
  /** Whole variable-debt balance of the `to` asset, accrued interest included. */
  debtAmount: bigint;
  /** Target leverage on the flipped position in bps: 20000n == 2.00x. */
  leverageBps: bigint;
  /** `to` wei obtained per 1 `from` wei, scaled by WAD. */
  rateWad: bigint;
  /** Aave oracle prices — any shared fixed-point scale, as long as both sides use it. */
  fromPriceUsd: bigint;
  toPriceUsd: bigint;
  fromDecimals: number;
  toDecimals: number;
  /** LTV and LT of the `to` reserve. The flip is walled by what it moves INTO, not what it leaves. */
  ltvBps: bigint;
  liquidationThresholdBps: bigint;
  /** Rate safety margin, e.g. 50n = 0.5%. Undersizes the flash so the target is a ceiling. */
  rateBufferBps: bigint;
  /** User slippage tolerance, e.g. 50n = 0.5%. Drives minOut. */
  slippageBps: bigint;
}

export interface FlipSize {
  /** Flash this much of the `from` asset, and sell all of it. */
  flashAmount: bigint;
  /** New debt in the `from` asset. The flash is repaid from this plus the withdrawn collateral. */
  borrowAmount: bigint;
  minOut: bigint;
  expectedSwapOut: bigint;
  /** New collateral in the `to` asset: whatever the sale returns beyond clearing the old debt. */
  expectedCollateral: bigint;
  expectedDebt: bigint;
  /** Realized leverage in bps. Always <= the requested figure — see `rateBufferBps`. */
  expectedLeverageBps: bigint;
  expectedHealthFactorBps: bigint;
}

export type SizeFlipResult = { ok: true; size: FlipSize } | { ok: false; error: SizeFlipError };

/**
 * Solves the flash size that turns a leveraged position into its mirror.
 *
 * The whole flash is sold, the proceeds clear the old debt and fund the new collateral, and the
 * flash is repaid in kind out of the withdrawn collateral plus the new borrow. Writing the
 * leverage identity over USD values and substituting those two facts leaves
 *
 *   Vx = (g*Vc - Vd) / (g - e),   g = L/(L-1),   e = swap value out / value in
 *
 * with the borrow being whatever the existing collateral does not already cover, `Vx - Vc`.
 *
 * Every division floors, and unlike `sizeOpen` that is the safe direction here: leverage climbs
 * with the flash size, so flooring undershoots the target. Nothing about the flash repayment
 * depends on the swap, so an undersized flash costs a little leverage rather than reverting.
 */
export function sizeFlip(p: SizeFlipInput): SizeFlipResult {
  if (p.collateralAmount <= 0n) return { ok: false, error: "ZERO_COLLATERAL" };
  if (p.leverageBps <= BPS) return { ok: false, error: "LEVERAGE_TOO_LOW" };
  if (p.fromPriceUsd <= 0n || p.toPriceUsd <= 0n) return { ok: false, error: "ZERO_PRICE" };
  if (p.rateWad <= 0n) return { ok: false, error: "ZERO_RATE" };

  // An LTV at or above 100% has no finite wall and is not a valid Aave reserve config.
  const wall = maxLeverageForLtvBps(p.ltvBps);
  if (wall === null) return { ok: false, error: "INVALID_LTV" };

  const capBps = (wall * LTV_CEILING_FACTOR_BPS) / BPS;
  if (p.leverageBps >= capBps) return { ok: false, error: "LEVERAGE_ABOVE_LTV" };

  const effRate = (p.rateWad * (BPS - p.rateBufferBps)) / BPS;
  if (effRate <= 0n) return { ok: false, error: "ZERO_RATE" };

  const fromUnit = 10n ** BigInt(p.fromDecimals);
  const toUnit = 10n ** BigInt(p.toDecimals);

  const collateralUsd = (p.collateralAmount * p.fromPriceUsd) / fromUnit;
  const debtUsd = (p.debtAmount * p.toPriceUsd) / toUnit;

  const gWad = (p.leverageBps * WAD) / (p.leverageBps - BPS);
  const eWad = (effRate * p.toPriceUsd * fromUnit) / (toUnit * p.fromPriceUsd);
  // g exceeds 1 and e falls below it on any real quote, so this holds outside of a broken oracle.
  // Without the guard the division truncates toward zero and returns a plausible-looking number.
  if (gWad <= eWad) return { ok: false, error: "RATE_ABOVE_LEVERAGE" };

  const flashUsd = (gWad * collateralUsd - debtUsd * WAD) / (gWad - eWad);
  const flashAmount = (flashUsd * fromUnit) / p.fromPriceUsd;
  // The flash is the existing collateral plus the new borrow, so anything at or below the
  // collateral means the sale cannot even clear the old debt. No flash size flips that position.
  if (flashAmount <= p.collateralAmount) return { ok: false, error: "UNDERWATER" };

  const borrowAmount = flashAmount - p.collateralAmount;
  const expectedSwapOut = (flashAmount * p.rateWad) / WAD;
  const expectedCollateral = expectedSwapOut - p.debtAmount;

  // minOut is not a flash-repayment floor — the flash is repaid in kind from two amounts fixed
  // before the swap runs. What it guards is a fill so thin the new collateral cannot carry the
  // borrow, which Aave reverts on. That is a leverage cap just under the wall; the user's own
  // tolerance is usually tighter, so take whichever binds harder.
  const borrowUsd = (borrowAmount * p.fromPriceUsd) / fromUnit;
  const capWad = (capBps * WAD) / (capBps - BPS);
  const ltvFloorUsd = debtUsd + (capWad * borrowUsd) / WAD;
  const ltvFloor = (ltvFloorUsd * toUnit) / p.toPriceUsd;
  const slippageFloor = (expectedSwapOut * (BPS - p.slippageBps)) / BPS;
  const minOut = ltvFloor > slippageFloor ? ltvFloor : slippageFloor;

  const newCollateralUsd = (expectedCollateral * p.toPriceUsd) / toUnit;
  const newDebtUsd = borrowUsd;
  const equityUsd = newCollateralUsd - newDebtUsd;

  return {
    ok: true,
    size: {
      flashAmount,
      borrowAmount,
      minOut,
      expectedSwapOut,
      expectedCollateral,
      expectedDebt: borrowAmount,
      expectedLeverageBps: equityUsd > 0n ? (newCollateralUsd * BPS) / equityUsd : 0n,
      expectedHealthFactorBps:
        newDebtUsd > 0n ? (newCollateralUsd * p.liquidationThresholdBps) / newDebtUsd : 0n,
    },
  };
}

/*
 * The contract call. `sizeFlip` above solves the amounts; everything below turns them into
 * calldata for AaveV3Flipper's single entry point.
 */

/** ABI of AaveV3Flipper (contract/src/AaveV3Flipper.sol). */
export const aaveV3FlipperAbi = parseAbi([
  "struct Permit { uint256 amount; uint256 deadline; bytes32 r; bytes32 s; uint8 v; }",
  "struct Sig { uint256 deadline; bytes32 r; bytes32 s; uint8 v; }",
  "function flipPositionWithPermit(address fromAsset, address toAsset, uint256 flashAmount, uint256 borrowAmount, uint256 minOut, address router, Permit permit, Sig revokePermit, Sig delegation, bytes swapData)",
  "function allowedRouters(address router) view returns (bool)",
  "function getAllowedRouters() view returns (address[])",
  "function paused() view returns (uint256)",
  "event PositionFlipped(address indexed user, address indexed fromAsset, address indexed toAsset, uint256 collateralWithdrawn, uint256 debtRepaid, uint256 collateralSupplied, uint256 debtBorrowed)",
] as const);

export interface PlanFlipInput {
  /** Held as collateral now, owed as debt after. Flashed, sold, and borrowed back. */
  fromAsset: Address;
  /** Owed now, held as collateral after. */
  toAsset: Address;
  /** `sizeFlip`'s `flashAmount`: the whole collateral plus the new borrow. */
  flashAmount: bigint;
  borrowAmount: bigint;
  minOut: bigint;
  router: Address;
  /** Over the `fromAsset` aToken. amount 0n relies on a standing allowance. */
  permit: StrategiesPermit;
  /** Always required — the contract zeroes the aToken allowance on every flip. */
  revokePermit: StrategiesSig;
  /** Signed over exactly `borrowAmount` in `fromAsset`; deadline 0n relies on a standing one. */
  delegation: StrategiesSig;
  swapData: Hex;
}

export interface FlipPlan {
  functionName: "flipPositionWithPermit";
  /** Whose aToken the permit pair must be signed over — the FE reads its nonce and domain. */
  permitAsset: Address;
  /** Whose variable-debt token the delegation must be signed over. */
  delegationAsset: Address;
  args: readonly [
    Address, Address, bigint, bigint, bigint, Address, StrategiesPermit, StrategiesSig,
    StrategiesSig, Hex,
  ];
}

/**
 * Args tuple for the single flip entry point.
 *
 * Both signatures ride on `fromAsset`, at opposite ends of the position: the permit releases the
 * aTokens being given up, and the delegation authorizes borrowing the same asset back as debt.
 * Naming them here keeps the front end from having to re-derive which side is which.
 */
export function planFlip(p: PlanFlipInput): FlipPlan {
  if (p.fromAsset === p.toAsset) {
    throw new Error("planFlip: same asset on both sides — that is not a flip");
  }
  return {
    functionName: "flipPositionWithPermit",
    permitAsset: p.fromAsset,
    delegationAsset: p.fromAsset,
    args: [
      p.fromAsset, p.toAsset, p.flashAmount, p.borrowAmount, p.minOut,
      p.router, p.permit, p.revokePermit, p.delegation, p.swapData,
    ] as const,
  };
}
