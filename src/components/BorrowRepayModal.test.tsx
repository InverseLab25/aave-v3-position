import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { maxUint256, parseUnits } from 'viem'

/**
 * BorrowRepayModal carries two flows behind one form, and the differences between them are
 * exactly where the bugs would live: MAX means something only on the repay side, borrow takes a
 * credit delegation where repay takes an ERC-20 approval, and the health-factor guard moves in
 * opposite directions.
 *
 * Same harness as WithdrawModal. The button label is the state readout: "Insufficient balance",
 * "Exceeds debt", "Health factor too low", "Processing…", or the tab name.
 */
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useWriteContract: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
  useReadContract: vi.fn(),
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

import { BorrowRepayModal } from './BorrowRepayModal'

const USER = '0x1111111111111111111111111111111111111111' as const
const POOL = '0x8787878787878787878787878787878787878787' as const
const GATEWAY = '0x9999999999999999999999999999999999999999' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const VDEBT = '0x4444444444444444444444444444444444444444' as const

/** A debt no double can hold exactly — the reason MAX reads `amountRaw`. */
const AWKWARD_DEBT_RAW = 1_000_123_456n // 1000.123456 USDC

const usdcDebt = (over: Record<string, unknown> = {}) => ({
  symbol: 'USDC',
  underlyingAsset: USDC,
  variableDebtTokenAddress: VDEBT,
  decimals: 6,
  amount: 1000.123456,
  amountRaw: AWKWARD_DEBT_RAW,
  priceInUsd: '1',
  ...over,
})

/**
 * Wallet balance for the repay tab, read through `balanceOf`. Set high by default so the
 * insufficient-balance gate stays out of the way unless a test is about it.
 */
let walletBalanceRaw: bigint

beforeEach(() => {
  vi.clearAllMocks()
  walletBalanceRaw = parseUnits('5000', 6)
  mocks.useConnection.mockReturnValue({ address: USER, chainId: 1 })
  mocks.useWriteContract.mockReturnValue({ mutateAsync: vi.fn() })
  mocks.useWaitForTransactionReceipt.mockReturnValue({ isLoading: false })
  mocks.useReadContract.mockImplementation(({ functionName }: { functionName?: string }) => ({
    // `allowance` and `borrowAllowance` default to zero so the approval legs are exercised;
    // `balanceOf` funds the repay tab.
    data: functionName === 'balanceOf' ? walletBalanceRaw : 0n,
    refetch: vi.fn(),
  }))
  mocks.useBalance.mockReturnValue({ data: { value: parseUnits('10', 18), decimals: 18 } })
  mocks.useConfig.mockReturnValue({})
  mocks.useAdjustedGas.mockReturnValue({
    maxFee: 30_000_000_000n, maxPriority: 1_000_000_000n, estimatedFeeUsd: 5,
  })
  mocks.getChainConfig.mockReturnValue({
    aave: { poolAddress: POOL, wethGateway: GATEWAY },
    explorerUrl: 'https://etherscan.io',
  })
  mocks.simulateAndWrite.mockResolvedValue('0xhash')
  mocks.approveErc20.mockResolvedValue('0xapprove')
})

/**
 * 30,000 collateral x 0.83 = 24,900 weighted, against 20,000 of debt: HF 1.245 to start.
 * Every health-factor number below is derived from exactly these.
 */
const mount = (props: Record<string, unknown> = {}) =>
  render(
    <BorrowRepayModal
      asset={usdcDebt() as never}
      collateralUsd={30_000}
      debtUsd={20_000}
      liquidationThreshold={0.83}
      suppliedAssets={[] as never}
      onClose={vi.fn()}
      {...props}
    />,
  )

/**
 * The action button. `getAllByRole` and last, not `getByRole`, because the two TAB buttons carry
 * the same "Borrow"/"Repay" labels — the action button is the last of them in DOM order.
 */
const submit = () => {
  const all = screen.getAllByRole('button', {
    name: /^(Borrow|Repay|Insufficient balance|Exceeds debt|Health factor too low|Processing…)$/,
  }) as HTMLButtonElement[]
  return all[all.length - 1]
}
const amountField = () => screen.getByPlaceholderText('0.00') as HTMLInputElement
const type = (v: string) => fireEvent.change(amountField(), { target: { value: v } })
const lastCall = () => mocks.simulateAndWrite.mock.calls.at(-1)![2]

