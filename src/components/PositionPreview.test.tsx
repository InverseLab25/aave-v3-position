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
} as const

it('shows the resulting position, not the inputs', () => {
  render(
    <PositionPreview
      preview={PREVIEW} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
    />,
  )
  expect(screen.getByText(/2\.005/)).toBeTruthy()      // collateral
  expect(screen.getByText(/2,512\.56/)).toBeTruthy()   // debt
  expect(screen.getByText(/1\.60/)).toBeTruthy()       // health factor
  expect(screen.getByText(/2\.00x/)).toBeTruthy()      // realized leverage
  expect(screen.getByText(/KyberSwap/)).toBeTruthy()
})

it('renders nothing when there is no preview yet', () => {
  const { container } = render(
    <PositionPreview
      preview={null} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
    />,
  )
  expect(container.firstChild).toBeNull()
})
