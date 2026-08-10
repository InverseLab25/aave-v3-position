import { expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { Adapter } from '../adapters/types'

const mocks = vi.hoisted(() => ({
  getAllowedRouters: vi.fn(),
  getPauseState: vi.fn(),
  getAdaptersForChain: vi.fn(),
  usePublicClient: vi.fn(),
  useChainId: vi.fn(),
  useConnection: vi.fn(),
  useWriteContract: vi.fn(),
  useSignTypedData: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: mocks.usePublicClient,
  useChainId: mocks.useChainId,
  useConnection: mocks.useConnection,
  useWriteContract: mocks.useWriteContract,
  useSignTypedData: mocks.useSignTypedData,
}))
vi.mock('../adapters', () => ({ getAdaptersForChain: mocks.getAdaptersForChain }))

import { useStrategiesOpen } from './useStrategiesOpen'
import { clearAaveStaticsCache } from '../lib/aaveStatics'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const KYBER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as const
const STRAT = '0x000000000000000000000000000000000000BEEF' as const
/** Stand-ins for the reserve wiring `execute()` resolves before touching the wallet. */
const DATA_PROVIDER = '0x000000000000000000000000000000000000da7a' as const
const VDEBT = '0x000000000000000000000000000000000000deb0' as const

const RESERVES = {
  collateral: { address: WETH, symbol: 'WETH', decimals: 18, priceUsd: 250_000_000_000n, ltvBps: 7500n, liquidationThresholdBps: 8000n },
  debt: { address: USDC, symbol: 'USDC', decimals: 6, priceUsd: 100_000_000n, ltvBps: 8700n, liquidationThresholdBps: 8900n },
}

const INPUT = {
  contract: STRAT, mode: 1 as const, volatile: WETH, stable: USDC,
  sizing: {
    kind: 'derived' as const,
    marginAmount: 1_000_000_000_000_000_000n,
    leverageBps: 20_000n,
  },
  slippageBps: 50n,
  marginBalance: 10n ** 21n,
  existingCollateralUsd: 0n,
  existingDebtUsd: 0n,
  reserves: RESERVES,
}

/** A stub adapter whose quote is a fixed rate, and whose build re-simulates a shade worse. */
function stubAdapter(rateNumeratorPerWei: bigint): Adapter {
  return {
    name: 'KyberSwap',
    supportsExecution: true,
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

/**
 * A stub adapter whose achieved rate steps between calls (worse, then better) rather than
 * staying constant. A constant-rate stub always makes the re-size at the round that produced
 * the winning quote reproduce that quote's own amountIn exactly, which is why it cannot catch
 * drift between the reported borrowAmount and what swapData was actually built for.
 */
function stepRateAdapter(rateNumeratorPerWeiByCall: readonly bigint[]): Adapter {
  let calls = 0
  return {
    name: 'KyberSwap',
    supportsExecution: true,
    getQuote: vi.fn(async (_f: unknown, _t: unknown, amountIn: string) => {
      const rate = rateNumeratorPerWeiByCall[Math.min(calls, rateNumeratorPerWeiByCall.length - 1)]
      calls++
      return {
        aggregator: 'KyberSwap',
        amountIn,
        amountOut: (BigInt(amountIn) * rate).toString(),
        amountOutUsd: '0', gasUsd: '0', netReturnUsd: 0,
        routeDetails: { type: 'kyber' as const, totalAmountIn: BigInt(amountIn), paths: [] },
        rawQuote: {},
      }
    }),
    buildTransaction: vi.fn(async (q: { amountOut: string }) => ({
      to: KYBER, data: '0xdeadbeef', value: '0', spender: KYBER,
      amountOut: q.amountOut,
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // aaveStatics memoises the data provider and reserve-token reads across calls, keyed off
  // chainId + address — without clearing this, a later test's execute() could silently reuse
  // a value another test's readContract mock produced.
  clearAaveStaticsCache()
  mocks.useChainId.mockReturnValue(1)
  mocks.useConnection.mockReturnValue({ address: '0x1111111111111111111111111111111111111111' })
  // Real wagmi wiring, used whenever a test does not inject its own execute()-path deps.
  mocks.useWriteContract.mockReturnValue({ writeContractAsync: vi.fn() })
  mocks.useSignTypedData.mockReturnValue({ signTypedDataAsync: vi.fn() })
  mocks.usePublicClient.mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'paused') return 0n
      if (functionName === 'getAllowedRouters') return [KYBER]
      // Reserve wiring the execute() path resolves before anything wallet-facing: a data
      // provider address, then that reserve's [aToken, stableDebt, variableDebt] tuple.
      if (functionName === 'getPoolDataProvider') return DATA_PROVIDER
      if (functionName === 'getReserveTokensAddresses') return [WETH, USDC, VDEBT]
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

it('quotes and builds the debt-margin swap for borrowAmount + marginAmount, not borrowAmount alone', async () => {
  // AaveV3Strategies.sol's _open swaps `borrowAmount + (mode == MODE_OPEN_COLL ? 0 :
  // marginAmount)` — on the debt-margin path (mode 2 here: long, margin posted in the debt
  // asset) that is strictly more than borrowAmount alone. Quoting/building for borrowAmount
  // alone undersizes the trade by exactly marginAmount, so the output falls short of minOut
  // and the contract reverts InsufficientOutputFromRouter on every attempt.
  const adapter = stubAdapter(400_000_000n) // exactly the oracle rate for RESERVES — one round.
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  const debtMarginInput = {
    ...INPUT,
    mode: 2 as const,
    sizing: { kind: 'derived' as const, marginAmount: 1_000_000_000n, leverageBps: 20_000n }, // 1000 USDC
  }

  const { result } = renderHook(() => useStrategiesOpen(debtMarginInput))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  // adapter is typed as the real `Adapter` interface (see stubAdapter's return type), so
  // `.mock` needs vitest's own escape hatch to reach the underlying mock's call log.
  const quotedAmountIn = BigInt(vi.mocked(adapter.getQuote).mock.calls[0][2] as string)
  expect(quotedAmountIn).toBe(result.current.preview!.borrowAmount + debtMarginInput.sizing.marginAmount)
})

it('re-quotes once when the re-sized borrow grew, and stops there', async () => {
  // A rate worse than the oracle's makes the second sizing ask for more than was quoted.
  const adapter = stubAdapter(399_000_000n)
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  expect(adapter.getQuote).toHaveBeenCalledTimes(2)
})

it('reports no-client rather than hanging when the public client is unavailable', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])
  mocks.usePublicClient.mockReturnValue(undefined)

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.previewError).not.toBeNull())
  expect(result.current.previewError?.kind).toBe('no-client')
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
    useStrategiesOpen({
      ...INPUT,
      sizing: { ...INPUT.sizing, leverageBps: 39_200n }, // == the LTV ceiling
    }),
  )
  await waitFor(() => expect(result.current.previewError).not.toBeNull())
  expect(result.current.previewError?.kind).toBe('LEVERAGE_ABOVE_LTV')
})

it('reports the borrow amount that was actually quoted, not a later re-size', async () => {
  // Round 0 prices worse than the oracle, so the re-size grows and a second round fires.
  // Round 1 prices back at the oracle rate — better than round 0's — so the re-size against
  // it shrinks below round 1's own amountIn. swapData is built for round 1's amountIn; the
  // preview must report THAT borrow amount, not the smaller re-sized one, or the contract
  // approves less than the router calldata tries to pull.
  const adapter = stepRateAdapter([399_000_000n, 400_000_000n])
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  expect(adapter.getQuote).toHaveBeenCalledTimes(2)
  const winningAmountIn = BigInt(vi.mocked(adapter.getQuote).mock.calls[1][2] as string)
  expect(result.current.preview?.borrowAmount).toBe(winningAmountIn)
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

it('skips the signature prompt when an existing delegation already covers the borrow', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])
  const signTypedData = vi.fn()
  mocks.usePublicClient.mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'paused') return 0n
      if (functionName === 'getAllowedRouters') return [KYBER]
      if (functionName === 'getPoolDataProvider') return DATA_PROVIDER
      if (functionName === 'getReserveTokensAddresses') return [WETH, USDC, VDEBT]
      if (functionName === 'borrowAllowance') return 10_000_000_000n // covers 2512.56 USDC
      if (functionName === 'allowance') return 10n ** 30n // margin already approved
      return 0n
    }),
  })

  const { result } = renderHook(() => useStrategiesOpen(INPUT, { signTypedData }))
  await waitFor(() => expect(result.current.preview).not.toBeNull())
  await result.current.execute()
  // The `execute()` await resolves once the async function body returns, which is not the same
  // tick React flushes its last setState — poll rather than read `result.current` synchronously.
  await waitFor(() => expect(result.current.step).toBe('done'))

  expect(signTypedData).not.toHaveBeenCalled()
})