describe('BorrowRepayModal — borrow gating', () => {
  it('stays disabled until an amount is entered', () => {
    mount()
    expect(submit().disabled).toBe(true)
  })

  it('blocks a borrow that would cross the health-factor floor', () => {
    // 24,900 / (20,000 + 5,000) = 0.996, under the 1.03 floor.
    mount()
    type('5000')

    expect(submit().textContent).toContain('Health factor too low')
    expect(submit().disabled).toBe(true)
  })

  it('allows a borrow that leaves the position above the floor', () => {
    // 24,900 / (20,000 + 1,000) = 1.186 — a warning, not a block.
    mount()
    type('1000')

    expect(submit().textContent).toContain('Borrow')
    expect(submit().disabled).toBe(false)
  })

  it('does not apply the repay-side balance gates to a borrow', () => {
    // Borrowing more than you hold in your wallet is the entire point of borrowing.
    walletBalanceRaw = 0n
    mount()
    type('1000')

    expect(submit().disabled).toBe(false)
  })
})

describe('BorrowRepayModal — borrow execution', () => {
  it('borrows an ERC-20 from the Pool at raised priority', async () => {
    // Borrow is priority-bumped because it competes with liquidators for inclusion.
    mount()
    type('1000')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({
      address: POOL,
      functionName: 'borrow',
      priorityMultiplier: 10n,
    })
    expect(lastCall().args[1]).toBe(parseUnits('1000', 6))
  })

  it('offers no MAX on the borrow tab at all', () => {
    // Stronger than "MAX would not send the sentinel": the control is repay-only, so the
    // unbounded-borrow path cannot be reached from the UI in the first place. `finalAmount`
    // gating on `activeTab === 'repay'` is the second line of defence behind this one.
    mount()
    expect(screen.queryByText('MAX')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Repay' }))
    expect(screen.getByText('MAX')).toBeTruthy()
  })

  it('sends a borrow amount literally, never the max sentinel', async () => {
    mount()
    type('1000.123456')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall().args[1]).not.toBe(maxUint256)
    expect(lastCall().args[1]).toBe(AWKWARD_DEBT_RAW)
  })

  it('takes a credit delegation first when borrowing native ETH', async () => {
    // The gateway borrows on the user's behalf, so it needs delegated credit before it can.
    mount({ asset: usdcDebt({ symbol: 'ETH', decimals: 18, priceInUsd: '3000' }) })
    type('0.1')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ address: VDEBT, functionName: 'approveDelegation' })
    expect(lastCall().args[0]).toBe(GATEWAY)
    expect(mocks.simulateAndWrite).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/Click Borrow again/)).toBeTruthy()
  })

  it('routes through the gateway once the delegation covers the amount', async () => {
    mocks.useReadContract.mockImplementation(({ functionName }: { functionName?: string }) => ({
      data: functionName === 'balanceOf' ? walletBalanceRaw : maxUint256,
      refetch: vi.fn(),
    }))
    mount({ asset: usdcDebt({ symbol: 'ETH', decimals: 18, priceInUsd: '3000' }) })
    type('0.1')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ address: GATEWAY, functionName: 'borrowETH' })
  })
})

describe('BorrowRepayModal — repay gating', () => {
  const repayMount = (props: Record<string, unknown> = {}) => mount({ initialTab: 'repay', ...props })

  it('refuses more than the wallet holds', () => {
    walletBalanceRaw = parseUnits('500', 6)
    repayMount()
    type('800')

    expect(submit().textContent).toContain('Insufficient balance')
    expect(submit().disabled).toBe(true)
  })

  it('refuses more than is owed, even with the balance to cover it', () => {
    // 1,500 is inside a 5,000 wallet but past the 1000.12 debt — repaying more than you owe is
    // not a thing Aave will do, so the button says why rather than reverting.
    repayMount()
    type('1500')

    expect(submit().textContent).toContain('Exceeds debt')
    expect(submit().disabled).toBe(true)
  })

  it('allows a repay within both the balance and the debt', () => {
    repayMount()
    type('500')

    expect(submit().textContent).toContain('Repay')
    expect(submit().disabled).toBe(false)
  })

  it('never blocks a repay on the health factor — repaying can only improve it', () => {
    repayMount()
    type('500')

    expect(submit().textContent).not.toContain('Health factor')
  })
})

