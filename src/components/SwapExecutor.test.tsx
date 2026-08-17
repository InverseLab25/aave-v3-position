import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { parseUnits } from 'viem'

/**
 * SwapExecutor derives its whole UI from wallet and transaction state rather than mirroring it
 * into state through effects — an eight-branch ternary, ordered most-advanced-first so the
 * latest phase wins each render. That ordering is load-bearing and invisible: get it wrong and
 * the component shows "Approve" over a swap that is already in flight.
 *
 * These drive the wagmi hooks directly and assert on which phase the component lands in, plus
 * the pre-flight that stops bad aggregator calldata from reaching the chain.
 */
const mocks = vi.hoisted(() => ({
  useConnection: vi.fn(),
  useReadContract: vi.fn(),
  useWriteContract: vi.fn(),
  useSendTransaction: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
  useConfig: vi.fn(),
  estimateGas: vi.fn(),
  estimateFeesPerGas: vi.fn(),
  approveErc20: vi.fn(),
  getChainConfig: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  useReadContract: mocks.useReadContract,
  useWriteContract: mocks.useWriteContract,
  useSendTransaction: mocks.useSendTransaction,
  useWaitForTransactionReceipt: mocks.useWaitForTransactionReceipt,
  useConfig: mocks.useConfig,
}))
vi.mock('wagmi/actions', () => ({
  estimateGas: mocks.estimateGas,
  estimateFeesPerGas: mocks.estimateFeesPerGas,
}))
vi.mock('../utils/contract', () => ({ approveErc20: mocks.approveErc20 }))
vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getChainConfig: mocks.getChainConfig,
}))

import { SwapExecutor } from './SwapExecutor'

const USER = '0x1111111111111111111111111111111111111111' as const
const ROUTER = '0x2222222222222222222222222222222222222222' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const

const TX_PAYLOAD = { to: ROUTER, data: '0xdeadbeef', value: '0', spender: ROUTER }
const ERC20_ASSET = { underlyingAsset: USDC, symbol: 'USDC', decimals: 6 }
const NATIVE_ASSET = { underlyingAsset: NATIVE, symbol: 'ETH', decimals: 18 }
const AMOUNT_IN = '1000'
const AMOUNT_WEI = parseUnits(AMOUNT_IN, 6)

let sendTransaction: ReturnType<typeof vi.fn>
let resetApprove: ReturnType<typeof vi.fn>
let resetSwap: ReturnType<typeof vi.fn>
let refetchAllowance: ReturnType<typeof vi.fn>

/** Every wagmi hook at rest; each test perturbs only the axis it is about. */
const atRest = () => {
  refetchAllowance = vi.fn()
  sendTransaction = vi.fn()
  resetApprove = vi.fn()
  resetSwap = vi.fn()

  mocks.useReadContract.mockReturnValue({ data: undefined, refetch: refetchAllowance })
  mocks.useWriteContract.mockReturnValue({
    mutateAsync: vi.fn(),
    data: undefined,
    isPending: false,
    error: null,
    reset: resetApprove,
  })
  mocks.useSendTransaction.mockReturnValue({
    mutate: sendTransaction,
    data: undefined,
    isPending: false,
    error: null,
    reset: resetSwap,
  })
  mocks.useWaitForTransactionReceipt.mockReturnValue({ isSuccess: false })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: USER, chainId: 1 })
  mocks.useConfig.mockReturnValue({})
  mocks.getChainConfig.mockReturnValue({ explorerUrl: 'https://etherscan.io' })
  mocks.estimateGas.mockResolvedValue(300_000n)
  mocks.estimateFeesPerGas.mockResolvedValue({
    maxFeePerGas: 30_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  })
  atRest()
})

const mount = (props: Record<string, unknown> = {}) =>
  render(
    <SwapExecutor
      txPayload={TX_PAYLOAD}
      fromAsset={ERC20_ASSET}
      amountIn={AMOUNT_IN}
      onClose={vi.fn()}
      isEmbedded
      {...props}
    />,
  )

