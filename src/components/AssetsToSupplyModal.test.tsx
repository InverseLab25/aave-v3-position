import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { maxUint256, parseUnits } from 'viem'

/**
 * AssetsToSupplyModal picks an asset first, then takes an amount — so the selection step is part
 * of every path. Two things are specific to it: the native entry is synthesised from the wrapped
 * reserve (symbol ETH, address `native`), and its MAX has to hold gas back because the amount
 * rides as msg.value.
 */
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useWriteContract: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
  useReadContract: vi.fn(),
  useReadContracts: vi.fn(),
  useBalance: vi.fn(),
  useConfig: vi.fn(),
  useAdjustedGas: vi.fn(),
  getChainConfig: vi.fn(),
  simulateAndWrite: vi.fn(),
  approveErc20: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useWriteContract: mocks.useWriteContract,
  useWaitForTransactionReceipt: mocks.useWaitForTransactionReceipt,
  useReadContract: mocks.useReadContract,
  useReadContracts: mocks.useReadContracts,
  useBalance: mocks.useBalance,
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
  approveErc20: mocks.approveErc20,
}))

import { AssetsToSupplyModal } from './AssetsToSupplyModal'

const USER = '0x1111111111111111111111111111111111111111' as const
const POOL = '0x8787878787878787878787878787878787878787' as const
const GATEWAY = '0x9999999999999999999999999999999999999999' as const
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const

/** Mirrors the constant in the component — Aave supply, NOT the 300k borrow/repay limit. */
const SUPPLY_GAS_LIMIT = 250_000n
const MAX_FEE = 30_000_000_000n

const reserve = (over: Record<string, unknown> = {}) => ({
  symbol: 'WETH',
  underlyingAsset: WETH,
  decimals: 18,
  priceInUsd: '3000',
  apy: 2,
  liquidationThreshold: 0.83,
  ...over,
})

const RESERVES = [reserve(), reserve({ symbol: 'USDC', underlyingAsset: USDC, decimals: 6, priceInUsd: '1', liquidationThreshold: 0.85 })]

/** ERC-20 balances come back through a multicall, in the order the options were built. */
let tokenBalances: { result: bigint }[]
let nativeBalance: bigint

beforeEach(() => {
  vi.clearAllMocks()
  tokenBalances = [{ result: parseUnits('5', 18) }, { result: parseUnits('10000', 6) }]
  nativeBalance = parseUnits('10', 18)

  mocks.useConnection.mockReturnValue({ address: USER, chainId: 1 })
  mocks.useWriteContract.mockReturnValue({ mutateAsync: vi.fn() })
  mocks.useWaitForTransactionReceipt.mockReturnValue({ isLoading: false })
  mocks.useReadContract.mockReturnValue({ data: 0n, refetch: vi.fn() })
  mocks.useReadContracts.mockImplementation(() => ({ data: tokenBalances }))
  mocks.useBalance.mockImplementation(() => ({ data: { value: nativeBalance, decimals: 18 } }))
  mocks.useConfig.mockReturnValue({})
  mocks.useAdjustedGas.mockReturnValue({ maxFee: MAX_FEE, maxPriority: 1_000_000_000n, estimatedFeeUsd: 5 })
  mocks.getChainConfig.mockReturnValue({
    aave: { poolAddress: POOL, wethGateway: GATEWAY },
    // The supply list is filtered to these symbols — the modal offers the chain's default
    // tokens, not every listed reserve.
    defaultTokens: [{ symbol: 'WETH' }, { symbol: 'USDC' }],
    explorerUrl: 'https://etherscan.io',
  })
  mocks.simulateAndWrite.mockResolvedValue('0xhash')
  mocks.approveErc20.mockResolvedValue('0xapprove')
})

const mount = (props: Record<string, unknown> = {}) =>
  render(
    <AssetsToSupplyModal
      chainId={1}
      availableReserves={RESERVES as never}
      collateralUsd={30_000}
      debtUsd={20_000}
      liquidationThreshold={0.83}
      suppliedAssets={[] as never}
      onClose={vi.fn()}
      {...props}
    />,
  )

/** Pick an asset from the table, which is what reveals the amount form. */
const pick = (symbol: string) => {
  const row = screen.getByText(symbol).closest('tr')!
  fireEvent.click(within(row).getByRole('button', { name: 'Supply' }))
}

const amountField = () => screen.getByPlaceholderText('0.00') as HTMLInputElement
const type = (v: string) => fireEvent.change(amountField(), { target: { value: v } })
const submit = () =>
  screen.getByRole('button', {
    name: /^(Supply|Insufficient balance|Health factor too low|Processing…)$/,
  }) as HTMLButtonElement
