import { expect, it } from "vitest";
import { sizeFlip, type SizeFlipInput } from "./flip";

// A 400 WETH long at exactly 3.00x, flipping to a 2.00x short.
// WETH (18dp) at $2000 and USDC (6dp) at $1 on Aave's 8-decimal USD scale.
// 1 WETH wei sells for 1994e-12 USDC wei, so rateWad = 1994e6.
const LONG_3X: SizeFlipInput = {
  collateralAmount: 400n * 10n ** 18n,
  debtAmount: 533_333_333_333n,
  leverageBps: 20_000n,
  rateWad: 1_994_000_000n,
  fromPriceUsd: 200_000_000_000n,
  toPriceUsd: 100_000_000n,
  fromDecimals: 18,
  toDecimals: 6,
  ltvBps: 7_700n,
  liquidationThresholdBps: 8_500n,
  rateBufferBps: 50n,
  slippageBps: 50n,
};

function unwrap(r: ReturnType<typeof sizeFlip>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.size;
}

it("sizes the flash as the whole collateral plus the new borrow", () => {
  const s = unwrap(sizeFlip(LONG_3X));
  expect(s.flashAmount).toBe(529_108_402_737_635_000_000n); // 529.108403 WETH
  expect(s.borrowAmount).toBe(129_108_402_737_635_000_000n); // 129.108403 WETH
  expect(s.flashAmount - s.borrowAmount).toBe(LONG_3X.collateralAmount);
});

it("settles the swap proceeds into the old debt and the new collateral", () => {
  const s = unwrap(sizeFlip(LONG_3X));
  expect(s.expectedSwapOut).toBe(1_055_042_155_058n); // 1,055,042.155058 USDC
  // Everything the sale returns beyond clearing the old debt becomes the new collateral.
  expect(s.expectedCollateral).toBe(s.expectedSwapOut - LONG_3X.debtAmount);
  expect(s.expectedCollateral).toBe(521_708_821_725n);
  expect(s.expectedDebt).toBe(s.borrowAmount);
});

it("undershoots the requested leverage because the rate buffer oversizes the collateral", () => {
  const s = unwrap(sizeFlip(LONG_3X));
  // Sized as if the fill were 1984.03 but quoted at 1994, so the surplus lands as collateral and
  // pulls leverage below target. Undershooting is the safe side of the target.
  expect(s.expectedLeverageBps).toBe(19_799n); // 1.98x against a 2.00x request
  expect(s.expectedLeverageBps).toBeLessThan(LONG_3X.leverageBps);
  expect(s.expectedHealthFactorBps).toBe(17_173n); // 1.7173
});

it("holds minOut at the user's slippage floor when that is the tighter of the two", () => {
  const s = unwrap(sizeFlip(LONG_3X));
  expect(s.minOut).toBe(1_049_766_944_282n); // expectedSwapOut less 0.5%
});

it("falls back to the LTV backstop when the slippage floor drops below it", () => {
  // The flash repays in kind, so minOut is not a repayment floor. What it has to stop is a fill
  // so thin the new collateral cannot support the borrow, which Aave would revert on.
  const s = unwrap(sizeFlip({ ...LONG_3X, slippageBps: 2_000n }));
  expect(s.minOut).toBe(870_738_315_168n); // above the 844,033.724046 a 20% tolerance would allow
});

function expectError(p: SizeFlipInput, error: string) {
  const r = sizeFlip(p);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unreachable: asserted not ok above");
  expect(r.error).toBe(error);
}

it("rejects a position with nothing to flip", () => {
  expectError({ ...LONG_3X, collateralAmount: 0n }, "ZERO_COLLATERAL");
});

it("rejects leverage at or below 1x, where the flipped position has no debt to solve for", () => {
  expectError({ ...LONG_3X, leverageBps: 10_000n }, "LEVERAGE_TOO_LOW");
  expectError({ ...LONG_3X, leverageBps: 9_000n }, "LEVERAGE_TOO_LOW");
});

it("rejects a target above the destination collateral's LTV wall", () => {
  // The ceiling is the wall for the asset being moved INTO, not the one being left behind:
  // USDC at 77% LTV walls at 4.3478x, and sizing stays 2% below that.
  expectError({ ...LONG_3X, leverageBps: 45_000n }, "LEVERAGE_ABOVE_LTV");
});

it("rejects an LTV with no finite wall", () => {
  expectError({ ...LONG_3X, ltvBps: 10_000n }, "INVALID_LTV");
});

it("rejects a missing rate, including one the buffer wipes out", () => {
  expectError({ ...LONG_3X, rateWad: 0n }, "ZERO_RATE");
  expectError({ ...LONG_3X, rateBufferBps: 10_000n }, "ZERO_RATE");
});

it("rejects a missing oracle price on either side", () => {
  expectError({ ...LONG_3X, fromPriceUsd: 0n }, "ZERO_PRICE");
  expectError({ ...LONG_3X, toPriceUsd: 0n }, "ZERO_PRICE");
});

it("rejects a position whose sale cannot clear its own debt", () => {
  // Selling all 400 WETH at the buffered rate returns $793,612, short of the debt. There is no
  // flash size that flips this, and the borrow would come out negative.
  expectError({ ...LONG_3X, debtAmount: 795_000_000_000n }, "UNDERWATER");
});

it("rejects a rate so far above the oracle that the leverage identity inverts", () => {
  // Guards the sign of (g - e). Not reachable with a sane quote, but the division would
  // silently truncate toward zero and hand back a nonsense flash size.
  expectError({ ...LONG_3X, rateWad: 4_100_000_000n }, "RATE_ABOVE_LEVERAGE");
});

it("flips an unlevered supply, where there is no debt to clear first", () => {
  const s = unwrap(sizeFlip({ ...LONG_3X, debtAmount: 0n }));
  expect(s.flashAmount).toBe(793_662_604_106_210_000_000n);
  expect(s.borrowAmount).toBe(393_662_604_106_210_000_000n);
  expect(s.expectedCollateral).toBe(s.expectedSwapOut);
});

it("sizes the short back into a long through the same path, with the roles swapped", () => {
  // The position the first flip produced, going back to 3x long. Nothing about the function
  // knows which direction it is pointed: `from` is simply whatever is collateral today, and the
  // decimals, prices and reserve params follow it. This is what lets one contract path serve both.
  const s = unwrap(
    sizeFlip({
      collateralAmount: 521_708_821_725n, // USDC, 6dp
      debtAmount: 129_108_402_737_635_000_000n, // WETH, 18dp
      leverageBps: 30_000n,
      rateWad: 498_504_486_540_378_863_409_770_687n, // WETH wei per USDC wei at 2006 USDC/WETH
      fromPriceUsd: 100_000_000n,
      toPriceUsd: 200_000_000_000n,
      fromDecimals: 6,
      toDecimals: 18,
      ltvBps: 8_050n, // now walled by WETH, the asset being moved into
      liquidationThresholdBps: 8_300n,
      rateBufferBps: 50n,
      slippageBps: 50n,
    }),
  );
  expect(s.flashAmount).toBe(1_032_226_626_876n); // 1,032,226.63 USDC
  expect(s.borrowAmount).toBe(510_517_805_151n);
  expect(s.expectedCollateral).toBe(385_461_201_886_492_617_148n); // 385.46 WETH
  expect(s.expectedLeverageBps).toBe(29_604n); // 2.96x, undershooting 3.00x as it should
});
