import { expect, it } from "vitest";
import {
  BPS,
  LTV_CEILING_FACTOR_BPS,
  maxLeverageForHealthFactorBps,
  maxLeverageForLtvBps,
  sizeOpen,
  type SizeOpenInput,
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

// WETH (18dp) at $2500 and USDC (6dp) at $1, both on Aave's 8-decimal USD scale.
// 1 USDC wei buys 4e8 WETH wei, so rateWad = 4e8 * 1e18.
const PRICES = {
  rateWad: 4n * 10n ** 26n,
  collateralPriceUsd: 250_000_000_000n,
  debtPriceUsd: 100_000_000n,
  collateralDecimals: 18,
  debtDecimals: 6,
  ltvBps: 7500n,
  liquidationThresholdBps: 8000n,
  rateBufferBps: 50n,
  slippageBps: 50n,
} as const;

const collateralMargin: SizeOpenInput = {
  marginIn: "collateral",
  marginAmount: 10n ** 18n, // 1 WETH
  leverageBps: 30_000n, // 3.00x
  ...PRICES,
};

function unwrap(r: ReturnType<typeof sizeOpen>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.size;
}

it("sizes a 3x collateral-margin open against a 0.5% rate buffer", () => {
  const s = unwrap(sizeOpen(collateralMargin));
  expect(s.flashAmount).toBe(2_000_000_000_000_000_000n); // 2 WETH: M * (L - 1)
  expect(s.borrowAmount).toBe(5_025_125_629n); // 5025.125629 USDC, rounded up
  expect(s.expectedSwapOut).toBe(2_010_050_251_600_000_000n); // 2.01005 WETH
  expect(s.minOut).toBe(2_000_000_000_342_000_000n); // just above the flash it must clear
  expect(s.expectedCollateral).toBe(3_010_050_251_600_000_000n); // margin + swap output
  expect(s.expectedDebt).toBe(5_025_125_629n);
});

it("borrowing enough to clear the flash makes realized leverage a floor, not a target", () => {
  const s = unwrap(sizeOpen(collateralMargin));
  expect(s.expectedLeverageBps).toBe(30_100n); // 3.01x, above the 3.00x requested
  expect(s.expectedLeverageBps).toBeGreaterThan(collateralMargin.leverageBps);
  expect(s.expectedHealthFactorBps).toBe(11_979n); // ~1.198, matching L*LT/(L-1) at 3.01x
});

it("minOut never lands below the flash amount the swap has to repay", () => {
  const s = unwrap(sizeOpen({ ...collateralMargin, slippageBps: 500n }));
  expect(s.minOut).toBe(s.flashAmount);
});

it("a wider rate buffer borrows more and lands higher up the leverage floor", () => {
  const tight = unwrap(sizeOpen({ ...collateralMargin, rateBufferBps: 10n }));
  const wide = unwrap(sizeOpen({ ...collateralMargin, rateBufferBps: 200n }));
  expect(wide.borrowAmount).toBeGreaterThan(tight.borrowAmount);
  expect(wide.expectedLeverageBps).toBeGreaterThan(tight.expectedLeverageBps);
  expect(wide.expectedHealthFactorBps).toBeLessThan(tight.expectedHealthFactorBps);
});

it("sizes correctly when the collateral is the 6-decimal asset (short direction)", () => {
  // Mode 4: USDC collateral (6dp, $1), WETH debt (18dp, $2500). One WETH wei is worth
  // 2.5e-9 USDC wei, so rateWad = 2.5e-9 * 1e18 = 2.5e9.
  const s = unwrap(
    sizeOpen({
      marginIn: "collateral",
      marginAmount: 5_000_000_000n, // 5000 USDC
      leverageBps: 20_000n, // 2.00x
      rateWad: 2_500_000_000n,
      collateralPriceUsd: 100_000_000n,
      debtPriceUsd: 250_000_000_000n,
      collateralDecimals: 6,
      debtDecimals: 18,
      ltvBps: 7500n,
      liquidationThresholdBps: 8000n,
      rateBufferBps: 50n,
      slippageBps: 50n,
    }),
  );
  expect(s.flashAmount).toBe(5_000_000_000n); // M * (2 - 1)
  expect(s.borrowAmount).toBe(2_010_050_251_256_281_408n); // ~2.01 WETH
  expect(s.expectedSwapOut).toBe(5_025_125_628n);
  expect(s.expectedCollateral).toBe(10_025_125_628n); // margin + swap output
  expect(s.expectedLeverageBps).toBe(20_050n); // above the 2.00x requested
});

it.each([
  ["ZERO_MARGIN", { marginAmount: 0n }],
  ["ZERO_RATE", { rateWad: 0n }],
  ["LEVERAGE_TOO_LOW", { leverageBps: 10_000n }],
  ["LEVERAGE_ABOVE_LTV", { leverageBps: 39_200n }], // == 0.98 * the 4.00x wall
  ["ZERO_PRICE", { collateralPriceUsd: 0n }],
  ["INVALID_LTV", { ltvBps: 10_000n }], // 100% LTV has no finite wall; must not throw
])("rejects with %s rather than throwing", (error, override) => {
  const r = sizeOpen({ ...collateralMargin, ...override });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.error).toBe(error);
});

