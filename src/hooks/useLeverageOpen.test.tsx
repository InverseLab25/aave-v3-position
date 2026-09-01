import { beforeEach, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { useEffect, useState } from 'react'
import type { Address } from 'viem'

// Only the two on-chain preflight reads are mocked, plus wagmi. They are the first thing the
// quoting effect does, so counting `getPauseState` calls counts effect RUNS — which is exactly
// what this file is about. The adapters are left unmocked and simply find no route on the fake
// chain id, so each run stops after the preflight.
const mocks = vi.hoisted(() => ({
  getPauseState: vi.fn(),
  getAllowedRouters: vi.fn(),
  usePublicClient: vi.fn(),
  useChainId: vi.fn(),
  useConnection: vi.fn(),
  useWriteContract: vi.fn(),
  useSignTypedData: vi.fn(),
}))

vi.mock('../lib/strategies-sdk', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPauseState: mocks.getPauseState,
  getAllowedRouters: mocks.getAllowedRouters,
}))
vi.mock('wagmi', () => ({
  usePublicClient: mocks.usePublicClient,
  useChainId: mocks.useChainId,
  useConnection: mocks.useConnection,
  useWriteContract: mocks.useWriteContract,
  useSignTypedData: mocks.useSignTypedData,
}))

import { useLeverageOpen, type LeverageOpenInput } from './useLeverageOpen'

const COLLATERAL = '0x1111111111111111111111111111111111111111' as Address
const DEBT = '0x4444444444444444444444444444444444444444' as Address

/** A sizing-valid input, so the effect gets past `validateSizing` and reaches the reads. */
function makeInput(): LeverageOpenInput {
  return {
    contract: '0x000000000000000000000000000000000000BEEF' as Address,
    direction: 'long',
    marginAsset: 'collateral',
    subject: COLLATERAL,
    quote: DEBT,
    marginAmount: 10n * 10n ** 18n,
    sizedBy: 'supply',
    supplyAmount: 20n * 10n ** 18n,
    borrowAmount: 0n,
    maxSupply: 35n * 10n ** 18n,
    slippageBps: 50n,
    marginBalance: 100n * 10n ** 18n,
    existingCollateralUsd: 0n,
    existingDebtUsd: 0n,
    existingLtvBps: 0n,
    existingLiquidationThresholdBps: 0n,
    collateralEnablement: null,
    reserves: {
      collateral: {
        address: COLLATERAL, symbol: 'WETH', decimals: 18, priceUsd: 300_000_000_000n,
        ltvBps: 8000n, liquidationThresholdBps: 8300n,
      },
      debt: {
        address: DEBT, symbol: 'USDC', decimals: 6, priceUsd: 100_000_000n,
        ltvBps: 7700n, liquidationThresholdBps: 8000n,
      },
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.usePublicClient.mockReturnValue({})
  mocks.useChainId.mockReturnValue(8453)
  mocks.useConnection.mockReturnValue({ address: '0x000000000000000000000000000000000000dEaD' })
  mocks.useWriteContract.mockReturnValue({ writeContractAsync: vi.fn() })
  mocks.useSignTypedData.mockReturnValue({ signTypedDataAsync: vi.fn() })
  mocks.getPauseState.mockResolvedValue({ paused: false })
  mocks.getAllowedRouters.mockResolvedValue(['0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'])
})

/**
 * Rebuilds `input` on every render, exactly as LeveragePanel does — it composes the object inline
 * and relies on the caller comparing by value. Re-renders are driven from the test via `rerender`
 * so the count is deterministic and no state is set from an effect.
 */
function Harness() {
  const { isQuoting } = useLeverageOpen(makeInput())
  return <div data-testid="quoting">{String(isQuoting)}</div>
}

async function settle() {
  // Past the 400ms debounce, then let the awaited reads resolve.
  await act(async () => {
    vi.advanceTimersByTime(500)
  })
  await act(async () => {
    await vi.runOnlyPendingTimersAsync()
  })
}

it('does not re-quote when a re-render rebuilds an input of identical values', async () => {
  // The panel builds `input` fresh on every render. Keying the quoting effect on that object's
  // IDENTITY makes every render a new quote — and since a finished quote calls setPreview with a
  // new object, that render feeds the next quote: a self-sustaining loop that leaves `isQuoting`
  // true almost continuously and the Open button unclickable. The values here never change, so
  // exactly one quote is correct.
  const { rerender } = render(<Harness />)
  for (let i = 0; i < 5; i++) rerender(<Harness />)

  await settle()

  expect(mocks.getPauseState).toHaveBeenCalledTimes(1)
})

it('re-quotes when an input value actually changes', async () => {
  // The mirror: value-keying must not freeze the preview. A test that only asserted "once" would
  // pass just as well on an effect that never re-runs at all.
  function Changing() {
    const [supply, setSupply] = useState(20n * 10n ** 18n)
    useLeverageOpen({ ...makeInput(), supplyAmount: supply })
    useEffect(() => {
      const t = setTimeout(() => setSupply(21n * 10n ** 18n), 1000)
      return () => clearTimeout(t)
    }, [])
    return null
  }

  render(<Changing />)
  await settle()
  expect(mocks.getPauseState).toHaveBeenCalledTimes(1)

  await act(async () => {
    vi.advanceTimersByTime(1000)
  })
  await settle()

  expect(mocks.getPauseState).toHaveBeenCalledTimes(2)
})

it('does not quote while the panel is out of view', async () => {
  // The panel is not unmounted when the user switches to the DEX tab or backgrounds the browser:
  // AavePosition is hidden with `display: none` so an in-flight transaction's report survives.
  // Hidden it still re-keys on every background refetch of prices and balances, and each re-key
  // now costs a build and a simulation per candidate on top of the quotes — all of it for a
  // screen nobody is looking at.
  function Paused() {
    useLeverageOpen(makeInput(), undefined, { paused: true })
    return null
  }
  render(<Paused />)

  await settle()

  expect(mocks.getPauseState).not.toHaveBeenCalled()
})

it('quotes as soon as the panel comes back into view', async () => {
  // The mirror. Pausing that never resumes would leave the user reading a preview priced before
  // they left, which is worse than not quoting: it looks current and is not.
  function Resuming() {
    const [paused, setPaused] = useState(true)
    useLeverageOpen(makeInput(), undefined, { paused })
    useEffect(() => {
      const t = setTimeout(() => setPaused(false), 1000)
      return () => clearTimeout(t)
    }, [])
    return null
  }
  render(<Resuming />)

  await settle()
  expect(mocks.getPauseState).not.toHaveBeenCalled()

  await act(async () => {
    vi.advanceTimersByTime(1000)
  })
  await settle()

  expect(mocks.getPauseState).toHaveBeenCalledTimes(1)
})