it('freezes the preview while a signature is held', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])
  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  const before = result.current.preview
  result.current.frozen.current = true
  result.current.refresh()
  // A refresh while frozen must not replace the plan the signature commits to.
  await waitFor(() => expect(result.current.preview).toBe(before))
})

it('invalidates the preview synchronously on an input change, before the debounce elapses', async () => {
  // A caller gates execution on `!preview` (and/or `isQuoting`). If the old preview survives
  // the whole DEBOUNCE_MS window after an input change, that gate stays open over amounts that
  // no longer match the inputs — a mismatch between what the UI shows and what execute() would
  // actually send, for the entire debounce window.
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])
  const { result, rerender } = renderHook(
    (props: typeof INPUT) => useStrategiesOpen(props),
    { initialProps: INPUT },
  )
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  rerender({
    ...INPUT,
    sizing: { ...INPUT.sizing, marginAmount: INPUT.sizing.marginAmount * 2n },
  })

  // Checked synchronously, deliberately not via waitFor: the whole point is that this holds
  // BEFORE the debounce timer has had any chance to fire.
  expect(result.current.preview).toBeNull()
})

it('quotes exactly once on the manual path, with the amounts as typed', async () => {
  const adapter = stubAdapter(400_000_000n)
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  const { result } = renderHook(() => useStrategiesOpen({
    ...INPUT,
    sizing: {
      kind: 'manual' as const,
      marginAmount: 1_000_000_000_000_000_000n,
      borrowAmount: 3_000_000_000n,
      flashAmount: 1_000_000_000_000_000_000n,
    },
  }))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  // The derived path re-quotes as sizeOpen converges on a rate. Manual has nothing to converge
  // on: amountIn is whatever the user typed, so a second round could only re-ask the same
  // question.
  expect(vi.mocked(adapter.getQuote)).toHaveBeenCalledTimes(1)
  expect(vi.mocked(adapter.getQuote).mock.calls[0][2]).toBe('3000000000')
  expect(result.current.preview?.flashAmount).toBe(1_000_000_000_000_000_000n)
  expect(result.current.preview?.borrowAmount).toBe(3_000_000_000n)
})

it('surfaces a manual shortfall as a preview error rather than a preview', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])

  const { result } = renderHook(() => useStrategiesOpen({
    ...INPUT,
    sizing: {
      kind: 'manual' as const,
      marginAmount: 1_000_000_000_000_000_000n,
      borrowAmount: 1_000_000n,   // 1 USDC buys nowhere near the 1 WETH flash
      flashAmount: 1_000_000_000_000_000_000n,
    },
  }))

  await waitFor(() => expect(result.current.previewError?.kind).toBe('SWAP_SHORTFALL'))
  expect(result.current.preview).toBeNull()
})