describe('SwapExecutor — the derived step machine', () => {
  it('waits on the allowance read before offering anything', () => {
    // `undefined` means the read has not landed, which is NOT the same as an allowance of zero.
    mount()
    expect(screen.getByText('Checking...')).toBeTruthy()
  })

  it('asks for approval when the allowance is short of the amount', () => {
    mocks.useReadContract.mockReturnValue({ data: AMOUNT_WEI - 1n, refetch: refetchAllowance })
    mount()
    expect(screen.getByText('Approve USDC')).toBeTruthy()
  })

  it('goes straight to executing when the allowance already covers the amount', () => {
    mocks.useReadContract.mockReturnValue({ data: AMOUNT_WEI, refetch: refetchAllowance })
    mount()
    expect(screen.getByText('Confirm')).toBeTruthy()
  })

  it('skips the whole approval leg for a native sell', () => {
    // Native rides along as tx `value`, so there is no ERC-20 allowance to check — and the
    // allowance read stays disabled, so `undefined` must not strand it on "Checking".
    mount({ fromAsset: NATIVE_ASSET, amountIn: '1' })
    expect(screen.getByText('Confirm')).toBeTruthy()
  })

  it('shows approving while the approval is pending', () => {
    mocks.useWriteContract.mockReturnValue({
      mutateAsync: vi.fn(), data: undefined, isPending: true, error: null, reset: resetApprove,
    })
    mount()
    expect(screen.getByText('Processing...')).toBeTruthy()
  })

  it('stays on approving after the approval is sent but before it confirms', () => {
    mocks.useWriteContract.mockReturnValue({
      mutateAsync: vi.fn(), data: '0xapprovehash', isPending: false, error: null, reset: resetApprove,
    })
    mount()
    expect(screen.getByText('Processing...')).toBeTruthy()
  })

  it('lets an in-flight swap outrank a SATISFIED allowance', () => {
    // The precedence that actually matters, and the one a zero-allowance case cannot prove:
    // with the allowance already covering the amount, both the `executing` and `approved`
    // branches are live, so only the most-advanced-first ordering keeps the button from
    // reverting to "Confirm" over a swap that is already in flight — one click from a
    // double submit.
    mocks.useReadContract.mockReturnValue({ data: AMOUNT_WEI, refetch: refetchAllowance })
    mocks.useSendTransaction.mockReturnValue({
      mutate: sendTransaction, data: '0xswaphash', isPending: false, error: null, reset: resetSwap,
    })
    mount()

    // Approving and executing share the "Processing..." label now, so what this pins is that the
    // button is NOT back on Confirm — one click from a double submit.
    expect(screen.getByText('Processing...')).toBeTruthy()
    expect(screen.queryByText('Confirm')).toBeNull()
  })

  it('lets an in-flight swap outrank a still-short allowance too', () => {
    // The weaker sibling: a sent swap must not be relabelled "Approve" because the allowance
    // read has not caught up.
    mocks.useReadContract.mockReturnValue({ data: 0n, refetch: refetchAllowance })
    mocks.useSendTransaction.mockReturnValue({
      mutate: sendTransaction, data: '0xswaphash', isPending: false, error: null, reset: resetSwap,
    })
    mount()

    expect(screen.getByText('Processing...')).toBeTruthy()
    expect(screen.queryByText('Approve USDC')).toBeNull()
  })

  it('takes itself off screen once the swap confirms', () => {
    // Success is the parent modal's to report, with the fill it can read off the receipt. Leaving
    // a button here as well would offer to send again what has already been sent.
    mocks.useSendTransaction.mockReturnValue({
      mutate: sendTransaction, data: '0xswaphash', isPending: false, error: null, reset: resetSwap,
    })
    mocks.useWaitForTransactionReceipt.mockReturnValue({ isSuccess: true })

    const { container } = mount()

    expect(container.firstChild).toBeNull()
  })

  it('tells the parent which step it is on, and the hash once there is one', () => {
    // How the parent knows to show "Processing..." and then a receipt: this component owns the
    // step machine, and the modal around it owns what the user reads.
    const onStepChange = vi.fn()
    mocks.useSendTransaction.mockReturnValue({
      mutate: sendTransaction, data: '0xswaphash', isPending: false, error: null, reset: resetSwap,
    })
    mount({ onStepChange })

    expect(onStepChange).toHaveBeenCalledWith('executing', '0xswaphash')
  })

  it('lets a swap error outrank an in-flight swap', () => {
    mocks.useSendTransaction.mockReturnValue({
      mutate: sendTransaction,
      data: '0xswaphash',
      isPending: false,
      error: new Error('reverted'),
      reset: resetSwap,
    })
    mount()
    expect(screen.getByText('Retry')).toBeTruthy()
  })
})

