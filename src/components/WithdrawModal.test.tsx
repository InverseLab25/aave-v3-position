import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { maxUint256, parseUnits } from 'viem'

/**
 * WithdrawModal is the shape all four Aave action modals share: derive a projected health
 * factor, gate the submit button on it, and size MAX from the RAW balance rather than the
 * rendered double. The pure helpers behind that are covered in utils/modalShared.test.ts —
 * these pin the wiring, which is where the value actually leaves.
 *
 * The button label doubles as the state readout: "Insufficient supplied", "Health factor too
 * low", "Processing…" or "Withdraw".
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

import { WithdrawModal } from './WithdrawModal'

const USER = '0x1111111111111111111111111111111111111111' as const
const POOL = '0x8787878787878787878787878787878787878787' as const
const GATEWAY = '0x9999999999999999999999999999999999999999' as const

/** A balance no double can hold exactly — the whole reason MAX reads `amountRaw`. */
const AWKWARD_RAW = 1_234_567_890_123_456_789n

const wethAsset = (over: Record<string, unknown> = {}) => ({
  symbol: 'WETH',
  underlyingAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  aTokenAddress: '0x3333333333333333333333333333333333333333',
  decimals: 18,
  amount: 1.2345678901234567,
  amountRaw: AWKWARD_RAW,
  priceInUsd: '3000',
  liquidationThreshold: 0.83,
  ...over,
})

const RESERVES = [{ symbol: 'WETH', liquidationThreshold: 0.83 }]

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
    explorerUrl: 'https://etherscan.io',
  })
  mocks.simulateAndWrite.mockResolvedValue('0xhash')
})

/** No debt by default, so the health-factor guard stays out of the way. */
const mount = (props: Record<string, unknown> = {}) =>
  render(
    <WithdrawModal
      asset={wethAsset() as never}
      collateralUsd={30_000}
      debtUsd={0}
      liquidationThreshold={0.83}
      suppliedAssets={[wethAsset()] as never}
      availableReserves={RESERVES as never}
      onClose={vi.fn()}
      {...props}
    />,
  )

const submit = () =>
  screen.getByRole('button', {
    name: /Withdraw|Insufficient supplied|Health factor too low|Processing/,
  }) as HTMLButtonElement
const amountField = () => screen.getByPlaceholderText('0.00') as HTMLInputElement
const type = (v: string) => fireEvent.change(amountField(), { target: { value: v } })

describe('WithdrawModal — the submit gate', () => {
  it('stays disabled until an amount is entered', () => {
    mount()
    expect(submit().disabled).toBe(true)
  })

  it('refuses an amount above what is supplied', () => {
    mount()
    type('99')
    expect(submit().textContent).toContain('Insufficient supplied')
    expect(submit().disabled).toBe(true)
  })

  it('blocks a withdrawal that would leave the position near liquidation', () => {
    // 30,000 collateral x 0.83 = 24,900 weighted. Withdrawing 1.2 WETH removes
    // 3,600 x 0.83 = 2,988, leaving 21,912 — against 22,000 of debt that is HF 0.996, under
    // the 1.03 floor, so it must be refused before it is signed rather than reverting on-chain.
    mount({ debtUsd: 22_000 })
    type('1.2')

    expect(submit().textContent).toContain('Health factor too low')
    expect(submit().disabled).toBe(true)
  })

  it('allows a withdrawal that leaves the position comfortable', () => {
    mount({ debtUsd: 20_000 })
    type('0.1')

    expect(submit().textContent).toContain('Withdraw')
    expect(submit().disabled).toBe(false)
  })

  it('never blocks on an infinite projected HF — a debt-free position cannot be liquidated', () => {
    mount({ debtUsd: 0 })
    type('1.2')

    expect(submit().disabled).toBe(false)
  })
})

describe('WithdrawModal — MAX and the amount actually sent', () => {
  it('fills the field from the RAW balance, not the rendered double', () => {
    // `asset.amount` is a lossy double; `.toFixed(18)` on it prints the exact expansion of that
    // double, which drifts from the true balance in both directions.
    mount()
    fireEvent.click(screen.getByText('MAX'))

    expect(amountField().value).toBe('1.234567890123456789')
  })

  it('sends the max sentinel after MAX, so dust cannot be left behind', async () => {
    mount()
    fireEvent.click(screen.getByText('MAX'))
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    const call = mocks.simulateAndWrite.mock.calls[0][2]
    expect(call.functionName).toBe('withdraw')
    expect(call.args[1]).toBe(maxUint256)
  })

  it('drops the sentinel the moment the user edits the field', async () => {
    // Editing clears isMax, so the typed value goes on-chain literally — which is exactly why
    // the field has to have been filled from the raw balance and not a drifted one.
    mount()
    fireEvent.click(screen.getByText('MAX'))
    type('0.5')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(mocks.simulateAndWrite.mock.calls[0][2].args[1]).toBe(parseUnits('0.5', 18))
  })

  it('withdraws an ERC-20 straight from the Pool', async () => {
    mount()
    type('0.5')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    const call = mocks.simulateAndWrite.mock.calls[0][2]
    expect(call.address).toBe(POOL)
    expect(call.functionName).toBe('withdraw')
  })
})

describe('WithdrawModal — the native path', () => {
  const ethAsset = () => wethAsset({ symbol: 'ETH' })

  it('takes an aToken approval first when the gateway has none', async () => {
    // The gateway pulls the aToken to unwrap it, so without an allowance the withdraw reverts.
    mocks.useReadContract.mockReturnValue({ data: 0n, refetch: vi.fn() })
    mount({
      asset: ethAsset(),
      suppliedAssets: [ethAsset()],
      availableReserves: [{ symbol: 'ETH', liquidationThreshold: 0.83 }],
    })
    type('0.5')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    const call = mocks.simulateAndWrite.mock.calls[0][2]
    expect(call.functionName).toBe('approve')
    expect(call.args[0]).toBe(GATEWAY)
    // Stops after approving — the user presses again to withdraw.
    expect(mocks.simulateAndWrite).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/click Withdraw again/)).toBeTruthy()
  })

  it('routes through the gateway once the allowance covers the amount', async () => {
    mocks.useReadContract.mockReturnValue({ data: maxUint256, refetch: vi.fn() })
    mount({
      asset: ethAsset(),
      suppliedAssets: [ethAsset()],
      availableReserves: [{ symbol: 'ETH', liquidationThreshold: 0.83 }],
    })
    type('0.5')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    const call = mocks.simulateAndWrite.mock.calls[0][2]
    expect(call.address).toBe(GATEWAY)
    expect(call.functionName).toBe('withdrawETH')
  })
})

describe('WithdrawModal — failure handling', () => {
  it('surfaces a revert reason and leaves the form usable', async () => {
    mocks.simulateAndWrite.mockRejectedValue(new Error('execution reverted: 32'))
    mount()
    type('0.5')
    fireEvent.click(submit())

    await waitFor(() => expect(screen.getByText(/Error/)).toBeTruthy())
    // Back to idle rather than stuck on "Processing…", so the user can adjust and retry.
    expect(submit().textContent).toContain('Withdraw')
  })
})
