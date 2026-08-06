// src/lib/leverage-sdk/params.test.ts
import { describe, expect, it } from "vitest";
import { FULL_CLOSE } from "./abi";
import { buildCloseArgs, buildOpenArgs, maxSafeCollateralWithdraw, ZERO_PERMIT, ZERO_REVOKE } from "./params";

const A = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as const; // wstETH
const B = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const; // USDC
const R = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const;

it("buildOpenArgs emits the tuple in ABI order", () => {
  const args = buildOpenArgs({
    collateral: A, debtAsset: B, marginAmount: 1n, flashAmount: 2n, minCollateralOut: 3n,
    router: R, deadline: 4n, swapData: "0x", marginPermit: ZERO_PERMIT, delegation: ZERO_PERMIT,
  });
  expect(args).toEqual([A, B, 1n, 2n, 3n, R, 4n, "0x", ZERO_PERMIT, ZERO_PERMIT]);
});

it("buildCloseArgs defaults to a full close and drain", () => {
  const args = buildCloseArgs({
    collateral: A, debtAsset: B, minOut: 5n, router: R, swapData: "0x",
    permit: ZERO_PERMIT, revokePermit: ZERO_REVOKE,
  });
  expect(args[2]).toBe(FULL_CLOSE); // repayAmount
  expect(args[3]).toBe(FULL_CLOSE); // collateralToWithdraw
});

describe("maxSafeCollateralWithdraw", () => {
  // 10 WETH @ $2,000, 1,000 USDC debt, LT 80%, target HF 1.5.
  const base = {
    totalCollateral: 10n * 10n ** 18n,
    totalDebt: 1_000n * 10n ** 6n,
    collateralPriceUsd: 2_000_00000000n, // 8-decimals oracle style
    debtPriceUsd: 1_00000000n,
    collateralDecimals: 18,
    debtDecimals: 6,
    liquidationThresholdBps: 8_000n,
    targetHealthFactorBps: 15_000n,
  };

  it("full repay frees all collateral", () => {
    expect(maxSafeCollateralWithdraw({ ...base, repayAmount: base.totalDebt })).toBe(FULL_CLOSE);
  });

  it("half repay leaves the HF-required floor supplied", () => {
    // Remaining debt $500 → required collateral = 500 * 1.5 / 0.8 = $937.50 = 0.46875 WETH.
    const out = maxSafeCollateralWithdraw({ ...base, repayAmount: base.totalDebt / 2n });
    expect(out).toBe(10n * 10n ** 18n - 468_750_000_000_000_000n);
  });

  it("zero repay still bounds by target HF", () => {
    // Debt $1,000 → required = 1000 * 1.5 / 0.8 = $1,875 = 0.9375 WETH.
    const out = maxSafeCollateralWithdraw({ ...base, repayAmount: 0n });
    expect(out).toBe(10n * 10n ** 18n - 937_500_000_000_000_000n);
  });

  it("clamps to zero when the floor exceeds the balance", () => {
    const out = maxSafeCollateralWithdraw({ ...base, totalCollateral: 10n ** 17n, repayAmount: 0n });
    expect(out).toBe(0n);
  });
});
