import { expect, it } from "vitest";
import { getAbiItem, toFunctionSelector, type Address, type Hex } from "viem";
import { ZERO_STRATEGIES_PERMIT, ZERO_STRATEGIES_SIG, type StrategiesSig } from "./abi";
import { aaveV3FlipperAbi, planFlip, type PlanFlipInput } from "./flip";

const WETH = "0x0000000000000000000000000000000000000001" as Address;
const USDC = "0x0000000000000000000000000000000000000002" as Address;
const ROUTER = "0x0000000000000000000000000000000000000003" as Address;

const SIG: StrategiesSig = { deadline: 99n, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 };

const BASE: PlanFlipInput = {
  fromAsset: WETH,
  toAsset: USDC,
  flashAmount: 529n,
  borrowAmount: 129n,
  minOut: 1_049_766n,
  router: ROUTER,
  permit: { ...ZERO_STRATEGIES_PERMIT, amount: 400n, deadline: 99n },
  revokePermit: SIG,
  delegation: SIG,
  swapData: "0xdeadbeef" as Hex,
};

it("pins the flip entry point's selector", () => {
  // From `forge inspect AaveV3Flipper methods`. Reordering a struct field still parses here but
  // produces calldata the contract rejects, and only the selector catches that.
  const item = getAbiItem({ abi: aaveV3FlipperAbi, name: "flipPositionWithPermit" });
  expect(toFunctionSelector(item as never)).toBe("0x6f17d553");
});

it("lays the args out in the entry point's order", () => {
  const plan = planFlip(BASE);
  expect(plan.functionName).toBe("flipPositionWithPermit");
  expect(plan.args).toEqual([
    WETH,
    USDC,
    529n,
    129n,
    1_049_766n,
    ROUTER,
    BASE.permit,
    SIG,
    SIG,
    "0xdeadbeef",
  ]);
});

it("names the aToken the wallet has to have signed over", () => {
  // The permit covers the asset being left behind, never the one being moved into. Getting this
  // backwards signs the wrong token and the flip reverts at the pull.
  expect(planFlip(BASE).permitAsset).toBe(WETH);
  expect(planFlip({ ...BASE, fromAsset: USDC, toAsset: WETH }).permitAsset).toBe(USDC);
});

it("names the debt token the delegation has to cover", () => {
  // Credit delegation is over the asset being borrowed, which is the one being left behind —
  // the same asset as the permit, at the other end of the position.
  expect(planFlip(BASE).delegationAsset).toBe(WETH);
  expect(planFlip({ ...BASE, fromAsset: USDC, toAsset: WETH }).delegationAsset).toBe(USDC);
});

it("rejects a flip that would leave the position where it started", () => {
  expect(() => planFlip({ ...BASE, toAsset: WETH })).toThrow(/same asset/i);
});

it("carries the standing-signature sentinels through untouched", () => {
  // A zero permit relies on an existing allowance and a zero delegation on a standing one. The
  // contract reads both as opt-outs, so the plan must not substitute anything for them.
  const plan = planFlip({
    ...BASE,
    permit: ZERO_STRATEGIES_PERMIT,
    delegation: ZERO_STRATEGIES_SIG,
  });
  expect(plan.args[6]).toBe(ZERO_STRATEGIES_PERMIT);
  expect(plan.args[8]).toBe(ZERO_STRATEGIES_SIG);
});
