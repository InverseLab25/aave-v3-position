import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { parseUnits } from 'viem'

/**
 * `buildPlan` is where every close is validated before a signature is ever requested, and it was
 * the largest untested surface in the app. These drive it through `preview()`, which is the same
 * function `close()` runs — so a gate proven here is a gate `close()` inherits.
 *
 * Everything below the hook is mocked: wagmi, the memoised Aave statics, the adapter registry
 * and `sizeSwap`. That keeps these about the hook's own decisions rather than about routing
 * math, which `sizing.test.ts` and `closePlan.test.ts` already cover.
 */
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useChainId: vi.fn(),
  usePublicClient: vi.fn(),
  useWalletClient: vi.fn(),
  useConfig: vi.fn(),
  getChainConfig: vi.fn(),
  getDeleveragerAddress: vi.fn(),
  getPoolDataProvider: vi.fn(),
  getReserveTokens: vi.fn(),
  getATokenName: vi.fn(),
  getAdaptersForChain: vi.fn(),
  sizeSwap: vi.fn(),
  oracleSeed: vi.fn(),
  readContract: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useChainId: mocks.useChainId,
  usePublicClient: mocks.usePublicClient,
  useWalletClient: mocks.useWalletClient,
  useConfig: mocks.useConfig,
}))
vi.mock('wagmi/actions', () => ({
  estimateFeesPerGas: vi.fn(),
  simulateContract: vi.fn(),
}))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChainConfig: mocks.getChainConfig,
  getDeleveragerAddress: mocks.getDeleveragerAddress,
}))
vi.mock('../lib/aaveStatics', () => ({
  getPoolDataProvider: mocks.getPoolDataProvider,
  getReserveTokens: mocks.getReserveTokens,
  getATokenName: mocks.getATokenName,
}))
vi.mock('../adapters', () => ({ getAdaptersForChain: mocks.getAdaptersForChain }))
vi.mock('../adapters/http', () => ({ clearQuoteCache: vi.fn(), fetchQuoteJson: vi.fn() }))
vi.mock('../lib/sizing', () => ({ sizeSwap: mocks.sizeSwap, oracleSeed: mocks.oracleSeed }))

import { useDeleverageClose } from './useDeleverageClose'

const USER = '0x1111111111111111111111111111111111111111' as const
const DELEVERAGER = '0x2222222222222222222222222222222222222222' as const
const ATOKEN = '0x3333333333333333333333333333333333333333' as const
const VDEBT = '0x4444444444444444444444444444444444444444' as const
const ROUTER = '0x5555555555555555555555555555555555555555' as const

const WETH = {
  underlyingAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  symbol: 'WETH',
  decimals: 18,
  priceInUsd: '3000',
} as const
const USDC = {
  underlyingAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  decimals: 6,
  priceInUsd: '1',
} as const

/** 10 WETH supplied against 20,000 USDC of debt — comfortably covered. */
const COLL_AMOUNT = parseUnits('10', 18)
const DEBT = parseUnits('20000', 6)

/** What `sizeSwap` hands back once it has converged. Swapping 7 WETH clears the debt. */
const SIZED = {
  requiredIn: parseUnits('7', 18),
  expectedOut: parseUnits('21000', 6),
  minDebtOut: parseUnits('20900', 6),
  covered: true,
  guaranteed: true,
  best: {
    aggregator: 'KyberSwap',
    amountIn: parseUnits('7', 18).toString(),
    amountOut: parseUnits('21000', 6).toString(),
    rawAmountInUsd: '21000',
    rawAmountOutUsd: '20990',
    gasEstimate: '450000',
  },
  ranked: [],
}

/** Reads are keyed by function, and the two `balanceOf` calls by which token they hit. */
const defaultReads = ({
  paused = 0n,
  routers = [ROUTER] as readonly string[],
  debt = DEBT,
  collAmount = COLL_AMOUNT,
} = {}) =>
  vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
    switch (functionName) {
      case 'paused':
        return paused
      case 'getAllowedRouters':
        return routers
      case 'nonces':
        return 7n
      case 'balanceOf':
        return address === ATOKEN ? collAmount : debt
      default:
        throw new Error(`unmocked read: ${functionName}`)
    }
  })

const baseInput = { collateral: WETH, debtAsset: USDC, slippagePercent: 0.5 }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: USER })
  mocks.useChainId.mockReturnValue(1)
  mocks.useWalletClient.mockReturnValue({ data: { signTypedData: vi.fn() } })
  mocks.useConfig.mockReturnValue({})
  mocks.usePublicClient.mockReturnValue({ readContract: defaultReads() })
  mocks.getDeleveragerAddress.mockReturnValue(DELEVERAGER)
  mocks.getChainConfig.mockReturnValue({
    name: 'Ethereum',
    aave: { poolAddressesProvider: '0x6666666666666666666666666666666666666666' },
    adapters: ['KyberSwap'],
  })
  mocks.getPoolDataProvider.mockResolvedValue('0x7777777777777777777777777777777777777777')
  mocks.getReserveTokens.mockResolvedValue({ aToken: ATOKEN, vDebt: VDEBT })
  mocks.getATokenName.mockResolvedValue('Aave Ethereum WETH')
  mocks.getAdaptersForChain.mockReturnValue([{ name: 'KyberSwap', getQuote: vi.fn() }])
  mocks.oracleSeed.mockReturnValue(parseUnits('7', 18))
  mocks.sizeSwap.mockResolvedValue(SIZED)
})

