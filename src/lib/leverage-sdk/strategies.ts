import { parseAbi, type Address, type Hex } from "viem";

/** Native Strategies permit shape: {amount, deadline, r, s, v}. */
export interface StrategiesPermit {
  amount: bigint;
  deadline: bigint;
  r: Hex;
  s: Hex;
  v: number;
}

/** Native Strategies revoke permit shape: {deadline, r, s, v}. */
export interface StrategiesSig {
  deadline: bigint;
  r: Hex;
  s: Hex;
  v: number;
}

const ZERO_B32 = `0x${"00".repeat(32)}` as const satisfies Hex;

/** Zeroed delegation: contract skips delegationWithSig when amount == 0 (existing delegation). */
export const ZERO_STRATEGIES_PERMIT: StrategiesPermit = {
  amount: 0n,
  deadline: 0n,
  r: ZERO_B32,
  s: ZERO_B32,
  v: 0,
};

/** Zeroed revoke permit: for positions without credit delegation. */
export const ZERO_STRATEGIES_SIG: StrategiesSig = {
  deadline: 0n,
  r: ZERO_B32,
  s: ZERO_B32,
  v: 0,
};

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
  /** Collateral flash-borrowed and supplied (exact exposure component). */
  flashAmount: bigint;
  /** Debt borrowed on the user's credit delegation. */
  borrowAmount: bigint;
  /** Margin pulled from the wallet — in `marginAsset` of the returned plan. */
  marginAmount: bigint;
  /** Swap-output floor; must also cover `flashAmount` (the contract enforces both). */
  minOut: bigint;
  router: Address;
  swapData: Hex;
  /** Signed over exactly `borrowAmount`; deadline 0n = rely on an existing delegation. */
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

/** AaveV3Strategies' pause is all-or-nothing: any nonzero `paused` halts BOTH legs. */
export async function getStrategiesPauseState(
  client: { readContract(params: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown> },
  contract: Address,
): Promise<{ paused: boolean }> {
  const bits = (await client.readContract({
    address: contract, abi: aaveV3StrategiesAbi, functionName: "paused",
  })) as bigint;
  return { paused: bits !== 0n };
}

/** Maps a UX mode onto the contract call: which entry point, and which asset plays which role. */
export function planOpen(p: PlanOpenInput): OpenPlan {
  if (p.mode !== 1 && p.mode !== 2 && p.mode !== 3 && p.mode !== 4) {
    throw new Error(`invalid open mode: ${p.mode}`);
  }
  const long = p.mode === 1 || p.mode === 2;
  const collateral = long ? p.volatile : p.stable;
  const debtAsset = long ? p.stable : p.volatile;
  const collateralMargin = p.mode === 1 || p.mode === 4;

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
