import { parseAbi, type Hex } from "viem";

/** Strategies' permit shape: {amount, deadline, r, s, v}. Field order differs from
 *  the superseded AaveV3Leverage's — the ABI selector test pins it. */
export interface StrategiesPermit {
  amount: bigint;
  deadline: bigint;
  r: Hex;
  s: Hex;
  v: number;
}

/** A bare signature. The signed value is implied by the call site, never carried here:
 *  0 for the close revoke, `borrowAmount` for a delegation. */
export interface StrategiesSig {
  deadline: bigint;
  r: Hex;
  s: Hex;
  v: number;
}

const ZERO_B32 = `0x${"00".repeat(32)}` as const satisfies Hex;

/** amount == 0 makes the contract skip the permit and rely on a standing allowance.
 *  The revoke still runs, so a real `Sig` is required alongside this. */
export const ZERO_STRATEGIES_PERMIT: StrategiesPermit = {
  amount: 0n,
  deadline: 0n,
  r: ZERO_B32,
  s: ZERO_B32,
  v: 0,
};

/** deadline == 0 makes the contract skip a delegation and rely on a standing one.
 *  Valid for the open leg only — the close revoke has no such opt-out. */
export const ZERO_STRATEGIES_SIG: StrategiesSig = {
  deadline: 0n,
  r: ZERO_B32,
  s: ZERO_B32,
  v: 0,
};

/** Sentinel: repay the entire variable debt / drain the whole aToken balance. */
export const FULL_CLOSE = 2n ** 256n - 1n;

/** ABI of AaveV3Strategies (contract/src/AaveV3Strategies.sol). */
export const aaveV3StrategiesAbi = parseAbi([
  "struct Permit { uint256 amount; uint256 deadline; bytes32 r; bytes32 s; uint8 v; }",
  "struct Sig { uint256 deadline; bytes32 r; bytes32 s; uint8 v; }",
  "function openWithDebtMargin(address collateral, address debtAsset, uint256 supplyAmount, uint256 borrowAmount, uint256 marginAmount, uint256 minOut, address router, bytes swapData, Sig delegation)",
  "function openWithCollateralMargin(address collateral, address debtAsset, uint256 flashAmount, uint256 borrowAmount, uint256 marginAmount, uint256 minOut, address router, bytes swapData, Sig delegation)",
  "function closePositionWithPermit(address collateral, address debtAsset, uint256 collateralToWithdraw, uint256 debtRepay, uint256 minOut, address router, Permit permit, Sig revokePermit, bytes swapData)",
  "function allowedRouters(address router) view returns (bool)",
  "function getAllowedRouters() view returns (address[])",
  "function paused() view returns (uint256)",
  "event PositionOpened(address indexed user, address indexed collateral, address indexed debtAsset, uint256 margin, uint256 collateralSupplied, uint256 debtBorrowed)",
  "event PositionClosed(address indexed user, address indexed collateral, address indexed debtAsset, uint256 debtRepaid, uint256 collateralWithdrawn, uint256 returnedToUser)",
] as const);
