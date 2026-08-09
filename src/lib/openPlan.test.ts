import { expect, it } from 'vitest'
import {
  MAX_REFINE_ROUNDS,
  OPEN_TARGET_HF_BPS,
  leverageCeilingBps,
  minOutFromBuild,
  needsRequote,
  rateFromOracle,
  rateFromQuote,
} from './openPlan'

// Aave prices are on an 8-decimal USD scale: WETH $2500, USDC $1.
const WETH_USD = 250_000_000_000n
const USDC_USD = 100_000_000n

it('derives the oracle rate for an 18-decimal collateral against a 6-decimal debt', () => {
  // Long WETH: collateral WETH (18dp), debt USDC (6dp). One USDC wei buys 4e8 WETH wei.
  expect(
    rateFromOracle({
      collateralPriceUsd: WETH_USD, debtPriceUsd: USDC_USD,
      collateralDecimals: 18, debtDecimals: 6,
    }),
  ).toBe(400000000000000000000000000n)
})

it('derives the oracle rate in the inverted direction', () => {
  // Short WETH: collateral USDC (6dp), debt WETH (18dp).
  expect(
    rateFromOracle({
      collateralPriceUsd: USDC_USD, debtPriceUsd: WETH_USD,
      collateralDecimals: 6, debtDecimals: 18,
    }),
  ).toBe(2_500_000_000n)
})

it('returns 0 when a price is missing, so sizeOpen rejects rather than dividing by zero', () => {
  expect(
    rateFromOracle({
      collateralPriceUsd: 0n, debtPriceUsd: USDC_USD,
      collateralDecimals: 18, debtDecimals: 6,
    }),
  ).toBe(0n)
})

it('derives the real rate from a quote', () => {
  // 2512.562815 USDC in, 1.004102773 WETH out — slightly worse than the oracle's 4e26.
  const rate = rateFromQuote({ amountIn: 2_512_562_815n, amountOut: 1_004_102_773_000_000_000n })
  expect(rate).toBe(399632903506135825702729744n)
  expect(rate).toBeLessThan(400000000000000000000000000n)
})

it('returns 0 for a zero-input quote rather than throwing', () => {
  expect(rateFromQuote({ amountIn: 0n, amountOut: 1n })).toBe(0n)
})

it('re-quotes only when the re-sized borrow grew past what was priced', () => {
  // Bigger trade than the quote measured — its rate is optimistic, so re-price it.
  expect(needsRequote(2_512_562_815n, 2_514_875_291n)).toBe(true)
  // Smaller trade prices at least as well; the existing quote is a safe floor.
  expect(needsRequote(2_512_562_815n, 2_500_000_000n)).toBe(false)
  expect(needsRequote(2_512_562_815n, 2_512_562_815n)).toBe(false)
})

it('caps refinement at two rounds', () => {
  expect(MAX_REFINE_ROUNDS).toBe(2)
})

it('floors minOut at the flash amount when slippage would drop below it', () => {
  // 1.004 WETH out at 0.5% slippage is 0.99908 WETH — short of the 1.0 WETH flash repayment.
  expect(
    minOutFromBuild({
      buildAmountOut: 1_004_102_773_000_000_000n,
      slippageBps: 50n,
      flashAmount: 1_000_000_000_000_000_000n,
    }),
  ).toBe(1_000_000_000_000_000_000n)
})

it('uses the slippage floor when it clears the flash amount', () => {
  expect(
    minOutFromBuild({
      buildAmountOut: 1_050_000_000_000_000_000n,
      slippageBps: 50n,
      flashAmount: 1_000_000_000_000_000_000n,
    }),
  ).toBe(1_044_750_000_000_000_000n)
})

it('bounds the leverage slider with a soft HF ceiling below the hard LTV wall', () => {
  // WETH: LTV 75%, LT 80%. Hard wall 4.00x, haircut to 3.92x. HF 1.5 holds at 2.14x.
  expect(OPEN_TARGET_HF_BPS).toBe(15_000n)
  expect(leverageCeilingBps({ ltvBps: 7500n, liquidationThresholdBps: 8000n })).toEqual({
    soft: 21_428n,
    hard: 39_200n,
  })
})

it('drops the soft ceiling when the target HF is unreachable at any leverage', () => {
  // HF decays toward LT as leverage rises, so a target at or below LT has no finite solution.
  expect(leverageCeilingBps({ ltvBps: 7500n, liquidationThresholdBps: 15_000n })).toEqual({
    soft: null,
    hard: 39_200n,
  })
})

it('reports no hard wall for an LTV at or above 100%', () => {
  expect(leverageCeilingBps({ ltvBps: 10_000n, liquidationThresholdBps: 8000n }).hard).toBeNull()
})

it('never lets the soft ceiling exceed the hard wall', () => {
  // A very permissive LT against a restrictive LTV would otherwise put soft above hard.
  const { soft, hard } = leverageCeilingBps({ ltvBps: 2000n, liquidationThresholdBps: 9500n })
  expect(hard).toBe(12_250n)
  expect(soft).toBe(12_250n)
})
