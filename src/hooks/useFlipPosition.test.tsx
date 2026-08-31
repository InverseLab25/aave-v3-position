import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

/**
 * These drive `preview()`, which is the same function `flip()` runs — a gate proven here is a
 * gate `flip()` inherits.
 *
 * Everything below the hook is mocked: wagmi, the Aave statics, the adapter registry and route
 * building. `sizeFlip` and `planFlip` stay REAL, because the two-round sizing and the args
 * layout are what these are about, and `flip.test.ts` already pins their arithmetic.
 */
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useChainId: vi.fn(),
  usePublicClient: vi.fn(),
  useWalletClient: vi.fn(),
  useConfig: vi.fn(),
  getChainConfig: vi.fn(),
  getFlipperAddress: vi.fn(),
  getPoolDataProvider: vi.fn(),
  getPriceOracle: vi.fn(),
  getReserveTokens: vi.fn(),
  getATokenName: vi.fn(),
  getAdaptersForChain: vi.fn(),
  selectRoute: vi.fn(),
  readContract: vi.fn(),
  estimateContractGas: vi.fn(async () => 1_200_000n),
  estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 100_000n })),
  writeContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  signTypedData: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useChainId: mocks.useChainId,
  usePublicClient: mocks.usePublicClient,
  useWalletClient: mocks.useWalletClient,
  useConfig: mocks.useConfig,
}))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChainConfig: mocks.getChainConfig,
  getFlipperAddress: mocks.getFlipperAddress,
}))
vi.mock('../lib/aaveStatics', () => ({
  getPoolDataProvider: mocks.getPoolDataProvider,
  getPriceOracle: mocks.getPriceOracle,
  getReserveTokens: mocks.getReserveTokens,
  getATokenName: mocks.getATokenName,
}))
vi.mock('../adapters', () => ({ getAdaptersForChain: mocks.getAdaptersForChain }))
// Partial, deliberately: only `selectRoute` reaches the network. canReuseSignature and
// reuseBlocker stay real — those ARE the decisions under test.
vi.mock('../lib/closePlan', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  selectRoute: mocks.selectRoute,
}))

import { useFlipPosition } from './useFlipPosition'

const USER = '0x1111111111111111111111111111111111111111' as const
const FLIPPER = '0x2222222222222222222222222222222222222222' as const
const WETH = '0x3333333333333333333333333333333333333333' as const
const USDC = '0x4444444444444444444444444444444444444444' as const
const AWETH = '0x5555555555555555555555555555555555555555' as const
const AUSDC = '0x6666666666666666666666666666666666666666' as const
const VDEBT_WETH = '0x7777777777777777777777777777777777777777' as const
const VDEBT_USDC = '0x8888888888888888888888888888888888888888' as const
const ROUTER = '0x9999999999999999999999999999999999999999' as const
const ORACLE = '0xaaaa111111111111111111111111111111111111' as const

/** 400 WETH of collateral against 533,333 USDC of debt — the 3x long from the design notes. */
const COLLATERAL = 400n * 10n ** 18n
const DEBT = 533_333_333_333n

const WETH_ASSET = { underlyingAsset: WETH, symbol: 'WETH', decimals: 18 }
const USDC_ASSET = { underlyingAsset: USDC, symbol: 'USDC', decimals: 6 }

const INPUT = {
  fromAsset: WETH_ASSET,
  toAsset: USDC_ASSET,
  leverageBps: 20_000n,
  slippagePercent: 0.5,
}

/** 1994 USDC per WETH, against a $2000 oracle — a 0.3% spread. */
const QUOTED_RATE = 1_994_000_000n

