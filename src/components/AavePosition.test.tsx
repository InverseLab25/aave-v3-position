import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AvailableReserve } from '../hooks/useAavePositions'

// AavePosition composes a lot of hooks; only useAavePositions, wagmi's useChainId/useConnection/
// useReadContract (LeverageActions calls these directly — the latter for the margin asset's
// wallet balance), config/chains' getStrategiesAddress (which gates LeverageActions), and
// useStrategiesOpen (LeverageActions' sizing/quoting hook) are mocked. Everything else —
// LiquidationPriceBlock, OpenPositionForm, PositionPreview, the lazy modals — renders for real,
// same approach as LeverageActions.test.tsx.
const mocks = vi.hoisted(() => ({
  useAavePositions: vi.fn(),
  getStrategiesAddress: vi.fn(),
  useStrategiesOpen: vi.fn(),
  useChainId: vi.fn(),
  useConnection: vi.fn(),
  useReadContract: vi.fn(),
}))

vi.mock('../hooks/useAavePositions', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAavePositions: mocks.useAavePositions,
}))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStrategiesAddress: mocks.getStrategiesAddress,
}))
vi.mock('../hooks/useStrategiesOpen', () => ({ useStrategiesOpen: mocks.useStrategiesOpen }))
vi.mock('wagmi', () => ({
  useChainId: mocks.useChainId,
  useConnection: mocks.useConnection,
  useReadContract: mocks.useReadContract,
}))

import { AavePosition } from './AavePosition'

// Auto-cleanup between renders comes from vitest.config.ts's `setupFiles` (src/test-setup.ts)
// repo-wide; no local afterEach(cleanup) needed here.

const WETH: AvailableReserve = {
  symbol: 'WETH',
  underlyingAsset: '0x1111111111111111111111111111111111111111',
  decimals: 18,
  priceInUsd: '3000',
  apy: 2,
  borrowApy: 3,
  variableDebtTokenAddress: '0x2222222222222222222222222222222222222222',
  aTokenAddress: '0x3333333333333333333333333333333333333333',
  liquidationThreshold: 0.83,
  raw: { ltvBps: 8000n, liquidationThresholdBps: 8300n, priceUsd: 300_000_000_000n, decimals: 18 },
}

const USDC: AvailableReserve = {
  symbol: 'USDC',
  underlyingAsset: '0x4444444444444444444444444444444444444444',
  decimals: 6,
  priceInUsd: '1',
  apy: 4,
  borrowApy: 5,
  variableDebtTokenAddress: '0x5555555555555555555555555555555555555555',
  aTokenAddress: '0x6666666666666666666666666666666666666666',
  liquidationThreshold: 0.85,
  raw: { ltvBps: 7500n, liquidationThresholdBps: 8500n, priceUsd: 100_000_000n, decimals: 6 },
}

/** A connected wallet with nothing supplied or borrowed yet — the "Start your Aave
 * position" empty state. `availableReserves` is still populated: it lists every market
 * reserve, not just the user's, so it must not be empty here. */
const EMPTY_PORTFOLIO = {
  isConnected: true,
  isViewMode: false,
  viewedAddress: '0x0000000000000000000000000000000000dEaD',
  isLoading: false,
  collateralUsd: 0,
  debtUsd: 0,
  availableBorrowsUsd: 0,
  ltvPercent: 0,
  liquidationThreshold: 0,
  formattedHealthFactor: '0',
  netApy: 0,
  totalInterestEarnedUsd: 0,
  totalInterestPaidUsd: 0,
  suppliedAssets: [],
  borrowedAssets: [],
  availableReserves: [WETH, USDC],
  chainId: 1,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.useConnection.mockReturnValue({ address: undefined })
  mocks.useReadContract.mockReturnValue({ data: undefined })
  mocks.useAavePositions.mockReturnValue(EMPTY_PORTFOLIO)
  mocks.useStrategiesOpen.mockReturnValue({
    preview: null, previewError: null, isQuoting: false,
    refresh: vi.fn(), frozen: { current: false },
    execute: vi.fn(), step: 'idle', txHash: undefined, execError: null, execRemedy: null,
  })
})

it('reaches the actions panel from an empty portfolio — opening a leveraged position needs no pre-existing collateral', async () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')

  render(<AavePosition />)

  // Confirm we are actually on the empty-portfolio branch, not some other render path.
  expect(screen.getByText('Start your Aave position')).toBeTruthy()

  // LeverageActions is lazy-loaded (Suspense), so its content arrives asynchronously.
  expect(await screen.findByText('Long')).toBeTruthy()
  expect(screen.getByText('Short')).toBeTruthy()
})
