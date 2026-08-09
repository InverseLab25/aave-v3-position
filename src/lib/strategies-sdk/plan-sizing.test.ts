import { describe, expect, it } from "vitest";
import { ZERO_STRATEGIES_SIG } from "./abi";
import { planOpen, resolveMode, type OpenMode } from "./plan";
import { sizeOpen } from "./sizing";

// This file proves plan.ts's mode->entry-point mapping and sizing.ts's marginIn->flow mapping
// agree. They are two halves of the same decision (see plan.ts's resolveMode doc comment):
// nothing but this test stops them from being transposed for a mode.

const X = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const; // WETH (volatile)
const S = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const; // USDC (stable)
const R = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const; // router

interface RateFixture {
  rateWad: bigint;
  collateralPriceUsd: bigint;
  debtPriceUsd: bigint;
  collateralDecimals: number;
  debtDecimals: number;
}

// Modes 1/2: collateral = X (WETH, 18dp, $2500), debt = S (USDC, 6dp, $1).
const LONG_PRICES: RateFixture = {
  rateWad: 4n * 10n ** 26n,
  collateralPriceUsd: 250_000_000_000n,
  debtPriceUsd: 100_000_000n,
  collateralDecimals: 18,
  debtDecimals: 6,
};

// Modes 3/4: collateral = S (USDC, 6dp, $1), debt = X (WETH, 18dp, $2500).
const SHORT_PRICES: RateFixture = {
  rateWad: 2_500_000_000n,
  collateralPriceUsd: 100_000_000n,
  debtPriceUsd: 250_000_000_000n,
  collateralDecimals: 6,
  debtDecimals: 18,
};

const GUARDRAILS = {
  ltvBps: 7500n,
  liquidationThresholdBps: 8000n,
  rateBufferBps: 50n,
  slippageBps: 50n,
} as const;

// Per mode: the price/decimals fixture matching that mode's collateral/debt role assignment, and
// a margin amount denominated in whichever asset resolveMode says the margin is in (1 WETH for
// the 18dp asset, 5000 USDC for the 6dp one).
const CASES: Array<{ mode: OpenMode; prices: RateFixture; marginAmount: bigint }> = [
  { mode: 1, prices: LONG_PRICES, marginAmount: 10n ** 18n }, // margin in WETH (collateral)
  { mode: 2, prices: LONG_PRICES, marginAmount: 5_000_000_000n }, // margin in USDC (debt)
  { mode: 3, prices: SHORT_PRICES, marginAmount: 10n ** 18n }, // margin in WETH (debt)
  { mode: 4, prices: SHORT_PRICES, marginAmount: 5_000_000_000n }, // margin in USDC (collateral)
];

describe("resolveMode's marginIn drives the same flow planOpen picks, for every mode", () => {
  for (const { mode, prices, marginAmount } of CASES) {
    it(`mode ${mode}`, () => {
      const resolved = resolveMode({ mode, volatile: X, stable: S });
      const plan = planOpen({
        mode,
        volatile: X,
        stable: S,
        flashAmount: 1n,
        borrowAmount: 2n,
        marginAmount: 3n,
        minOut: 4n,
        router: R,
        swapData: "0x",
        delegation: ZERO_STRATEGIES_SIG,
      });

      const result = sizeOpen({
        marginIn: resolved.marginIn, // driven by resolveMode, not a hand-written literal
        marginAmount,
        leverageBps: 30_000n,
        ...prices,
        ...GUARDRAILS,
      });
      if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
      const size = result.size;

      if (resolved.marginIn === "collateral") {
        // Modes 1 and 4: planOpen must have chosen the collateral-margin entry point, and
        // sizeOpen's collateral-margin flow folds the margin on top of the swap output.
        expect(plan.functionName).toBe("openWithCollateralMargin");
        expect(size.expectedCollateral).toBe(marginAmount + size.expectedSwapOut);
      } else {
        // Modes 2 and 3: planOpen must have chosen the debt-margin entry point, and sizeOpen's
        // debt-margin flow spends the margin inside the swap, so collateral is the output alone.
        expect(plan.functionName).toBe("openWithDebtMargin");
        expect(size.expectedCollateral).toBe(size.expectedSwapOut);
      }
    });
  }
});
