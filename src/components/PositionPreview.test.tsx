import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PositionPreview } from './PositionPreview'

const PREVIEW = {
  collateral: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  debtAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  marginAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  flashAmount: 1_000_000_000_000_000_000n,
  borrowAmount: 2_512_562_815n,
  minOut: 1_000_000_000_370_000_000n,
  expectedCollateral: 2_005_025_126_000_000_000n,
  expectedDebt: 2_512_562_815n,
  expectedLeverageBps: 20_050n,
  expectedHealthFactorBps: 15_959n,
  router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  swapData: '0x',
  aggregator: 'KyberSwap',
  priceImpactPercent: null,
} as const

it('shows the resulting position, not the inputs', () => {
  render(
    <PositionPreview
      preview={PREVIEW} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      existingCollateralUsd={0n} existingDebtUsd={0n} existingLiquidationThreshold={0}
    />,
  )
  expect(screen.getByText(/2\.005/)).toBeTruthy()      // collateral
  expect(screen.getByText(/2,512\.56/)).toBeTruthy()   // debt
  expect(screen.getByText(/1\.60/)).toBeTruthy()       // health factor
  expect(screen.getByText(/2\.00x/)).toBeTruthy()      // realized leverage
  expect(screen.getByText(/KyberSwap/)).toBeTruthy()
})

it('flags price impact past PRICE_IMPACT_HIGH_PERCENT', () => {
  render(
    <PositionPreview
      preview={{ ...PREVIEW, priceImpactPercent: 3.4 }} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      existingCollateralUsd={0n} existingDebtUsd={0n} existingLiquidationThreshold={0}
    />,
  )
  expect(screen.getByText(/3\.40%/)).toBeTruthy()
})

it('shows an em-dash, not 0.00x, when leverage is not meaningful', () => {
  // The ratchet path adds ~no equity, so `expectedLeverageBps` is null there. `Number(null)` is
  // 0, so a naive read renders a confident "0.00x" and tsc cannot see it — hence a test.
  render(
    <PositionPreview
      preview={{ ...PREVIEW, expectedLeverageBps: null }} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      existingCollateralUsd={0n} existingDebtUsd={0n} existingLiquidationThreshold={0}
    />,
  )
  expect(screen.getByText('—')).toBeTruthy()
  // Both halves matter: asserting only the em-dash would still pass if the row rendered both.
  expect(screen.queryByText(/0\.00x/)).toBeNull()
})

it('solves the liquidation price against the whole account, matching the health factor beside it', () => {
  // Worked case: $10,000 already supplied at a 50% account threshold, $6,000 already owed. The
  // new leg is 2 WETH at $2,500 (80% LT) against 2,000 USDC.
  //
  // Account-wide: uncovered = ($2,000 + $6,000) - ($10,000 x 0.5) = $3,000, over 2 x 0.8 of
  // WETH weight => $1,875. Solving the position's deltas ALONE gives $2,000 / 1.6 = $1,250 —
  // a liquidation price sitting next to a health factor computed on a different position
  // entirely, which is how the card came to tell a safe user they were already liquidatable.
  render(
    <PositionPreview
      preview={{ ...PREVIEW, expectedCollateral: 2_000_000_000_000_000_000n, expectedDebt: 2_000_000_000n }}
      collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      existingCollateralUsd={1_000_000_000_000n} existingDebtUsd={600_000_000_000n}
      existingLiquidationThreshold={0.5}
    />,
  )
  expect(screen.getByText('$1875.00')).toBeTruthy()
  expect(screen.queryByText('$1250.00')).toBeNull()
  // The existing account carries the maths but has no price of its own to quote, so its
  // aggregate row must never reach the card — in modal mode every row is labelled identically
  // ("Liquidation price"), so a second one is indistinguishable from the real answer.
  expect(screen.queryByText('$0.80')).toBeNull()
})

it('renders nothing when there is no preview yet', () => {
  const { container } = render(
    <PositionPreview
      preview={null} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      existingCollateralUsd={0n} existingDebtUsd={0n} existingLiquidationThreshold={0}
    />,
  )
  expect(container.firstChild).toBeNull()
})
