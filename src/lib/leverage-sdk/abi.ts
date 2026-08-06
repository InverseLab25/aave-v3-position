import { parseAbi } from "viem";

/** ABI of AaveV3Leverage (contract/src/AaveV3Leverage.sol). */
export const aaveV3LeverageAbi = parseAbi([
  "struct Permit { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "struct RevokePermit { uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function openPosition(address collateral, address debtAsset, uint256 marginAmount, uint256 flashAmount, uint256 minCollateralOut, address router, uint256 deadline, bytes swapData, Permit marginPermit, Permit delegation)",
  "function closePosition(address collateral, address debtAsset, uint256 repayAmount, uint256 collateralToWithdraw, uint256 minOut, address router, bytes swapData, Permit permit, RevokePermit revokePermit)",
  "function allowedRouters(address router) view returns (bool)",
  "function getAllowedRouters() view returns (address[])",
  "function paused() view returns (uint256)",
  "event PositionOpened(address indexed user, address indexed collateral, address indexed debtAsset, uint256 margin, uint256 collateralSupplied, uint256 debtBorrowed)",
  "event PositionClosed(address indexed user, address indexed collateral, address indexed debtAsset, uint256 debtRepaid, uint256 collateralWithdrawn, uint256 returnedToUser)",
] as const);

/** Sentinel: repay the entire variable debt / drain the whole aToken balance. */
export const FULL_CLOSE = 2n ** 256n - 1n;
export const DRAIN_ALL = FULL_CLOSE;

/** Pause bitmask, mirrors the contract constants. */
export const PAUSE_OPEN = 1n << 0n;
export const PAUSE_CLOSE = 1n << 1n;
