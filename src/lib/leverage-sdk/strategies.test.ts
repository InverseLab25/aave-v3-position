import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAbiItem } from "viem";
import { aaveV3StrategiesAbi, planOpen, ZERO_STRATEGIES_PERMIT, type OpenMode } from "./strategies";

const X = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const; // WETH (volatile)
const S = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const; // USDC (stable)
const R = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const;

const base = {
  volatile: X, stable: S, flashAmount: 1n, borrowAmount: 2n, marginAmount: 3n,
  minOut: 4n, router: R, swapData: "0x" as const, delegation: ZERO_STRATEGIES_PERMIT,
};

it("both open functions exist with 9 inputs", () => {
  for (const name of ["openWithCollateralMargin", "openWithDebtMargin"] as const) {
    const fn = getAbiItem({ abi: aaveV3StrategiesAbi, name });
    expect(fn && "inputs" in fn && fn.inputs).toHaveLength(9);
  }
});

describe("planOpen maps (direction, held asset) onto (function, roles)", () => {
  const table: Array<[OpenMode, string, string, string, string]> = [
    // mode, functionName, collateral, debtAsset, marginAsset
    [1, "openWithCollateralMargin", X, S, X],
    [2, "openWithDebtMargin", X, S, S],
    [3, "openWithDebtMargin", S, X, X],
    [4, "openWithCollateralMargin", S, X, S],
  ];
  for (const [mode, fn, coll, debt, marginAsset] of table) {
    it(`mode ${mode}`, () => {
      const plan = planOpen({ ...base, mode });
      expect(plan.functionName).toBe(fn);
      expect(plan.collateral).toBe(coll);
      expect(plan.debtAsset).toBe(debt);
      expect(plan.marginAsset).toBe(marginAsset);
      expect(plan.args).toEqual([coll, debt, 1n, 2n, 3n, 4n, R, "0x", ZERO_STRATEGIES_PERMIT]);
    });
  }
});

it("planOpen args encode against the Strategies ABI for every mode", () => {
  for (const mode of [1, 2, 3, 4] as const) {
    const plan = planOpen({ ...base, mode });
    const data = encodeFunctionData({ abi: aaveV3StrategiesAbi, functionName: plan.functionName, args: plan.args });
    expect(data.length).toBeGreaterThan(10);
  }
});