/** What the chain says, keyed the way the hook asks for it. Overridable per test. */
function chainState(over: Record<string, unknown> = {}) {
  const state = {
    collateral: COLLATERAL,
    debt: DEBT,
    wethPrice: 200_000_000_000n, // $2000 on Aave's 8dp scale
    usdcPrice: 100_000_000n,
    usdcLtv: 7_700n,
    usdcLt: 8_500n,
    usdcDecimals: 6n,
    wethDecimals: 18n,
    usdcDebtCeiling: 0n,
    usdcUsageAsCollateral: true,
    usdcEnabledOnUser: false,
    usdcAtokenBalance: 0n,
    aWethNonce: 7n,
    vDebtWethNonce: 3n,
    ...over,
  }

  mocks.readContract.mockImplementation((args: { address: string; functionName: string; args?: unknown[] }) => {
    const to = args.address.toLowerCase()
    switch (args.functionName) {
      case 'getPriceOracle':
        return Promise.resolve(ORACLE)
      case 'getAssetPrice':
        return Promise.resolve(
          (args.args?.[0] as string).toLowerCase() === WETH.toLowerCase()
            ? state.wethPrice
            : state.usdcPrice,
        )
      case 'getReserveConfigurationData':
        return Promise.resolve(
          (args.args?.[0] as string).toLowerCase() === WETH.toLowerCase()
            ? [state.wethDecimals, 8_050n, 8_300n, 0n, 0n, true, true, false, true, false]
            : [
                state.usdcDecimals, state.usdcLtv, state.usdcLt, 0n, 0n,
                state.usdcUsageAsCollateral, true, false, true, false,
              ],
        )
      case 'getDebtCeiling':
        return Promise.resolve(state.usdcDebtCeiling)
      case 'getUserReserveData':
        return Promise.resolve(
          (args.args?.[0] as string).toLowerCase() === WETH.toLowerCase()
            ? [state.collateral, 0n, 0n, 0n, 0n, 0n, 0n, 0n, true]
            : [state.usdcAtokenBalance, 0n, state.debt, 0n, 0n, 0n, 0n, 0n, state.usdcEnabledOnUser],
        )
      case 'nonces':
        return Promise.resolve(to === AWETH.toLowerCase() ? state.aWethNonce : state.vDebtWethNonce)
      case 'getAllowedRouters':
        return Promise.resolve([ROUTER])
      case 'name':
        return Promise.resolve('Aave Ethereum WETH')
      case 'paused':
        return Promise.resolve(0n)
      default:
        throw new Error(`unmocked read: ${args.functionName}`)
    }
  })
  return state
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: USER })
  mocks.useChainId.mockReturnValue(1)
  mocks.useWalletClient.mockReturnValue({
    data: { signTypedData: mocks.signTypedData, writeContract: mocks.writeContract },
  })
  mocks.useConfig.mockReturnValue({})
  mocks.usePublicClient.mockReturnValue({
    readContract: mocks.readContract,
    waitForTransactionReceipt: mocks.waitForTransactionReceipt,
    // The flip pins its own gas limit rather than letting the wallet guess, so the fake has to
    // answer this or every send aborts before `writeContract`.
    estimateContractGas: mocks.estimateContractGas,
    estimateFeesPerGas: mocks.estimateFeesPerGas,
  })
  mocks.getChainConfig.mockReturnValue({
    adapters: ['mock'],
    aave: { poolAddressesProvider: '0xbbbb111111111111111111111111111111111111' },
  })
  mocks.getFlipperAddress.mockReturnValue(FLIPPER)
  mocks.getPoolDataProvider.mockResolvedValue('0xcccc111111111111111111111111111111111111')
  // Memoised beside the data provider now, so the read no longer goes through publicClient.
  mocks.getPriceOracle.mockResolvedValue('0xdddd111111111111111111111111111111111111')
  mocks.getReserveTokens.mockImplementation(
    (_c: unknown, _id: unknown, _dp: unknown, asset: string) =>
      Promise.resolve(
        asset.toLowerCase() === WETH.toLowerCase()
          ? { aToken: AWETH, vDebt: VDEBT_WETH }
          : { aToken: AUSDC, vDebt: VDEBT_USDC },
      ),
  )
  mocks.getATokenName.mockResolvedValue('Aave Ethereum WETH')
  // Prices the swap at a constant 1994 USDC/WETH, so the second sizing round sees a real rate
  // for the input it actually asked about.
  mocks.getAdaptersForChain.mockReturnValue([
    {
      name: 'mock',
      supportsExecution: true,
      getQuote: (_f: unknown, _t: unknown, amountIn: string) =>
        Promise.resolve({
          aggregator: 'mock',
          amountIn,
          amountOut: String((BigInt(amountIn) * QUOTED_RATE) / 10n ** 18n),
        }),
      buildTransaction: vi.fn(),
    },
  ])
    // r ++ s ++ v, and v has to be 27 or 28 — viem rejects anything else outright.
  mocks.signTypedData.mockResolvedValue(`0x${'11'.repeat(64)}1b`)
  // Takes whatever the adapters offered — the routing walk itself is closePlan's own test.
  mocks.selectRoute.mockImplementation(({ candidates }: { candidates: { amountOut: string }[] }) =>
    Promise.resolve(
      candidates.length
        ? {
            router: ROUTER,
            swapData: '0xfeed',
            chosen: candidates[0],
            tx: { to: ROUTER, data: '0xfeed' },
            rejected: [],
          }
        : { router: null, swapData: null, chosen: null, tx: null, rejected: ['no quotes'] },
    ),
  )
  chainState()
})