const previewWith = async (overrides: Record<string, unknown> = {}) => {
  const { result } = renderHook(() => useDeleverageClose())
  return result.current.preview({ ...baseInput, ...overrides })
}

describe('buildPlan — validation before any signature is requested', () => {
  it('produces a preview describing the swap on the happy path', async () => {
    const { preview, error } = await previewWith()

    expect(error).toBeNull()
    expect(preview?.covered).toBe(true)
    expect(preview?.guaranteed).toBe(true)
    expect(preview?.aggregator).toBe('KyberSwap')
    // 10 supplied, 7 swapped — the remaining 3 are never withdrawn.
    expect(preview?.collateralSwapped).toBe('7')
    expect(preview?.collateralKeptSupplied).toBe('3')
    // Surplus beyond the debt is what the contract forwards to the wallet.
    expect(preview?.debtReturned).toBe('1000')
  })

  it('rejects a NaN slippage instead of dying in BigInt()', async () => {
    // Math.round(NaN) is NaN, and NaN fails BOTH the < 0 and >= 10000 comparisons, so before
    // the isFinite guard this sailed through and threw a RangeError from BigInt(10000 - NaN)
    // — surfacing as an opaque failure rather than this message.
    const { error } = await previewWith({ slippagePercent: Number.NaN })

    expect(error?.kind).toBe('pair')
    expect(error?.message).toContain('Slippage must be between 0% and 100%')
  })

  it.each([[-1], [100], [150]])('rejects out-of-range slippage: %s%%', async (slippagePercent) => {
    const { error } = await previewWith({ slippagePercent })
    expect(error?.message).toContain('Slippage must be between 0% and 100%')
  })

  it('rejects an explicit collateralIn above the supplied balance', async () => {
    // planWithdrawal caps the PULL at the balance but not the swap size, so this used to size a
    // swap larger than the withdrawal funding it and surface as a negative "kept supplied".
    const { error } = await previewWith({ collateralIn: parseUnits('11', 18) })

    expect(error?.kind).toBe('pair')
    expect(error?.message).toContain('10 WETH supplied')
  })

  it('accepts an explicit collateralIn exactly at the balance', async () => {
    // The boundary is inclusive — asking for everything you have is a drain, not a typo.
    const { error } = await previewWith({ collateralIn: COLL_AMOUNT })
    expect(error).toBeNull()
  })

  it("accepts the 'all' sentinel, which resolves on-chain rather than through this check", async () => {
    const { error } = await previewWith({ collateralIn: 'all' })
    expect(error).toBeNull()
    expect(mocks.sizeSwap).toHaveBeenCalledWith(expect.objectContaining({ fixedIn: COLL_AMOUNT }))
  })

  it('refuses when the deleverager is paused', async () => {
    mocks.usePublicClient.mockReturnValue({ readContract: defaultReads({ paused: 1n }) })
    const { error } = await previewWith()

    expect(error?.kind).toBe('deployment')
    expect(error?.message).toContain('paused')
  })

  it('refuses when no router is allowlisted', async () => {
    // An empty allowlist cannot produce an executable route, so failing here beats discovering
    // it after the user has signed.
    mocks.usePublicClient.mockReturnValue({ readContract: defaultReads({ routers: [] }) })
    const { error } = await previewWith()

    expect(error?.kind).toBe('deployment')
    expect(error?.message).toContain('No swap routers are allowlisted')
  })

  it('refuses when there is no debt to close', async () => {
    mocks.usePublicClient.mockReturnValue({ readContract: defaultReads({ debt: 0n }) })
    const { error } = await previewWith()
    expect(error?.message).toContain('No debt to close')
  })

  it('refuses when there is no collateral to withdraw', async () => {
    mocks.usePublicClient.mockReturnValue({ readContract: defaultReads({ collAmount: 0n }) })
    const { error } = await previewWith()
    expect(error?.message).toContain('No collateral to withdraw')
  })

  it('refuses a native-ETH sentinel, which is not an Aave reserve', async () => {
    const { error } = await previewWith({
      collateral: { ...WETH, underlyingAsset: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' },
    })

    expect(error?.kind).toBe('pair')
    expect(error?.message).toContain('Native ETH is not an Aave reserve')
  })

  it('refuses on a chain with no deleverager deployed', async () => {
    mocks.getDeleveragerAddress.mockReturnValue(undefined)
    const { error } = await previewWith()

    expect(error?.kind).toBe('deployment')
    expect(error?.message).toContain('not available on this network')
  })

  it('refuses without a connected wallet', async () => {
    mocks.useConnection.mockReturnValue({ address: undefined })
    const { error } = await previewWith()

    expect(error?.kind).toBe('wallet')
  })

  it('sizes against the debt PLUS an accrual buffer, not the bare debt', async () => {
    // Interest accrues between the quote and inclusion; sizing to the bare debt would land the
    // swap short of it. The buffer is 0.5%.
    await previewWith()

    expect(mocks.sizeSwap).toHaveBeenCalledWith(
      expect.objectContaining({ debt: DEBT, needed: (DEBT * 10050n) / 10000n }),
    )
  })

  it('passes the slippage complement through as slipNum', async () => {
    await previewWith({ slippagePercent: 1 })
    expect(mocks.sizeSwap).toHaveBeenCalledWith(expect.objectContaining({ slipNum: 9900n }))
  })
})
