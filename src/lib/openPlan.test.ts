import { expect, it } from 'vitest'
import { rateFromOracle, rateFromQuote } from './openPlan'

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
