import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { maxUint256, parseUnits } from 'viem'

/**
 * AssetsToBorrowModal is the fourth of the action modals and the only one whose cap comes from
 * the ACCOUNT rather than a token balance: `availableBorrowsUsd` converted into the asset at its
 * own price, with a 1% safety margin. Everything else — the picker, the health-factor gate, the
 * native credit-delegation two-step — mirrors its siblings.
 */
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useWriteContract: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
  useReadContract: vi.fn(),
  useConfig: vi.fn(),
  useAdjustedGas: vi.fn(),
  getChainConfig: vi.fn(),
  simulateAndWrite: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useWriteContract: mocks.useWriteContract,
  useWaitForTransactionReceipt: mocks.useWaitForTransactionReceipt,
  useReadContract: mocks.useReadContract,
  useConfig: mocks.useConfig,
}))
vi.mock('../hooks/useAdjustedGas', () => ({ useAdjustedGas: mocks.useAdjustedGas }))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChainConfig: mocks.getChainConfig,
}))
vi.mock('../utils/contract', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  simulateAndWrite: mocks.simulateAndWrite,
}))

import { AssetsToBorrowModal } from './AssetsToBorrowModal'

const USER = '0x1111111111111111111111111111111111111111' as const
const POOL = '0x8787878787878787878787878787878787878787' as const
const GATEWAY = '0x9999999999999999999999999999999999999999' as const
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const VDEBT = '0x4444444444444444444444444444444444444444' as const

const reserve = (over: Record<string, unknown> = {}) => ({
  symbol: 'WETH',
  underlyingAsset: WETH,
  variableDebtTokenAddress: VDEBT,
  decimals: 18,
  priceInUsd: '3000',
  borrowApy: 4,
  liquidationThreshold: 0.83,
  ...over,
})

const RESERVES = [
  reserve(),
  reserve({ symbol: 'USDC', underlyingAsset: USDC, decimals: 6, priceInUsd: '1', liquidationThreshold: 0.85 }),
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: USER, chainId: 1 })
  mocks.useWriteContract.mockReturnValue({ mutateAsync: vi.fn() })
  mocks.useWaitForTransactionReceipt.mockReturnValue({ isLoading: false })
  mocks.useReadContract.mockReturnValue({ data: 0n, refetch: vi.fn() })
  mocks.useConfig.mockReturnValue({})
  mocks.useAdjustedGas.mockReturnValue({
    maxFee: 30_000_000_000n, maxPriority: 1_000_000_000n, estimatedFeeUsd: 5,
  })
  mocks.getChainConfig.mockReturnValue({
    aave: { poolAddress: POOL, wethGateway: GATEWAY },
    // The borrow list is filtered to these, same as the supply modal.
    defaultTokens: [{ symbol: 'WETH' }, { symbol: 'USDC' }],
    explorerUrl: 'https://etherscan.io',
  })
  mocks.simulateAndWrite.mockResolvedValue('0xhash')
})

/**
 * 30,000 collateral x 0.83 = 24,900 weighted against 20,000 of debt: HF 1.245 to start.
 * 5,000 of borrow headroom, so the USDC cap is 5,000 x 0.99 = 4,950.
 */
const mount = (props: Record<string, unknown> = {}) =>
  render(
    <AssetsToBorrowModal
      chainId={1}
      availableReserves={RESERVES as never}
      availableBorrowsUsd={5_000}
      collateralUsd={30_000}
      debtUsd={20_000}
      liquidationThreshold={0.83}
      suppliedAssets={[] as never}
      onClose={vi.fn()}
      {...props}
    />,
  )

const pick = (symbol: string) => {
  const row = screen.getByText(symbol).closest('tr')!
  fireEvent.click(within(row).getByRole('button', { name: 'Borrow' }))
}
const amountField = () => screen.getByPlaceholderText('0.00') as HTMLInputElement
const type = (v: string) => fireEvent.change(amountField(), { target: { value: v } })
const submit = () =>
  screen.getByRole('button', {
    name: /^(Borrow|Exceeds borrow limit|Health factor too low|Processing…)$/,
  }) as HTMLButtonElement
const lastCall = () => mocks.simulateAndWrite.mock.calls.at(-1)![2]

describe('AssetsToBorrowModal — asset selection', () => {
  it('offers native ETH alongside the ERC-20 reserves', () => {
    mount()
    expect(screen.getByText('ETH')).toBeTruthy()
    expect(screen.getByText('USDC')).toBeTruthy()
  })

  it("offers only the chain's default tokens", () => {
    mount({ availableReserves: [...RESERVES, reserve({ symbol: 'DAI', underlyingAsset: '0xdai' })] as never })
    expect(screen.queryByText('DAI')).toBeNull()
  })

  it('shows the amount form only once an asset is chosen', () => {
    mount()
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()

    pick('USDC')
    expect(amountField()).toBeTruthy()
  })
})

