import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { aaveV3StrategiesAbi, FULL_CLOSE, ZERO_STRATEGIES_PERMIT, ZERO_STRATEGIES_SIG } from "./abi";
import { planClose, planOpen, type OpenMode } from "./plan";

const X = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const; // WETH (volatile)
const S = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const; // USDC (stable)
const R = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const; // router

const openBase = {
  volatile: X,
  stable: S,
  flashAmount: 1n,
  borrowAmount: 2n,
  marginAmount: 3n,
  minOut: 4n,
  router: R,
  swapData: "0x" as const,
  delegation: ZERO_STRATEGIES_SIG,
};

describe("planOpen maps (direction, held asset) onto (entry point, asset roles)", () => {
  const table: Array<[OpenMode, string, string, string, string]> = [
    // mode, functionName, collateral, debtAsset, marginAsset
    [1, "openWithCollateralMargin", X, S, X],
    [2, "openWithDebtMargin", X, S, S],
    [3, "openWithDebtMargin", S, X, X],
    [4, "openWithCollateralMargin", S, X, S],
  ];
  for (const [mode, fn, coll, debt, marginAsset] of table) {
    it(`mode ${mode}`, () => {
      const plan = planOpen({ ...openBase, mode });
      expect(plan.functionName).toBe(fn);
      expect(plan.collateral).toBe(coll);
      expect(plan.debtAsset).toBe(debt);
      expect(plan.marginAsset).toBe(marginAsset);
      expect(plan.args).toEqual([coll, debt, 1n, 2n, 3n, 4n, R, "0x", ZERO_STRATEGIES_SIG]);
    });
  }
});

it("planOpen rejects an out-of-range mode", () => {
  expect(() => planOpen({ ...openBase, mode: 5 as never })).toThrow("invalid open mode");
});

it("planOpen args encode against the ABI for every mode", () => {
  for (const mode of [1, 2, 3, 4] as const) {
    const plan = planOpen({ ...openBase, mode });
    const data = encodeFunctionData({
      abi: aaveV3StrategiesAbi,
      functionName: plan.functionName,
      args: plan.args,
    });
    expect(data.startsWith("0x")).toBe(true);
  }
});

it("planClose defaults both amounts to the full-close sentinel", () => {
  const plan = planClose({
    collateral: X,
    debtAsset: S,
    minOut: 7n,
    router: R,
    permit: ZERO_STRATEGIES_PERMIT,
    revokePermit: ZERO_STRATEGIES_SIG,
    swapData: "0x",
  });
  expect(plan.functionName).toBe("closePositionWithPermit");
  expect(plan.args).toEqual([
    X, S, FULL_CLOSE, FULL_CLOSE, 7n, R, ZERO_STRATEGIES_PERMIT, ZERO_STRATEGIES_SIG, "0x",
  ]);
});

it("planClose keeps explicit partial amounts in ABI order (withdraw before repay)", () => {
  const plan = planClose({
    collateral: X,
    debtAsset: S,
    collateralToWithdraw: 11n,
    debtRepay: 22n,
    minOut: 7n,
    router: R,
    permit: ZERO_STRATEGIES_PERMIT,
    revokePermit: ZERO_STRATEGIES_SIG,
    swapData: "0x",
  });
  expect(plan.args[2]).toBe(11n); // collateralToWithdraw
  expect(plan.args[3]).toBe(22n); // debtRepay
});

it("planClose args encode against the ABI", () => {
  const plan = planClose({
    collateral: X,
    debtAsset: S,
    minOut: 7n,
    router: R,
    permit: ZERO_STRATEGIES_PERMIT,
    revokePermit: ZERO_STRATEGIES_SIG,
    swapData: "0x",
  });
  const data = encodeFunctionData({
    abi: aaveV3StrategiesAbi,
    functionName: plan.functionName,
    args: plan.args,
  });
  expect(data.startsWith("0x329438a8")).toBe(true);
});