describe('SwapExecutor — the pre-flight before sending', () => {
  const approved = () =>
    mocks.useReadContract.mockReturnValue({ data: AMOUNT_WEI, refetch: refetchAllowance })

  it('sends the swap once the dry run passes, with a buffered gas limit', async () => {
    approved()
    mount()

    fireEvent.click(screen.getByText('Confirm'))

    await waitFor(() => expect(sendTransaction).toHaveBeenCalled())
    const sent = sendTransaction.mock.calls[0][0]
    expect(sent.to).toBe(ROUTER)
    expect(sent.data).toBe('0xdeadbeef')
    // Buffered above the raw estimate rather than passed through — aggregator routes can take a
    // costlier path than the one quoted.
    expect(sent.gas).toBeGreaterThan(300_000n)
  })

  it('refuses to send when the dry run reverts', async () => {
    // Stale aggregator calldata reverts here for free instead of on-chain at the user's expense.
    approved()
    mocks.estimateGas.mockRejectedValue(new Error('execution reverted'))
    mount()

    fireEvent.click(screen.getByText('Confirm'))

    await waitFor(() => expect(screen.getByText(/Swap would revert/)).toBeTruthy())
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('clears a failed attempt on retry so the step can re-derive', async () => {
    approved()
    mocks.estimateGas.mockRejectedValue(new Error('execution reverted'))
    mount()

    fireEvent.click(screen.getByText('Confirm'))
    await waitFor(() => expect(screen.getByText('Retry')).toBeTruthy())

    fireEvent.click(screen.getByText('Retry'))

    // Both mutations are reset, and the local pre-flight error is dropped.
    expect(resetApprove).toHaveBeenCalled()
    expect(resetSwap).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('Confirm')).toBeTruthy())
  })

  it('tells the parent to freeze quote refresh the moment the user commits', async () => {
    // A refreshed quote mid-flight would move the calldata under a transaction already sent.
    approved()
    const onSwapStart = vi.fn()
    mount({ onSwapStart })

    fireEvent.click(screen.getByText('Confirm'))

    expect(onSwapStart).toHaveBeenCalledTimes(1)
  })

  it('treats an unresolved allowance as zero when approving, not as unknown', async () => {
    // approveErc20 only needs the zero-reset path when a non-zero allowance is already in place;
    // guessing high would skip it for USDT-likes that require it.
    mocks.useReadContract.mockReturnValue({ data: 0n, refetch: refetchAllowance })
    const onSwapStart = vi.fn()
    mount({ onSwapStart })

    fireEvent.click(screen.getByText('Approve USDC'))

    await waitFor(() => expect(mocks.approveErc20).toHaveBeenCalled())
    expect(mocks.approveErc20.mock.calls[0][2]).toMatchObject({
      token: USDC,
      spender: ROUTER,
      amount: AMOUNT_WEI,
      currentAllowance: 0n,
    })
    expect(onSwapStart).toHaveBeenCalled()
  })
})