describe('AssetsToBorrowModal — the borrow cap', () => {
  it('caps at the account headroom converted to the asset, less a 1% margin', () => {
    // 5,000 of headroom at $1 = 5,000 USDC, x 0.99 = 4,950. The margin exists because the
    // headroom moves with price between render and inclusion.
    mount()
    pick('USDC')

    expect(screen.getByText(/4950\.0000 USDC/)).toBeTruthy()
  })

  it('prices the cap in the asset, not in dollars', () => {
    // The same 5,000 of headroom is 1.65 WETH at $3,000, not 4,950 of anything.
    mount()
    pick('WETH')

    expect(screen.getByText(/1\.6500 WETH/)).toBeTruthy()
  })

  it('refuses an amount past the cap', () => {
    // Debt-free deliberately, so the CAP is the only thing that can disable the button. With
    // the default 20,000 of debt the health-factor guard also fires at this amount, and the
    // assertion would pass even with the cap gate removed entirely — it did, until a mutation
    // caught it.
    mount({ debtUsd: 0 })
    pick('USDC')
    type('4951')

    expect(submit().textContent).toContain('Exceeds borrow limit')
    expect(submit().disabled).toBe(true)
  })

  it('allows an amount at the cap', () => {
    // Debt-free, so the CAP is the binding constraint rather than the health factor. With the
    // default 20,000 of debt the two collide — 24,900 / (20,000 + 4,950) = 0.998 — and the HF
    // guard fires first, which is its own test below.
    mount({ debtUsd: 0 })
    pick('USDC')
    type('4950')

    expect(submit().textContent).toContain('Borrow')
    expect(submit().disabled).toBe(false)
  })

  it('fills MAX to exactly the cap', () => {
    // toFixed(decimals), so USDC's six places are all present.
    mount({ debtUsd: 0 })
    pick('USDC')
    fireEvent.click(screen.getByText('MAX'))

    expect(amountField().value).toBe('4950.000000')
    expect(submit().disabled).toBe(false)
  })

  it('lets the health-factor guard bind before the cap when the account is already levered', () => {
    // The cap allows 4,950 but the projected HF is 0.998 — the stricter of the two wins, which
    // is what stops the cap alone from walking someone into liquidation range.
    mount()
    pick('USDC')
    type('4950')

    expect(submit().textContent).toContain('Health factor too low')
    expect(submit().disabled).toBe(true)
  })

  it('caps at zero when the asset carries no price, rather than dividing by it', () => {
    mount({ availableReserves: [reserve({ symbol: 'USDC', underlyingAsset: USDC, decimals: 6, priceInUsd: '0' })] as never })
    pick('USDC')
    type('1')

    expect(submit().textContent).toContain('Exceeds borrow limit')
  })
})

describe('AssetsToBorrowModal — the health-factor gate', () => {
  it('blocks a borrow that would cross the floor', () => {
    // Headroom raised so the cap is not what stops it: 24,900 / (20,000 + 5,000) = 0.996.
    mount({ availableBorrowsUsd: 50_000 })
    pick('USDC')
    type('5000')

    expect(submit().textContent).toContain('Health factor too low')
    expect(submit().disabled).toBe(true)
  })

  it('allows a borrow that leaves the position above the floor', () => {
    // 24,900 / (20,000 + 1,000) = 1.186.
    mount({ availableBorrowsUsd: 50_000 })
    pick('USDC')
    type('1000')

    expect(submit().textContent).toContain('Borrow')
    expect(submit().disabled).toBe(false)
  })
})

describe('AssetsToBorrowModal — execution', () => {
  it('borrows an ERC-20 from the Pool at raised priority', async () => {
    mount()
    pick('USDC')
    type('100')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({
      address: POOL,
      functionName: 'borrow',
      priorityMultiplier: 10n,
    })
    expect(lastCall().args[1]).toBe(parseUnits('100', 6))
    expect(lastCall().args[4]).toBe(USER)
  })

  it('takes a credit delegation first when borrowing native ETH', async () => {
    // The gateway borrows on the user's behalf, so it needs delegated credit before it can.
    mount()
    pick('ETH')
    type('0.1')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ address: VDEBT, functionName: 'approveDelegation' })
    expect(lastCall().args[0]).toBe(GATEWAY)
    expect(lastCall().args[1]).toBe(maxUint256)
    expect(mocks.simulateAndWrite).toHaveBeenCalledTimes(1)
  })

  it('routes through the gateway once the delegation covers the amount', async () => {
    mocks.useReadContract.mockReturnValue({ data: maxUint256, refetch: vi.fn() })
    mount()
    pick('ETH')
    type('0.1')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ address: GATEWAY, functionName: 'borrowETH' })
  })

  it('surfaces a revert reason and leaves the form usable', async () => {
    mocks.simulateAndWrite.mockRejectedValue(new Error('execution reverted: 34'))
    mount()
    pick('USDC')
    type('100')
    fireEvent.click(submit())

    await waitFor(() => expect(screen.getByText(/Error|reverted/i)).toBeTruthy())
    expect(submit().textContent).toContain('Borrow')
  })
})
