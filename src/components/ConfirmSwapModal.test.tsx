import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { parseUnits } from 'viem'

/**
 * ConfirmSwapModal is the last thing a user reads before signing, so its arithmetic IS the
 * product: the rate, the minimum they are guaranteed, and how much value the route gives up.
 *
 * The slippage clamp is the one with teeth — a garbage or negative tolerance must not be able
 * to push the displayed minimum ABOVE the quoted output, which would show a floor the swap can
 * never clear.
 */
const mocks = vi.hoisted(() => ({ useConnection: vi.fn() }))

vi.mock('wagmi', () => ({
  useConnection: mocks.useConnection,
  // SwapExecutor renders inside this modal; it has its own suite.
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useWriteContract: () => ({ mutateAsync: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
  useSendTransaction: () => ({ mutate: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false }),
  useConfig: () => ({}),
}))
vi.mock('wagmi/actions', () => ({ estimateGas: vi.fn(), estimateFeesPerGas: vi.fn() }))
vi.mock('../utils/contract', () => ({ approveErc20: vi.fn() }))

import { ConfirmSwapModal } from './ConfirmSwapModal'

const WETH = { underlyingAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, priceInUsd: '3000' }
const USDC = { underlyingAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, priceInUsd: '1' }

/** 1 WETH in, 2,990 USDC out — a $10 spread on $3,000, i.e. 0.33% of value given up. */
const quote = (over: Record<string, unknown> = {}) => ({
  aggregator: 'KyberSwap',
  amountIn: parseUnits('1', 18).toString(),
  amountOut: parseUnits('2990', 6).toString(),
  amountOutUsd: '2990',
  gasUsd: '12',
  netReturnUsd: 2978,
  routeDetails: { type: 'kyber', totalAmountIn: parseUnits('1', 18), paths: [] },
  rawQuote: {},
  ...over,
})

const TX = { to: '0xrouter', data: '0xdead', value: '0', spender: '0xrouter' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useConnection.mockReturnValue({ address: '0x1111111111111111111111111111111111111111', chainId: 1 })
})

/**
 * The minimum-received value, scoped to its own row. The bare amount is not unique — the same
 * figure can appear in the output display when the tolerance is zero.
 */
const minReceiving = () => within(screen.getByText('Minimum Receiving').parentElement!)

const mount = (props: Record<string, unknown> = {}) =>
  render(
    <ConfirmSwapModal
      quote={quote() as never}
      txPayload={TX as never}
      fromAsset={WETH as never}
      toAsset={USDC as never}
      amountIn="1"
      slippage={0.5}
      onClose={vi.fn()}
      {...props}
    />,
  )

describe('ConfirmSwapModal — the numbers on the confirmation screen', () => {
  it('shows the rate as output per unit of input', () => {
    mount()
    expect(screen.getByText(/1 WETH = 2990\.0000 USDC/)).toBeTruthy()
  })

  it('derives the minimum received from the quote and the tolerance', () => {
    // 2,990 x (1 - 0.5%) = 2,975.05
    mount()
    expect(screen.getByText(/2975\.050000 USDC/)).toBeTruthy()
  })

  it('reports the value given up as a signed price impact', () => {
    // $3,000 in, $2,990 out — 0.33% lost, shown negative because it is a loss to the user.
    mount()
    expect(screen.getByText(/-0\.33%/)).toBeTruthy()
  })

  it('reports a gain as a positive impact', () => {
    mount({ quote: quote({ amountOutUsd: '3030' }) as never })
    expect(screen.getByText(/\+1\.00%/)).toBeTruthy()
  })

  it('collapses a negligible impact rather than printing -0.00%', () => {
    mount({ quote: quote({ amountOutUsd: '3000' }) as never })
    expect(screen.queryByText(/-0\.00%/)).toBeNull()
  })
})

describe('ConfirmSwapModal — the slippage clamp', () => {
  it('treats a negative tolerance as zero, so the minimum never exceeds the quote', () => {
    // Unclamped, `10000n - (-100n)` would put the floor 1% ABOVE the quoted output — a minimum
    // the swap could never clear, displayed as though it were guaranteed.
    mount({ slippage: -1 })
    expect(minReceiving().getByText(/2990\.000000 USDC/)).toBeTruthy()
  })

  it('caps an absurd tolerance at 50%', () => {
    mount({ slippage: 500 })
    expect(minReceiving().getByText(/1495\.000000 USDC/)).toBeTruthy()
  })

  it('gives a zero tolerance the full quoted output as its floor', () => {
    mount({ slippage: 0 })
    expect(minReceiving().getByText(/2990\.000000 USDC/)).toBeTruthy()
  })
})

describe('ConfirmSwapModal — refresh state', () => {
  it('shows how stale the quote is when a refresh timestamp is supplied', () => {
    // Seeded to lastRefreshedAt so the first render reads 0s without a setState in the effect.
    mount({ lastRefreshedAt: Date.now() })
    expect(screen.getByText(/Updated 0s ago/)).toBeTruthy()
  })

  it('shows nothing about staleness when the parent never refreshed', () => {
    mount({ lastRefreshedAt: 0 })
    expect(screen.queryByText(/Updated/)).toBeNull()
  })

  it('disables the refresh control while one is already in flight', () => {
    mount({ lastRefreshedAt: Date.now(), onRefresh: vi.fn(), isRefreshing: true })
    const refresh = screen.getAllByRole('button').find((b) => /refresh/i.test(b.textContent ?? ''))
    expect((refresh as HTMLButtonElement | undefined)?.disabled).toBe(true)
  })
})
