import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AvailableReserve } from '../hooks/useAavePositions'
import { appendHistory } from '../lib/txHistory'

const OWNER = '0x000000000000000000000000000000000000dEaD' as `0x${string}`

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
  // useHistorySync reaches for both. `getClient` throwing is the honest answer for a test with no
  // transport, and the hook is built to treat an unreachable chain as one it cannot sync.
  useConfig: vi.fn(() => ({
    chains: [],
    getClient: () => {
      throw new Error('no transport in tests')
    },
  })),
  useReadContracts: vi.fn(() => ({ data: undefined })),
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
  useConfig: mocks.useConfig,
  useReadContracts: mocks.useReadContracts,
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

it('lists recent activity under the borrowed assets', () => {
  // Account-level, not flow-level: a close is recorded by the close modal and an open by the
  // leverage panel, and someone looking for either goes to their position, not to a form.
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
    configurable: true,
  })
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useAavePositions.mockReturnValue({
    ...EMPTY_PORTFOLIO,
    collateralUsd: 1_234.5,
    debtUsd: 500,
    isUnsupportedChain: false,
    chainName: 'Ethereum',
  })
  appendHistory(localStorage, {
    hash: `0x${'11'.repeat(32)}`,
    chainId: 1,
    wallet: OWNER,
    kind: 'close',
    at: 1_800_000_000_000,
    swap: null,
    rate: null,
    fill: null,
    deltas: [],
    source: 'live',
    blockNumber: null,
  })

  render(<AavePosition />)

  // Where it sits is the requirement: under the position, not inside the form that wrote it.
  const borrowed = screen.getByText('Borrowed Assets')
  const activity = screen.getByText(/Recent activity \(1\)/)
  expect(borrowed.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

/** A memory-backed localStorage, seeded with `entries` of history and `overrides`. */
function installStorage(seed: { overrides?: Record<string, number> } = {}) {
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
    configurable: true,
  })
  if (seed.overrides) {
    map.set('aave.avgPriceOverrides.v1', JSON.stringify(seed.overrides))
  }
}

/** A WETH supply whose cost basis the Aave indexer could not price. */
const UNPRICED_WETH_SUPPLY = {
  symbol: 'WETH',
  underlyingAsset: WETH.underlyingAsset,
  decimals: 18,
  // The raw amount is exact; this is what a double can actually hold of it.
  amount: 36.11233521585821,
  amountRaw: 36_112_335_215_858_211_266n,
  valueUsd: 108_337,
  priceInUsd: '3000',
  apy: 2,
  aTokenAddress: WETH.aTokenAddress,
  usageAsCollateralEnabledOnUser: true,
  liquidationThreshold: 0.83,
  interestEarnedTokens: 0,
  interestEarnedUsd: 0,
  positionPnl: { avgEntryPriceUsd: 0, realizedPnlUsd: 0, interestUsd: 0, totalPnlUsd: 0 },
}

/** The Arbitrum fill: 67,754.40695 stable for 36.112335215858211266 WETH — $1,876.21 a unit. */
const LEVERAGED_OPEN = {
  hash: `0x${'33'.repeat(32)}` as `0x${string}`,
  chainId: 1,
  wallet: OWNER,
  kind: 'open' as const,
  at: 1_800_000_000_000,
  swap: {
    srcToken: USDC.underlyingAsset,
    dstToken: WETH.underlyingAsset,
    srcSymbol: 'USDC',
    srcDecimals: 6,
    dstSymbol: 'WETH',
    dstDecimals: 18,
    spentAmount: 67_754_406_950n,
    returnAmount: 36_112_335_215_858_211_266n,
  },
  rate: null,
  fill: null,
  deltas: [],
  source: 'chain' as const,
  blockNumber: 100n,
}

const withSupply = () => ({
  ...EMPTY_PORTFOLIO,
  collateralUsd: 108_337,
  debtUsd: 500,
  suppliedAssets: [UNPRICED_WETH_SUPPLY],
  isUnsupportedChain: false,
  chainName: 'Ethereum',
})

it('prices a supply from its own fills when the indexer could not', () => {
  // The whole point: a leveraged open BOUGHT its collateral through a router, and what it paid
  // is in the receipt. Asking the user to type that in was asking them to read an explorer.
  installStorage()
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useAavePositions.mockReturnValue(withSupply())
  appendHistory(localStorage, LEVERAGED_OPEN)

  render(<AavePosition />)

  expect(screen.getByText('Avg: $1876.21')).toBeTruthy()
})

it('keeps a hand-typed avg ahead of the one derived from history', () => {
  // Deriving must never silently discard something the user set on purpose.
  installStorage({ overrides: { [`supply:${WETH.underlyingAsset.toLowerCase()}`]: 2500 } })
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useAavePositions.mockReturnValue(withSupply())
  appendHistory(localStorage, LEVERAGED_OPEN)

  render(<AavePosition />)

  expect(screen.getByText('Avg: $2500.00')).toBeTruthy()
})

/** Same supply, but with an indexer price that is distinguishable from the fill-derived one. */
const withIndexerPrice = () => ({
  ...withSupply(),
  suppliedAssets: [
    {
      ...UNPRICED_WETH_SUPPLY,
      positionPnl: { avgEntryPriceUsd: 1873.66, realizedPnlUsd: 0, interestUsd: 0, totalPnlUsd: 0 },
    },
  ],
})