const lastCall = () => mocks.simulateAndWrite.mock.calls.at(-1)![2]

describe('AssetsToSupplyModal — asset selection', () => {
  it('offers native ETH alongside the ERC-20 reserves', () => {
    // Synthesised from the wrapped reserve so a user can supply the token they actually hold.
    mount()
    expect(screen.getByText('ETH')).toBeTruthy()
    expect(screen.getByText('WETH')).toBeTruthy()
  })

  it('offers only the chain\'s default tokens, not every listed reserve', () => {
    // targetSymbols comes from chainConfig.defaultTokens, so a reserve outside that set is
    // never offered even when Aave lists it.
    mount({ availableReserves: [...RESERVES, reserve({ symbol: 'DAI', underlyingAsset: '0xdai' })] as never })

    expect(screen.queryByText('DAI')).toBeNull()
    expect(screen.getByText('USDC')).toBeTruthy()
  })

  it('shows the amount form only once an asset is chosen', () => {
    mount()
    expect(screen.queryByPlaceholderText('0.00')).toBeNull()

    pick('USDC')
    expect(amountField()).toBeTruthy()
  })
})

describe('AssetsToSupplyModal — the submit gate', () => {
  it('stays disabled until an amount is entered', () => {
    mount()
    pick('USDC')
    expect(submit().disabled).toBe(true)
  })

  it('refuses more than the wallet holds', () => {
    mount()
    pick('USDC')
    type('20000') // wallet holds 10,000

    expect(submit().textContent).toContain('Insufficient balance')
    expect(submit().disabled).toBe(true)
  })

  it('allows an amount inside the balance', () => {
    mount()
    pick('USDC')
    type('100')

    expect(submit().textContent).toContain('Supply')
    expect(submit().disabled).toBe(false)
  })

  it('never blocks a supply on the health factor — supplying can only improve it', () => {
    // Supplying adds to the weighted collateral, so the projected HF only ever rises.
    mount()
    pick('USDC')
    type('100')

    expect(submit().textContent).not.toContain('Health factor')
  })
})

describe('AssetsToSupplyModal — MAX', () => {
  it('offers the whole ERC-20 balance, since it is not spent on gas', () => {
    mount()
    pick('USDC')
    fireEvent.click(screen.getByText('MAX'))

    expect(amountField().value).toBe('10000')
  })

  it('holds gas back on native ETH, because the amount rides as msg.value', () => {
    // 10 ETH minus 2 x (30 gwei x 300,000) — spending the whole balance always fails at
    // simulation with "insufficient funds".
    mount()
    pick('ETH')
    fireEvent.click(screen.getByText('MAX'))

    const reserveWei = MAX_FEE * SUPPLY_GAS_LIMIT * 2n
    expect(amountField().value).toBe(
      (Number(parseUnits('10', 18) - reserveWei) / 1e18).toString(),
    )
  })
})

describe('AssetsToSupplyModal — execution', () => {
  it('supplies native ETH through the gateway as msg.value', async () => {
    mount()
    pick('ETH')
    type('1')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ address: GATEWAY, functionName: 'depositETH' })
    expect(lastCall().value).toBe(parseUnits('1', 18))
  })

  it('approves before supplying an ERC-20 when the allowance is short', async () => {
    mount()
    pick('USDC')
    type('100')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.approveErc20).toHaveBeenCalled())
    // Approves the max sentinel, so a repeat supply of the same asset needs no second approval.
    expect(mocks.approveErc20.mock.calls[0][2]).toMatchObject({
      token: USDC,
      spender: POOL,
      amount: maxUint256,
    })
  })

  it('supplies straight to the Pool once the allowance covers it', async () => {
    mocks.useReadContract.mockReturnValue({ data: maxUint256, refetch: vi.fn() })
    mount()
    pick('USDC')
    type('100')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ address: POOL, functionName: 'supply' })
    expect(lastCall().args[1]).toBe(parseUnits('100', 6))
    // onBehalfOf is the user, not the modal.
    expect(lastCall().args[2]).toBe(USER)
  })

  it('surfaces a revert reason and leaves the form usable', async () => {
    mocks.useReadContract.mockReturnValue({ data: maxUint256, refetch: vi.fn() })
    mocks.simulateAndWrite.mockRejectedValue(new Error('execution reverted: 51'))
    mount()
    pick('USDC')
    type('100')
    fireEvent.click(submit())

    await waitFor(() => expect(screen.getByText(/reverted|Error/i)).toBeTruthy())
    expect(submit().textContent).toContain('Supply')
  })
})
