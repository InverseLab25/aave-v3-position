import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AvailableReserve } from '../hooks/useAavePositions'

// AavePosition composes a lot of hooks; only useAavePositions, wagmi's useChainId/useConnection/
// useReadContract (LeveragePanel calls these directly — the latter for both pair legs' wallet
// balances), config/chains' getStrategiesAddress (which gates LeveragePanel), and
// useLeverageOpen (LeveragePanel's quoting hook) are mocked. Everything else — LiquidationPrice-
// Block, PairPicker, AmountField, PositionSummary, the lazy modals — renders for real.
const mocks = vi.hoisted(() => ({
  useAavePositions: vi.fn(),
  getStrategiesAddress: vi.fn(),
  useLeverageOpen: vi.fn(),
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
vi.mock('../hooks/useLeverageOpen', () => ({ useLeverageOpen: mocks.useLeverageOpen }))
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
  raw: {
    ltvBps: 8000n, liquidationThresholdBps: 8300n, priceUsd: 300_000_000_000n, decimals: 18,
    usageAsCollateralEnabled: true, debtCeiling: 0n,
  },
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
  raw: {
    ltvBps: 7500n, liquidationThresholdBps: 8500n, priceUsd: 100_000_000n, decimals: 6,
    usageAsCollateralEnabled: true, debtCeiling: 0n,
  },
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
  // Must mirror useAavePositions' real return shape: LeveragePanel declares these two as
  // `bigint`, and this mock is untyped, so omitting them silently feeds it `undefined`.
  collateralBase: 0n,
  debtBase: 0n,
  ltvBps: 0n,
  liquidationThresholdBps: 0n,
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
  // Same reason as the bigints above — LeveragePanel indexes this map directly, so omitting it
  // throws rather than degrading. Empty is the honest empty-portfolio value.
  collateralFlags: {},
  hasAnyCollateralEnabled: false,
  eModeExcludedReserves: {},
  hasReadError: false,
  chainId: 1,
}

/**
 * Account totals that are deliberately not round in float terms: routing them through
 * `collateralUsd`/`debtUsd` (JS numbers) and back would not reproduce them exactly, which is
 * what these tests exist to catch.
 *
 * They also have to describe a COHERENT account. The supply ceiling folds in the existing
 * position, so totals paired with a zero LTV read as an account borrowed far past its limit and
 * the panel correctly refuses to size anything at all.
 */
const ODD_TOTALS = {
  collateralBase: 123_456_789_012_345_678n,
  debtBase: 9_876_543_210_987n,
  ltvBps: 8000n,
  liquidationThresholdBps: 8250n,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.useConnection.mockReturnValue({ address: undefined })
  // Per-leg, not one blanket value: the panel picks the default margin asset by comparing the
  // two legs' USD balances, so returning the same figure for both would decide it by accident.
  // WETH-only keeps the default on the collateral leg, which is the long-with-WETH case.
  mocks.useReadContract.mockImplementation((cfg?: { address?: string }) => ({
    data: cfg?.address === WETH.underlyingAsset ? 100n * 10n ** 18n : 0n,
  }))
  mocks.useAavePositions.mockReturnValue(EMPTY_PORTFOLIO)
  mocks.useLeverageOpen.mockReturnValue({
    preview: null, previewError: null, isQuoting: false,
    refresh: vi.fn(),
    execute: vi.fn(), step: 'idle', txHash: undefined, execError: null, execRemedy: null,
  })
})

/**
 * Fill both amounts. The panel gates `input` to null until the sizing is valid on its own — no
 * point spending a quote on a form that cannot open — so a margin alone reaches the hook as
 * null. 20 WETH sits comfortably under the ~35.9 WETH ceiling 10 WETH of margin supports.
 */
async function fillAmounts() {
  fireEvent.change(await screen.findByLabelText('Margin amount'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('Supply to Aave amount'), { target: { value: '20' } })
}

it('reaches the actions panel from an empty portfolio — opening a leveraged position needs no pre-existing collateral', async () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')

  render(<AavePosition />)

  // Confirm we are actually on the empty-portfolio branch, not some other render path.
  expect(screen.getByText('Start your Aave position')).toBeTruthy()

  // LeveragePanel is lazy-loaded (Suspense), so its content arrives asynchronously.
  expect(await screen.findByText('Long')).toBeTruthy()
  expect(screen.getByText('Short')).toBeTruthy()
})

it('hands the account totals to the actions panel as raw 8dp bigints', async () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  mocks.useAavePositions.mockReturnValue({ ...EMPTY_PORTFOLIO, ...ODD_TOTALS })

  render(<AavePosition />)

  await fillAmounts()

  const input = mocks.useLeverageOpen.mock.calls.at(-1)?.[0]
  expect(input?.existingCollateralUsd).toBe(ODD_TOTALS.collateralBase)
  expect(input?.existingDebtUsd).toBe(ODD_TOTALS.debtBase)
})