describe('BorrowRepayModal — repay execution', () => {
  const repayMount = (props: Record<string, unknown> = {}) => mount({ initialTab: 'repay', ...props })

  it('fills MAX from the raw debt, not the rendered double', () => {
    repayMount()
    fireEvent.click(screen.getByText('MAX'))

    expect(amountField().value).toBe('1000.123456')
  })

  it('approves before repaying when the allowance is short', async () => {
    repayMount()
    type('500')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.approveErc20).toHaveBeenCalled())
    expect(mocks.approveErc20.mock.calls[0][2]).toMatchObject({
      token: USDC,
      spender: POOL,
      amount: parseUnits('500', 6),
      currentAllowance: 0n,
    })
    // Stops after approving so the user presses again — no repay in the same click.
    expect(mocks.simulateAndWrite).not.toHaveBeenCalled()
    expect(await screen.findByText(/click Repay again/)).toBeTruthy()
  })

  it('approves the max sentinel on a MAX repay, not the snapshot', async () => {
    // Aave pulls the CURRENT debt on a max repay — snapshot plus interest accrued since load —
    // so an approval sized to the snapshot would come up short and revert.
    repayMount()
    fireEvent.click(screen.getByText('MAX'))
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.approveErc20).toHaveBeenCalled())
    expect(mocks.approveErc20.mock.calls[0][2].amount).toBe(maxUint256)
  })

  it('repays with the max sentinel once the allowance covers it', async () => {
    mocks.useReadContract.mockImplementation(({ functionName }: { functionName?: string }) => ({
      data: functionName === 'balanceOf' ? walletBalanceRaw : maxUint256,
      refetch: vi.fn(),
    }))
    repayMount()
    fireEvent.click(screen.getByText('MAX'))
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall()).toMatchObject({ address: POOL, functionName: 'repay' })
    expect(lastCall().args[1]).toBe(maxUint256)
  })

  it('repays a typed amount literally', async () => {
    mocks.useReadContract.mockImplementation(({ functionName }: { functionName?: string }) => ({
      data: functionName === 'balanceOf' ? walletBalanceRaw : maxUint256,
      refetch: vi.fn(),
    }))
    repayMount()
    type('500')
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    expect(lastCall().args[1]).toBe(parseUnits('500', 6))
  })
})

describe('BorrowRepayModal — native MAX repay overshoots the snapshot within gas', () => {
  const ethDebt = () => usdcDebt({ symbol: 'ETH', decimals: 18, amount: 1, amountRaw: parseUnits('1', 18), priceInUsd: '3000' })

  it('sends the sentinel with a buffered value when the wallet can afford it', async () => {
    // 10 ETH balance minus a 2 x (30 gwei x 300,000) reserve leaves plenty, so the 0.1% buffer
    // above the 1 ETH snapshot fits: repay uint256 max, and overpay slightly so interest
    // accrued since load is covered. The gateway refunds the unused value.
    mocks.useBalance.mockReturnValue({ data: { value: parseUnits('10', 18), decimals: 18 } })
    mount({ initialTab: 'repay', asset: ethDebt() })
    fireEvent.click(screen.getByText('MAX'))
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    const call = lastCall()
    const one = parseUnits('1', 18)
    expect(call).toMatchObject({ address: GATEWAY, functionName: 'repayETH' })
    expect(call.args[1]).toBe(maxUint256)
    expect(call.value).toBe(one + (one * 10n) / 10_000n)
  })

  it('falls back to what gas leaves when the wallet cannot clear the debt', async () => {
    // A balance barely above the debt cannot also fund the buffer AND gas, so it repays the
    // spendable amount concretely instead of asking for a sentinel it cannot fund.
    mocks.useBalance.mockReturnValue({ data: { value: parseUnits('1', 18), decimals: 18 } })
    mount({ initialTab: 'repay', asset: ethDebt() })
    fireEvent.click(screen.getByText('MAX'))
    fireEvent.click(submit())

    await waitFor(() => expect(mocks.simulateAndWrite).toHaveBeenCalled())
    const call = lastCall()
    const reserve = 30_000_000_000n * 300_000n * 2n
    expect(call.args[1]).toBe(parseUnits('1', 18) - reserve)
    expect(call.value).toBe(call.args[1])
  })
})
