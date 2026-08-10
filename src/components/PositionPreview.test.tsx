import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PositionPreview } from './PositionPreview'
import type { CollateralInput } from '../utils/liquidation'

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

/** No existing account folded in — what the DERIVED path passes, since `sizeOpen` is position-only. */
const POSITION_ONLY: { existingCollateral: CollateralInput[]; existingDebtUsd: bigint } = {
  existingCollateral: [], existingDebtUsd: 0n,
}

/**
 * The card's two risk lines have to describe ONE position. With a single collateral asset that
 * is checkable in closed form: the health factor is `amount x price x threshold / debt` and the
 * liquidation price solves that same expression to 1, so their product is the current price —
 * whatever basis they are on, as long as it is the SAME basis. Fold the existing account into
 * one line and not the other and this breaks, which is exactly the defect it pins.
 *
 * Tolerance is relative because the rendered health factor is rounded to 2dp.
 */
function expectOneBasis(currentPriceUsd: number) {
  const hf = Number(screen.getByText('Health factor').nextElementSibling?.textContent)
  const liq = Number(
    screen.getByText(/^Liquidation price/).nextElementSibling?.textContent?.replace('$', ''),
  )
  expect(liq).toBeGreaterThan(0)
  expect(Math.abs(hf * liq - currentPriceUsd) / currentPriceUsd).toBeLessThan(0.005)
}

it('shows the resulting position, not the inputs', () => {
  render(
    <PositionPreview
      preview={PREVIEW} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      {...POSITION_ONLY}
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
      {...POSITION_ONLY}
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
      {...POSITION_ONLY}
    />,
  )
  expect(screen.getByText('—')).toBeTruthy()
  // Both halves matter: asserting only the em-dash would still pass if the row rendered both.
  expect(screen.queryByText(/0\.00x/)).toBeNull()
})

it('keeps the health factor and the liquidation price on one basis when nothing is folded in', () => {
  // The derived path: `sizeOpen`'s health factor knows nothing of the user's other collateral,
  // so the liquidation price beside it must not either.
  render(
    <PositionPreview
      preview={PREVIEW} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      {...POSITION_ONLY}
    />,
  )
  expectOneBasis(2500)
})

it('merges the new leg into the existing holding of the same asset, and stays on one basis', () => {
  // Worked case: 4 WETH already supplied at $2,500 (80% LT) and $6,000 already owed. The new leg
  // is 2 WETH against 2,000 USDC, so the account becomes 6 WETH against $8,000.
  //
  // Health factor: 6 x 2,500 x 0.8 / 8,000 = 1.50 — what `manualOpen`'s projection produces.
  // Liquidation price: $8,000 / (6 x 0.8) = $1,666.67.
  //
  // Hold the 4 existing WETH at today's price in a separate row and the new leg alone has to
  // cover $8,000 against $8,000 of existing weight — nothing left to solve, and the card claims
  // no liquidation price at all. That understates the risk for EVERY position with HF > 1.
  render(
    <PositionPreview
      preview={{ ...PREVIEW, expectedCollateral: 2_000_000_000_000_000_000n, expectedDebt: 2_000_000_000n, expectedHealthFactorBps: 15_000n }}
      collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      existingCollateral={[{ symbol: 'WETH', amount: 4, priceUsd: 2500, liquidationThreshold: 0.8 }]}
      existingDebtUsd={600_000_000_000n}
    />,
  )
  expect(screen.getByText('$1666.67')).toBeTruthy()
  expectOneBasis(2500)
  // The two failure modes this replaces: an unliquidatable claim, and the price you get when the
  // existing WETH is held fixed while only the new leg falls.
  expect(screen.queryByText('None')).toBeNull()
  expect(screen.queryByText('$1250.00')).toBeNull()
})

it('prices each existing collateral asset on its own terms, not as one blended aggregate', () => {
  // 5,000 USDC already supplied at an 85% LT with $3,000 owed, plus a new 2 WETH / 2,000 USDC leg.
  // Weighted collateral is $4,250 + $4,000 = $8,250 against $5,000 of debt, so HF = 1.65.
  //
  //   WETH: ($5,000 - $4,250) / (2 x 0.8)    = $468.75
  //   USDC: ($5,000 - $4,000) / (5,000 x 0.85) = $0.24
  //
  // An aggregate row at a blended threshold cannot produce either figure: USDC would carry no
  // price of its own, and WETH would be solved against a stablecoin held at $1 by construction.
  render(
    <PositionPreview
      preview={{ ...PREVIEW, expectedCollateral: 2_000_000_000_000_000_000n, expectedDebt: 2_000_000_000n, expectedHealthFactorBps: 16_500n }}
      collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      existingCollateral={[{ symbol: 'USDC', amount: 5000, priceUsd: 1, liquidationThreshold: 0.85 }]}
      existingDebtUsd={300_000_000_000n}
    />,
  )
  expect(screen.getByText('$468.75')).toBeTruthy()
  expect(screen.getByText('$0.24')).toBeTruthy()
  // Two rows carrying the same label are indistinguishable, so each must name its asset.
  expect(screen.getByText('Liquidation price (WETH)')).toBeTruthy()
  expect(screen.getByText('Liquidation price (USDC)')).toBeTruthy()
})

it('says nothing at all when no asset can be blamed for a liquidation', () => {
  // $10,000 of USDC already supplied at an 85% LT against a 2 WETH / 2,000 USDC leg and no
  // existing debt: every asset's weighted collateral already covers the whole debt on its own,
  // so neither has a liquidation price. HF = ($8,500 + $4,000) / $2,000 = 6.25.
  //
  // The row is labelled by the position, not by the asset, so printing "None" against it reads
  // as "this position cannot be liquidated" — a claim about the whole position, and one the
  // absent rows do not support.
  render(
    <PositionPreview
      preview={{ ...PREVIEW, expectedCollateral: 2_000_000_000_000_000_000n, expectedDebt: 2_000_000_000n, expectedHealthFactorBps: 62_500n }}
      collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      existingCollateral={[{ symbol: 'USDC', amount: 10_000, priceUsd: 1, liquidationThreshold: 0.85 }]}
      existingDebtUsd={0n}
    />,
  )
  expect(screen.queryByText('None')).toBeNull()
  expect(screen.queryByText(/Liquidation price/)).toBeNull()
  // The rest of the card still renders — this is one absent row, not a broken preview.
  expect(screen.getByText('6.25')).toBeTruthy()
})

it('renders nothing when there is no preview yet', () => {
  const { container } = render(
    <PositionPreview
      preview={null} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
      {...POSITION_ONLY}
    />,
  )
  expect(container.firstChild).toBeNull()
})