it("accepts leverage just under the LTV ceiling", () => {
  const r = sizeOpen({ ...collateralMargin, leverageBps: 39_199n });
  expect(r.ok).toBe(true);
});

const debtMargin: SizeOpenInput = {
  marginIn: "debt",
  marginAmount: 5_000_000_000n, // 5000 USDC
  leverageBps: 30_000n, // 3.00x
  ...PRICES,
};

it("sizes a 3x debt-margin open, spending the margin inside the swap", () => {
  const s = unwrap(sizeOpen(debtMargin));
  expect(s.flashAmount).toBe(6_000_000_000_000_000_000n); // 6 WETH == $15000 of exposure
  expect(s.borrowAmount).toBe(10_075_376_885n); // swapIn minus the 5000 USDC margin
  expect(s.expectedSwapOut).toBe(6_030_150_754_000_000_000n);
  expect(s.minOut).toBe(6_000_000_000_230_000_000n);
  expect(s.expectedCollateral).toBe(6_030_150_754_000_000_000n); // the whole swap output
  expect(s.expectedDebt).toBe(10_075_376_885n);
});

it("the debt-margin position lands on the same leverage floor", () => {
  const s = unwrap(sizeOpen(debtMargin));
  expect(s.expectedLeverageBps).toBe(30_150n); // 3.015x
  expect(s.expectedHealthFactorBps).toBe(11_970n);
});

it("the margin is not double-counted: collateral equals the swap output alone", () => {
  const s = unwrap(sizeOpen(debtMargin));
  expect(s.expectedCollateral).toBe(s.expectedSwapOut);
  expect(s.borrowAmount).toBeLessThan(s.borrowAmount + debtMargin.marginAmount);
});

it("sizes correctly when the debt asset is the 18-decimal one (short direction)", () => {
  // Mode 3: USDC collateral (6dp, $1), WETH debt (18dp, $2500), margin held in WETH.
  // One WETH wei is worth 2.5e-9 USDC wei, so rateWad = 2.5e9.
  const s = unwrap(
    sizeOpen({
      marginIn: "debt",
      marginAmount: 10n ** 18n, // 1 WETH
      leverageBps: 20_000n,
      rateWad: 2_500_000_000n,
      collateralPriceUsd: 100_000_000n,
      debtPriceUsd: 250_000_000_000n,
      collateralDecimals: 6,
      debtDecimals: 18,
      ltvBps: 7500n,
      liquidationThresholdBps: 8000n,
      rateBufferBps: 50n,
      slippageBps: 50n,
    }),
  );
  expect(s.flashAmount).toBe(5_000_000_000n); // 2 * $2500 = $5000 of USDC collateral
  expect(s.borrowAmount).toBe(1_010_050_251_256_281_408n); // swapIn minus the 1 WETH margin
  expect(s.expectedCollateral).toBe(5_025_125_628n);
  expect(s.expectedCollateral).toBe(s.expectedSwapOut);
  expect(s.expectedLeverageBps).toBe(20_100n);
});

it("rejects when a market rate better than the oracle leaves nothing to borrow", () => {
  // At low leverage the margin can cover the whole swap input on its own once the quoted rate
  // beats the oracle-implied one. Borrowing zero reverts ZeroAmount on-chain, so reject here.
  // Note a plain low leverage does NOT trigger this: at the oracle rate the borrow is
  // (L-1) * margin, which stays positive for any L above 1.
  const r = sizeOpen({ ...debtMargin, leverageBps: 10_500n, rateWad: 5n * 10n ** 26n });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.error).toBe("LEVERAGE_TOO_LOW");
});

it("accepts a barely-levered debt-margin open, borrowing only the sliver above the margin", () => {
  const s = unwrap(sizeOpen({ ...debtMargin, leverageBps: 10_001n }));
  expect(s.borrowAmount).toBe(25_628_141n); // ~25.6 USDC on a 5000 USDC margin
  expect(s.expectedLeverageBps).toBe(10_051n);
});

it("applies the same guardrails as the collateral-margin flow", () => {
  expect(sizeOpen({ ...debtMargin, marginAmount: 0n }).ok).toBe(false);
  expect(sizeOpen({ ...debtMargin, leverageBps: 39_200n }).ok).toBe(false);
  expect(sizeOpen({ ...debtMargin, debtPriceUsd: 0n }).ok).toBe(false);
});