// `<LeveragePanel>` is mounted TWICE — once in the empty-portfolio branch above, once in the
// populated dashboard. They are separate JSX call sites, so passing the totals at one proves
// nothing about the other; a dropped prop on this one is exactly the kind of thing the first
// test cannot see.
it('hands the account totals to the actions panel on the populated dashboard too', async () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  // A non-zero collateralUsd is what routes past the empty-portfolio branch.
  mocks.useAavePositions.mockReturnValue({
    ...EMPTY_PORTFOLIO,
    ...ODD_TOTALS,
    collateralUsd: 1_234.5,
    debtUsd: 500,
    totalPositionPnlUsd: 0,
    eModeCategoryId: 0,
    isEModeEnabled: false,
    eModeLabel: 'Disabled',
    eModeLtv: 0,
    eModeLiquidationThreshold: 0,
    isUnsupportedChain: false,
    chainName: 'Ethereum',
  })

  render(<AavePosition />)

  await fillAmounts()

  const input = mocks.useLeverageOpen.mock.calls.at(-1)?.[0]
  expect(input?.existingCollateralUsd).toBe(ODD_TOTALS.collateralBase)
  expect(input?.existingDebtUsd).toBe(ODD_TOTALS.debtBase)
})

// The panel deliberately renders on a chain with no deployment — that is how the feature is
// discovered. But `getStrategiesAddress` returning null gates `input` to null, so no quote is
// ever requested, `preview` stays null and Open is disabled forever. Every OTHER disabling
// condition puts a reason on screen; this one used to put nothing there, leaving a form that
// looks ready and a button that silently does nothing.
it('says why Open is dead when the contract is not deployed on this chain', async () => {
  mocks.getStrategiesAddress.mockReturnValue(null)

  render(<AavePosition />)

  expect(await screen.findByText(/not deployed on this network/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: /Open long/i }).hasAttribute('disabled')).toBe(true)
})

// The mirror of the above: with a deployment present, the notice must be gone. Asserting only
// the presence would pass just as well on a banner that is always rendered.
it('shows no undeployed notice once the contract address resolves', async () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')

  render(<AavePosition />)

  expect(await screen.findByText('Long')).toBeTruthy()
  expect(screen.queryByText(/not deployed on this network/i)).toBeNull()
})

it('shows a read failure as a failure, not as an empty portfolio', async () => {
  // A failed read zeroes every total and empties both asset lists, which is indistinguishable
  // from a fresh account. Falling through to "Start your Aave position" would invite someone
  // with real debt to size a leveraged open against an account that only READS as empty —
  // `collateralBase`/`debtBase` feed the supply ceiling.
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  mocks.useAavePositions.mockReturnValue({ ...EMPTY_PORTFOLIO, hasReadError: true })

  render(<AavePosition />)

  expect(screen.getByText('Could not read your Aave position')).toBeTruthy()
  expect(screen.queryByText('Start your Aave position')).toBeNull()
})