it('resets a hand-typed avg back to what the swaps paid, not to the indexer', () => {
  // Three candidate numbers exist at once: 2,500 typed by hand, 1,876.21 from the fills and
  // 1,873.66 from the indexer. Reset has to land on the fills — that is the honest one.
  installStorage({ overrides: { [`supply:${WETH.underlyingAsset.toLowerCase()}`]: 2500 } })
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useAavePositions.mockReturnValue(withIndexerPrice())
  appendHistory(localStorage, LEVERAGED_OPEN)

  render(<AavePosition />)
  fireEvent.click(screen.getByText('Avg: $2500.00'))
  fireEvent.click(screen.getByText(/^Reset to/))

  expect(screen.getByText('Avg: $1876.21')).toBeTruthy()
})

it('hints the fill-derived price in the editor input, not the indexer one', () => {
  // The placeholder is what the box offers you if you type nothing, so it has to agree with what
  // Reset would give you. Showing the indexer's figure there contradicts both.
  installStorage()
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useAavePositions.mockReturnValue(withIndexerPrice())
  appendHistory(localStorage, LEVERAGED_OPEN)

  render(<AavePosition />)
  fireEvent.click(screen.getByText('Avg: $1876.21'))

  const input = screen.getByPlaceholderText('1876.2123')
  expect(input).toBeTruthy()
})

it("never prices someone else's position from this browser's fills", () => {
  // The history in this browser belongs to the connected wallet. Viewing another address and
  // pricing THEIR collateral at what I paid would be a confidently wrong number, which is worse
  // than the dash the indexer leaves.
  installStorage()
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useAavePositions.mockReturnValue(withSupply())
  appendHistory(localStorage, LEVERAGED_OPEN)

  render(<AavePosition viewAddress="0x0000000000000000000000000000000000009999" />)

  expect(screen.queryByText('Avg: $1876.21')).toBeNull()
})

it('shows the fill-derived price beside the indexer one in the editor', () => {
  // Two sources that can disagree, so the editor has to name which is which rather than show
  // one figure under a label that could mean either.
  installStorage()
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useAavePositions.mockReturnValue(withSupply())
  appendHistory(localStorage, LEVERAGED_OPEN)

  render(<AavePosition />)
  fireEvent.click(screen.getByText('Avg: $1876.21'))

  expect(screen.getByText('Paid on your swaps')).toBeTruthy()
  // In the token that paid for it, not converted to dollars — that is the fill itself.
  expect(screen.getByText('1876.2123 USDC')).toBeTruthy()
})

/** A short: WETH borrowed and sold for USDC collateral, 2 WETH for 3,800 USDC. */
const SHORT_OPEN = {
  ...LEVERAGED_OPEN,
  hash: `0x${'44'.repeat(32)}` as `0x${string}`,
  swap: {
    srcToken: WETH.underlyingAsset,
    dstToken: USDC.underlyingAsset,
    srcSymbol: 'WETH',
    srcDecimals: 18,
    dstSymbol: 'USDC',
    dstDecimals: 6,
    spentAmount: 2n * 10n ** 18n,
    returnAmount: 3_800_000_000n,
  },
}

const WETH_DEBT = {
  symbol: 'WETH',
  underlyingAsset: WETH.underlyingAsset,
  decimals: 18,
  amount: 2,
  amountRaw: 2n * 10n ** 18n,
  valueUsd: 6000,
  priceInUsd: '3000',
  apy: 3,
  variableDebtTokenAddress: WETH.variableDebtTokenAddress,
  interestPaidTokens: 0,
  interestPaidUsd: 0,
  positionPnl: { avgEntryPriceUsd: 0, realizedPnlUsd: 0, interestUsd: 0, totalPnlUsd: 0 },
}

it('prices a short from the debt it sold, not the collateral it bought', () => {
  // The borrow row is where a short's entry price lives. Reading the collateral leg would answer
  // "WETH per USDC", which tells a shorter nothing about where they got in.
  installStorage()
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useAavePositions.mockReturnValue({
    ...EMPTY_PORTFOLIO,
    collateralUsd: 3800,
    debtUsd: 6000,
    borrowedAssets: [WETH_DEBT],
    isUnsupportedChain: false,
    chainName: 'Ethereum',
  })
  appendHistory(localStorage, SHORT_OPEN)

  render(<AavePosition />)
  fireEvent.click(screen.getByText('Avg: $1900.00'))

  expect(screen.getByText('Sold on your swaps')).toBeTruthy()
  expect(screen.getByText('1900.0000 USDC')).toBeTruthy()
})

it('still lists recent activity for an account that has closed everything', () => {
  // The person most likely to look is the one who just closed their last position — and that
  // lands on the empty state, which is a different tree entirely.
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
    configurable: true,
  })
  mocks.useConnection.mockReturnValue({ address: OWNER })
  mocks.useAavePositions.mockReturnValue(EMPTY_PORTFOLIO)
  appendHistory(localStorage, {
    hash: `0x${'22'.repeat(32)}`,
    chainId: 1,
    wallet: OWNER,
    kind: 'close',
    at: 1_800_000_000_000,
    swap: null,
    rate: null,
    fill: null,
    deltas: [],
    source: 'live',
    blockNumber: null,
  })

  render(<AavePosition />)

  expect(screen.getByText(/Recent activity \(1\)/)).toBeTruthy()
})
