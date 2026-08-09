import { expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  getAllowedRouters: vi.fn(),
  getPauseState: vi.fn(),
  getAdaptersForChain: vi.fn(),
  usePublicClient: vi.fn(),
  useChainId: vi.fn(),
  useConnection: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: mocks.usePublicClient,
  useChainId: mocks.useChainId,
  useConnection: mocks.useConnection,
}))
vi.mock('../adapters', () => ({ getAdaptersForChain: mocks.getAdaptersForChain }))

import { useStrategiesOpen } from './useStrategiesOpen'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const KYBER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as const
const STRAT = '0x000000000000000000000000000000000000BEEF' as const

const RESERVES = {
  collateral: { address: WETH, decimals: 18, priceUsd: 250_000_000_000n, ltvBps: 7500n, liquidationThresholdBps: 8000n },
  debt: { address: USDC, decimals: 6, priceUsd: 100_000_000n, ltvBps: 8700n, liquidationThresholdBps: 8900n },
}

const INPUT = {
  contract: STRAT, mode: 1 as const, volatile: WETH, stable: USDC,
  marginAmount: 1_000_000_000_000_000_000n, leverageBps: 20_000n, slippageBps: 50n,
  reserves: RESERVES,
}

/** A stub adapter whose quote is a fixed rate, and whose build re-simulates a shade worse. */
function stubAdapter(rateNumeratorPerWei: bigint) {
  return {
    name: 'KyberSwap',
    supportsExecution: true,
    routerAddress: KYBER,
    getQuote: vi.fn(async (_f: unknown, _t: unknown, amountIn: string) => ({
      aggregator: 'KyberSwap',
      amountIn,
      amountOut: (BigInt(amountIn) * rateNumeratorPerWei).toString(),
      amountOutUsd: '0', gasUsd: '0', netReturnUsd: 0,
      routeDetails: { type: 'kyber' as const, totalAmountIn: BigInt(amountIn), paths: [] },
      rawQuote: {},
    })),
    buildTransaction: vi.fn(async (q: { amountIn: string }) => ({
      to: KYBER, data: '0xdeadbeef', value: '0', spender: KYBER,
      amountOut: (BigInt(q.amountIn) * rateNumeratorPerWei).toString(),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.useConnection.mockReturnValue({ address: '0x1111111111111111111111111111111111111111' })
  mocks.usePublicClient.mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'paused') return 0n
      if (functionName === 'getAllowedRouters') return [KYBER]
      return 0n
    }),
  })
})

it('previews a 2x open, sizing against the quoted rate rather than the oracle', async () => {
  // 4e8 WETH wei per USDC wei is exactly the oracle rate, so the sizes are the pinned ones.
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  expect(result.current.preview?.flashAmount).toBe(1_000_000_000_000_000_000n)
  expect(result.current.preview?.borrowAmount).toBe(2_512_562_815n)
  expect(result.current.preview?.expectedLeverageBps).toBe(20_050n)
  expect(result.current.preview?.router).toBe(KYBER)
  expect(result.current.previewError).toBeNull()
})

it('re-quotes once when the re-sized borrow grew, and stops there', async () => {
  // A rate worse than the oracle's makes the second sizing ask for more than was quoted.
  const adapter = stubAdapter(399_000_000n)
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  expect(adapter.getQuote).toHaveBeenCalledTimes(2)
})

it('blocks when the contract is paused', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])
  mocks.usePublicClient.mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'paused' ? 1n : [KYBER],
    ),
  })

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.previewError).not.toBeNull())
  expect(result.current.previewError?.kind).toBe('paused')
})

it('reports a sizing rejection rather than throwing', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])

  const { result } = renderHook(() =>
    useStrategiesOpen({ ...INPUT, leverageBps: 39_200n }), // == the LTV ceiling
  )
  await waitFor(() => expect(result.current.previewError).not.toBeNull())
  expect(result.current.previewError?.kind).toBe('LEVERAGE_ABOVE_LTV')
})

it('reports when no allowlisted router can price the pair', async () => {
  const adapter = stubAdapter(400_000_000n)
  // The stub's getQuote is inferred from its happy-path return shape; this replacement
  // deliberately returns null instead, which is a legitimate getQuote result but not
  // assignable to that narrower inferred type.
  adapter.getQuote = vi.fn(async () => null) as unknown as typeof adapter.getQuote
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.previewError).not.toBeNull())
  expect(result.current.previewError?.kind).toBe('no-route')
})