describe('preview', () => {
  it('sizes the flash as the whole collateral plus the new borrow', async () => {
    const { result } = renderHook(() => useFlipPosition())
    let preview!: Awaited<ReturnType<typeof result.current.preview>>
    await act(async () => {
      preview = await result.current.preview(INPUT)
    })
    expect(preview.flashAmount - preview.borrowAmount).toBe(COLLATERAL)
    expect(preview.collateralAmount).toBe(COLLATERAL)
    expect(preview.debtAmount).toBe(DEBT)
  })

  it('re-quotes at the sized input rather than trusting the oracle seed', async () => {
    // The seed only exists to get a first swap size out of prices. The size that reaches the
    // contract has to come from a quote the aggregator actually gave for that input.
    const { result } = renderHook(() => useFlipPosition())
    await act(async () => {
      await result.current.preview(INPUT)
    })
    expect(mocks.selectRoute.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('sends the route it re-quoted after signing, not the one the preview showed', async () => {
    // A maker-settled route's signed orders expire about a minute after the build, and three
    // wallet prompts outlast that. Sizing stays as signed; only the calldata is refreshed.
    mocks.writeContract.mockResolvedValue('0xhash')
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] })
    // Same shape as the default mock — only the calldata differs per round, so the assertion
    // is about WHICH quote reached the contract, not about sizing.
    let nth = 0
    mocks.selectRoute.mockImplementation(({ candidates }: { candidates: { amountOut: string }[] }) =>
      Promise.resolve({
        router: ROUTER,
        swapData: `0xdata${++nth}`,
        chosen: candidates[0],
        tx: { to: ROUTER, data: `0xdata${nth}` },
        rejected: [],
      }),
    )

    const { result } = renderHook(() => useFlipPosition())
    await act(async () => {
      await result.current.flip(INPUT)
    })

    const sent = mocks.writeContract.mock.calls.at(-1)?.[0] as { args: readonly unknown[] }
    expect(sent.args.at(-1)).toBe(`0xdata${nth}`)
    expect(nth).toBeGreaterThan(2)
  })

  it('refuses when the destination reserve would not count as collateral', async () => {
    // Supplying is not collateralising. The contract cannot flip that switch on the user's
    // behalf, so the borrow would revert on chain after the swap had already happened.
    chainState({ usdcUsageAsCollateral: false })
    const { result } = renderHook(() => useFlipPosition())
    await act(async () => {
      await expect(result.current.preview(INPUT)).rejects.toThrow(/collateral/i)
    })
  })

  it('refuses a target above the destination asset LTV wall', async () => {
    // USDC at 77% walls at 4.35x, and sizing stays 2% below. The wall that matters is the one
    // being moved INTO, never the one being left behind.
    const { result } = renderHook(() => useFlipPosition())
    await act(async () => {
      await expect(result.current.preview({ ...INPUT, leverageBps: 45_000n })).rejects.toThrow(
        /LEVERAGE_ABOVE_LTV/,
      )
    })
  })

  it('refuses a position whose sale cannot clear its own debt', async () => {
    chainState({ debt: 795_000_000_000n })
    const { result } = renderHook(() => useFlipPosition())
    await act(async () => {
      await expect(result.current.preview(INPUT)).rejects.toThrow(/UNDERWATER/)
    })
  })

  it('refuses when no allowlisted route can be built', async () => {
    mocks.selectRoute.mockResolvedValue({
      router: null, swapData: null, chosen: null, tx: null, rejected: ['mock: not allowlisted'],
    })
    const { result } = renderHook(() => useFlipPosition())
    await act(async () => {
      await expect(result.current.preview(INPUT)).rejects.toThrow(/route/i)
    })
  })

  it('refuses when the chain has no flipper deployed', async () => {
    mocks.getFlipperAddress.mockReturnValue(null)
    const { result } = renderHook(() => useFlipPosition())
    await act(async () => {
      await expect(result.current.preview(INPUT)).rejects.toThrow(/not deployed|not available/i)
    })
  })
})

describe('flip', () => {
  it('takes all three signatures and sends the planned args', async () => {
    mocks.writeContract.mockResolvedValue('0xhash')
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] })

    const { result } = renderHook(() => useFlipPosition())
    await act(async () => {
      await result.current.flip(INPUT)
    })

    // aToken permit, its revoke, and the credit delegation over the borrow.
    expect(mocks.signTypedData).toHaveBeenCalledTimes(3)
    const call = mocks.writeContract.mock.calls[0][0]
    expect(call.functionName).toBe('flipPositionWithPermit')
    expect(call.address).toBe(FLIPPER)
    expect(call.args[0]).toBe(WETH)
    expect(call.args[1]).toBe(USDC)
  })

  it('signs the revoke one nonce past the grant it clears', async () => {
    mocks.writeContract.mockResolvedValue('0xhash')
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] })

    const { result } = renderHook(() => useFlipPosition())
    await act(async () => {
      await result.current.flip(INPUT)
    })

    // The grant consumes nonce N inside the transaction, so the revoke has to be signed at N+1.
    // Getting this wrong reverts with Aave's InvalidExpiration().
    const [grant, revoke] = mocks.signTypedData.mock.calls
    expect(grant[0].message.nonce).toBe(7n)
    expect(revoke[0].message.nonce).toBe(8n)
    expect(revoke[0].message.value).toBe(0n)
  })

  it('signs the delegation over exactly the borrow amount', async () => {
    // The contract borrows the full signed value. A stale figure either reverts or leaves the
    // contract holding borrowing power it was never meant to keep.
    mocks.writeContract.mockResolvedValue('0xhash')
    mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [] })

    const { result } = renderHook(() => useFlipPosition())
    let preview!: Awaited<ReturnType<typeof result.current.preview>>
    await act(async () => {
      preview = await result.current.preview(INPUT)
      await result.current.flip(INPUT)
    })

    const delegation = mocks.signTypedData.mock.calls[2][0]
    expect(delegation.message.value).toBe(preview.borrowAmount)
    expect(delegation.primaryType).toBe('DelegationWithSig')
  })
})
