import { expect, it } from "vitest";
import { toFunctionSelector, getAbiItem } from "viem";
import {
  aaveV3StrategiesAbi,
  FULL_CLOSE,
  ZERO_STRATEGIES_PERMIT,
  ZERO_STRATEGIES_SIG,
} from "./abi";

// Pinned from `forge inspect AaveV3Strategies methods`. A struct field reordered in the
// parseAbi strings still parses, but produces calldata the contract rejects — only the
// selector catches it.
const SELECTORS: Record<string, `0x${string}`> = {
  openWithDebtMargin: "0xbfbf1d96",
  openWithCollateralMargin: "0x980dae0f",
  closePositionWithPermit: "0x329438a8",
  allowedRouters: "0xc646aee2",
  getAllowedRouters: "0x21d062b4",
  paused: "0x5c975abb",
};

it.each(Object.entries(SELECTORS))("%s matches the deployed selector", (name, selector) => {
  const item = getAbiItem({ abi: aaveV3StrategiesAbi, name: name as never });
  expect(item, `${name} missing from the ABI`).toBeDefined();
  expect(toFunctionSelector(item as never)).toBe(selector as never);
});

it("both open entry points take 9 arguments", () => {
  for (const name of ["openWithDebtMargin", "openWithCollateralMargin"] as const) {
    const fn = getAbiItem({ abi: aaveV3StrategiesAbi, name });
    expect(fn && "inputs" in fn && fn.inputs).toHaveLength(9);
  }
});

it("FULL_CLOSE is the uint256 max sentinel", () => {
  expect(FULL_CLOSE).toBe(2n ** 256n - 1n);
});

it("zero sentinels are fully zeroed", () => {
  expect(ZERO_STRATEGIES_PERMIT).toEqual({
    amount: 0n,
    deadline: 0n,
    r: `0x${"00".repeat(32)}`,
    s: `0x${"00".repeat(32)}`,
    v: 0,
  });
  expect(ZERO_STRATEGIES_SIG).toEqual({
    deadline: 0n,
    r: `0x${"00".repeat(32)}`,
    s: `0x${"00".repeat(32)}`,
    v: 0,
  });
});
