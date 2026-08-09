import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

// wagmi and the history hook are the only inputs to the derivation, so both are mocked
// and driven directly. That keeps these tests about memoisation, not about RPC.
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useChainId: vi.fn(),
  useReadContract: vi.fn(),
  useReadContracts: vi.fn(),
  useAaveHistoricalInterest: vi.fn(),
  getChainConfig: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useChainId: mocks.useChainId,
  useReadContract: mocks.useReadContract,
  useReadContracts: mocks.useReadContracts,
}))
vi.mock('./useAaveHistoricalInterest', () => ({
  useAaveHistoricalInterest: mocks.useAaveHistoricalInterest,
}))
vi.mock('../config/chains', () => ({ getChainConfig: mocks.getChainConfig }))

import { useAavePositions } from './useAavePositions'

const USER = '0x1111111111111111111111111111111111111111' as const
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const

const RAY = 10n ** 27n

const reserve = {
  symbol: 'WETH',
  underlyingAsset: WETH,
  decimals: 18n,
  priceInMarketReferenceCurrency: 300000000000n, // $3000, 8dp
  liquidityRate: RAY / 100n,
  variableBorrowRate: RAY / 50n,
  variableDebtTokenAddress: '0x2222222222222222222222222222222222222222',
  aTokenAddress: '0x3333333333333333333333333333333333333333',
  baseLTVasCollateral: 8000n,
  reserveLiquidationThreshold: 8250n,
  liquidityIndex: RAY,
  variableBorrowIndex: RAY,
}

const userReserve = {
  underlyingAsset: WETH,
  scaledATokenBalance: 10n ** 18n,
  scaledVariableDebt: 0n,
  usageAsCollateralEnabledOnUser: true,
}

/** accountData is a 6-tuple of uint256 in Aave's 8-decimal base currency. */
const accountData = [3000_00000000n, 0n, 2000_00000000n, 8250n, 8000n, 2n ** 256n - 1n] as const

function makeUiData(reserves = [reserve], userReserves = [userReserve]) {
  return [
    { result: [reserves, { marketReferenceCurrencyPriceInUsd: 1n }], status: 'success' },
    { result: [userReserves, 0n], status: 'success' },
  ]
}

const freshHistory = () => ({
  netPrincipals: { supply: {}, borrow: {} },
  costBasis: { supply: {}, borrow: {} },
  isLoadingHistory: false,
  errorHistory: null,
})

/**
 * The real useAaveHistoricalInterest memoises its derivation, so it hands back the same
 * netPrincipals/costBasis objects across renders. The default mock mirrors that; the
 * coupling test below deliberately breaks it to show what happens if it ever regresses.
 */
const STABLE_HISTORY = freshHistory()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: USER, isConnected: true })
  mocks.useChainId.mockReturnValue(1)
  mocks.getChainConfig.mockReturnValue({
    name: 'Ethereum',
    aave: {
      poolAddress: '0x4444444444444444444444444444444444444444',
      uiPoolDataProvider: '0x5555555555555555555555555555555555555555',
      poolAddressesProvider: '0x6666666666666666666666666666666666666666',
    },
  })
  mocks.useAaveHistoricalInterest.mockReturnValue(STABLE_HISTORY)
  mocks.useReadContract.mockReturnValue({ data: accountData, isLoading: false })
  mocks.useReadContracts.mockReturnValue({ data: makeUiData(), isLoading: false })
})

describe('useAavePositions memoisation', () => {
  it('returns the same suppliedAssets reference across re-renders with unchanged inputs', () => {
    const { result, rerender } = renderHook(() => useAavePositions())
    const first = result.current.suppliedAssets
    expect(first).toHaveLength(1)

    rerender()
    rerender()

    // Reference equality is the whole point: eight components consume this, and a fresh
    // array on every render invalidates every downstream useMemo keyed on it.
    expect(result.current.suppliedAssets).toBe(first)
  })

  it('keeps borrowedAssets and availableReserves stable too', () => {
    const { result, rerender } = renderHook(() => useAavePositions())
    const borrowed = result.current.borrowedAssets
    const reserves = result.current.availableReserves
    rerender()
    expect(result.current.borrowedAssets).toBe(borrowed)
    expect(result.current.availableReserves).toBe(reserves)
  })

  it('churns if the history hook stops memoising — documents why both layers are needed', () => {
    // The two memos are coupled: useAavePositions depends on netPrincipals/costBasis, so
    // memoising it alone achieves nothing while the upstream hook rebuilds them per render.
    // This pins that relationship, so a regression upstream fails here with a clear reason
    // rather than quietly costing every consumer its memoisation.
    mocks.useAaveHistoricalInterest.mockImplementation(freshHistory)

    const { result, rerender } = renderHook(() => useAavePositions())
    const first = result.current.suppliedAssets
    rerender()

    expect(result.current.suppliedAssets).not.toBe(first)
  })

  it('recomputes when the underlying reads change — memoisation must not go stale', () => {
    const { result, rerender } = renderHook(() => useAavePositions())
    const before = result.current.suppliedAssets
    expect(before[0].amount).toBeCloseTo(1)

    mocks.useReadContracts.mockReturnValue({
      data: makeUiData([reserve], [{ ...userReserve, scaledATokenBalance: 5n * 10n ** 18n }]),
      isLoading: false,
    })
    rerender()

    expect(result.current.suppliedAssets).not.toBe(before)
    expect(result.current.suppliedAssets[0].amount).toBeCloseTo(5)
  })

  it('returns stable empty singletons when there is nothing to show', () => {
    mocks.useReadContract.mockReturnValue({ data: undefined, isLoading: true })
    mocks.useReadContracts.mockReturnValue({ data: undefined, isLoading: true })

    const { result, rerender } = renderHook(() => useAavePositions())
    const empty = result.current.suppliedAssets
    expect(empty).toEqual([])

    rerender()

    // The loading branch used to hand back a fresh [] literal every render, which churned
    // identities just as badly as the loaded branch.
    expect(result.current.suppliedAssets).toBe(empty)
  })
})

describe('useAavePositions raw reserve config', () => {
  it('exposes raw reserve config at native precision for the sizing SDK', () => {
    // Aave returns LTV and liquidation threshold in bps, and price on an 8-decimal USD scale.
    // The display fields divide these down into lossy Numbers; `raw` must not.
    mocks.useReadContracts.mockReturnValue({
      data: makeUiData([
        {
          ...reserve,
          baseLTVasCollateral: 8000n,
          reserveLiquidationThreshold: 8300n,
          priceInMarketReferenceCurrency: 250_000_000_000n,
        },
      ]),
      isLoading: false,
    })

    const { result } = renderHook(() => useAavePositions())

    const weth = result.current.availableReserves.find((r) => r.symbol === 'WETH')
    expect(weth?.raw).toEqual({
      ltvBps: 8000n,
      liquidationThresholdBps: 8300n,
      priceUsd: 250_000_000_000n,
      decimals: 18,
    })
    // the lossy display fields are unchanged
    expect(weth?.liquidationThreshold).toBe(0.83)
    expect(weth?.priceInUsd).toBe('2500')
  })
})
