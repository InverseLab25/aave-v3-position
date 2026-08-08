import { expect, it } from "vitest";
import {
  BPS,
  LTV_CEILING_FACTOR_BPS,
  maxLeverageForHealthFactorBps,
  maxLeverageForLtvBps,
} from "./sizing";

it("maxLeverageForLtvBps inverts 1/(1-LTV)", () => {
  expect(maxLeverageForLtvBps(7500n)).toBe(40000n); // 75% LTV -> 4.00x
  expect(maxLeverageForLtvBps(8000n)).toBe(50000n); // 80% LTV -> 5.00x
  expect(maxLeverageForLtvBps(5000n)).toBe(20000n); // 50% LTV -> 2.00x
  expect(maxLeverageForLtvBps(0n)).toBe(10000n); // 0% LTV -> 1.00x, still finite
});

it("maxLeverageForLtvBps returns null when LTV is at or above 100%", () => {
  // 1/(1-LTV) has no finite value at or beyond the LTV=100% asymptote, and no such reserve exists.
  expect(maxLeverageForLtvBps(10000n)).toBeNull();
  expect(maxLeverageForLtvBps(12000n)).toBeNull();
});

it("maxLeverageForHealthFactorBps inverts HF/(HF-LT)", () => {
  expect(maxLeverageForHealthFactorBps(8000n, 15000n)).toBe(21428n); // LT 80%, HF 1.5 -> 2.14x
  expect(maxLeverageForHealthFactorBps(8000n, 10000n)).toBe(50000n); // HF 1.0 -> the LTV=LT wall
});

it("maxLeverageForHealthFactorBps returns null when the target is at or below LT", () => {
  // HF decays toward LT as leverage rises, so LT is an asymptote no finite leverage reaches.
  expect(maxLeverageForHealthFactorBps(8000n, 8000n)).toBeNull();
  expect(maxLeverageForHealthFactorBps(8000n, 7000n)).toBeNull();
});

it("the LTV ceiling factor leaves headroom below the exact wall", () => {
  expect(LTV_CEILING_FACTOR_BPS).toBe(9800n);
  const wall = maxLeverageForLtvBps(7500n);
  expect(wall).not.toBeNull();
  if (wall === null) throw new Error("unreachable: asserted non-null above");
  expect((wall * LTV_CEILING_FACTOR_BPS) / BPS).toBe(39200n); // 3.92x, strictly below 4.00x
});
