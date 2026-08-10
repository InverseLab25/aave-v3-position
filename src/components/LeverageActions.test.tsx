import { expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { AvailableReserve } from '../hooks/useAavePositions'

const mocks = vi.hoisted(() => ({
  getStrategiesAddress: vi.fn(),
  useStrategiesOpen: vi.fn(),
  useChainId: vi.fn(),
  useReadContract: vi.fn(),
}))

vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStrategiesAddress: mocks.getStrategiesAddress,
}))
vi.mock('../hooks/useStrategiesOpen', () => ({ useStrategiesOpen: mocks.useStrategiesOpen }))
vi.mock('wagmi', () => ({
  useChainId: mocks.useChainId,
  useConnection: () => ({ address: undefined }),
  useReadContract: mocks.useReadContract,
}))

import { LeverageActions } from './LeverageActions'

// Auto-cleanup between renders comes from vitest.config.ts's `setupFiles` (src/test-setup.ts)
// repo-wide; no local afterEach(cleanup) needed here.

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.useReadContract.mockReturnValue({ data: undefined })
  mocks.useStrategiesOpen.mockReturnValue({
    preview: null, previewError: null, isQuoting: false,
    refresh: vi.fn(), frozen: { current: false },
    execute: vi.fn(), step: 'idle', txHash: undefined, execError: null, execRemedy: null,
  })
})

const PROPS = {
  suppliedAssets: [], availableReserves: [], viewAddress: undefined,
  existingCollateralUsd: 0n, existingDebtUsd: 0n,
  existingLtvBps: 0n, existingLiquidationThresholdBps: 0n,
}

const WETH: AvailableReserve = {
  symbol: 'WETH', underlyingAsset: '0x1111111111111111111111111111111111111111',
  decimals: 18, priceInUsd: '2500', apy: 0, borrowApy: 0,
  variableDebtTokenAddress: '0x2222222222222222222222222222222222222222',
  aTokenAddress: '0x3333333333333333333333333333333333333333',
  liquidationThreshold: 0.8,
  raw: { ltvBps: 7500n, liquidationThresholdBps: 8000n, priceUsd: 250_000_000_000n, decimals: 18 },
}

const USDC: AvailableReserve = {
  symbol: 'USDC', underlyingAsset: '0x4444444444444444444444444444444444444444',
  decimals: 6, priceInUsd: '1', apy: 0, borrowApy: 0,
  variableDebtTokenAddress: '0x5555555555555555555555555555555555555555',
  aTokenAddress: '0x6666666666666666666666666666666666666666',
  liquidationThreshold: 0.85,
  raw: { ltvBps: 8700n, liquidationThresholdBps: 8900n, priceUsd: 100_000_000n, decimals: 6 },
}

// A tight-LTV reserve whose soft (HF 1.5) ceiling sits BELOW the panel's 2.00x default —
// exactly the case the default is not universally safe for.
const TIGHT: AvailableReserve = {
  symbol: 'TIGHT', underlyingAsset: '0x7777777777777777777777777777777777777777',
  decimals: 18, priceInUsd: '2000', apy: 0, borrowApy: 0,
  variableDebtTokenAddress: '0x8888888888888888888888888888888888888888',
  aTokenAddress: '0x9999999999999999999999999999999999999999',
  liquidationThreshold: 0.65,
  raw: { ltvBps: 6000n, liquidationThresholdBps: 6500n, priceUsd: 200_000_000_000n, decimals: 18 },
}

it('clamps the default leverage down to the soft ceiling on mount, for a reserve where 2.00x is unsafe', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  // TIGHT's soft ceiling (HF 1.5) is maxLeverageForHealthFactorBps(6500, 15000) = 17647bps —
  // below the 20_000n (2.00x) the panel otherwise starts at.
  render(<LeverageActions {...PROPS} availableReserves={[TIGHT, USDC]} />)
  expect(screen.getByText('1.76x')).toBeTruthy()
  expect(screen.queryByText('2.00x')).toBeNull()
})

it('clamps leverage back down when the danger-zone toggle turns off', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  render(<LeverageActions {...PROPS} availableReserves={[WETH, USDC]} />)

  // Opt into the danger zone, drag past the soft (2.14x) ceiling, then opt back out.
  // Addressed by label, not by role: the manual-entry unlock is a second checkbox in this form.
  fireEvent.click(screen.getByLabelText(/allow leverage above/i))
  fireEvent.change(screen.getByRole('slider'), { target: { value: '30000' } })
  expect(screen.getByText('3.00x')).toBeTruthy()

  fireEvent.click(screen.getByLabelText(/allow leverage above/i))
  // Lowering the slider's `max` alone does not lower this state — the DOM clamps the thumb,
  // but sizeOpen still receives 3.00x unless the state itself is clamped back down.
  expect(screen.queryByText('3.00x')).toBeNull()
  expect(screen.getByText('2.14x')).toBeTruthy()
})

it('renders nothing while the contract is undeployed', () => {
  mocks.getStrategiesAddress.mockReturnValue(null)
  const { container } = render(<LeverageActions {...PROPS} />)
  expect(container.firstChild).toBeNull()
})

it('renders nothing while viewing another address', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  const { container } = render(<LeverageActions {...PROPS} viewAddress="0xabc" />)
  expect(container.firstChild).toBeNull()
})

it('shows Long and Short, with Boost and Repay present but disabled', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  render(<LeverageActions {...PROPS} />)
  expect(screen.getByText('Long')).toBeTruthy()
  expect(screen.getByText('Short')).toBeTruthy()
  expect(screen.getByRole('tab', { name: /boost/i }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('tab', { name: /repay/i }).hasAttribute('disabled')).toBe(true)
})

it('disables the action and explains when the contract is paused', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  mocks.useStrategiesOpen.mockReturnValue({
    preview: null, previewError: { kind: 'paused', message: 'Leverage is paused.' },
    isQuoting: false, refresh: vi.fn(), frozen: { current: false },
    execute: vi.fn(), step: 'idle', txHash: undefined, execError: null,
  })
  render(<LeverageActions {...PROPS} />)
  expect(screen.getByText(/paused/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: /open position/i }).hasAttribute('disabled')).toBe(true)
})

it('hides the leverage slider and forces manual entry in ratchet mode', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  render(<LeverageActions {...PROPS} />)

  fireEvent.click(screen.getByRole('button', { name: /no margin/i }))

  expect(screen.queryByRole('slider')).toBeNull()
  expect(screen.queryByLabelText('Margin amount')).toBeNull()
  // Manual is not optional here — there is nothing to derive from.
  expect(screen.queryByLabelText(/enter amounts manually/i)).toBeNull()
  expect(screen.getByLabelText('Debt amount')).toBeTruthy()
  expect(screen.getByLabelText('Flash amount')).toBeTruthy()
})

// The single highest-consequence expression in the panel: `mode` decides which asset becomes
// collateral and which becomes debt. Every test here mocks `useStrategiesOpen`, so nothing else
// in the suite observes `mode` at all — transposing 3<->4 or 5<->6 would leave the suite green
// while opening the WRONG position. Asserted on the argument, not on rendered output, because
// the mapping has no visible representation.
//
// Long  => collateral is the volatile reserve (WETH), debt is the stable one (USDC).
// Short => the pair swaps: collateral is USDC, debt is WETH.
const MODE_CASES = [
  { direction: 'Long', payWith: 'WETH', role: 'collateral', mode: 1 },
  { direction: 'Long', payWith: 'USDC', role: 'debt', mode: 2 },
  { direction: 'Short', payWith: 'WETH', role: 'debt', mode: 3 },
  { direction: 'Short', payWith: 'USDC', role: 'collateral', mode: 4 },
  { direction: 'Long', payWith: 'No margin', role: 'none', mode: 5 },
  { direction: 'Short', payWith: 'No margin', role: 'none', mode: 6 },
] as const

it.each(MODE_CASES)(
  'sizes $direction with margin in the $role asset ($payWith) as mode $mode',
  ({ direction, payWith, mode }) => {
    mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
    render(<LeverageActions {...PROPS} availableReserves={[WETH, USDC]} />)

    // The sidebar buttons' accessible names carry their blurb too, hence the anchored regex.
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${direction}\\b`) }))
    fireEvent.click(screen.getByRole('button', { name: payWith }))
    // Ratchet has no margin field, and needs none: zero amounts still parse, so the sizing —
    // and therefore `mode` — reaches the hook regardless.
    if (payWith !== 'No margin') {
      fireEvent.change(screen.getByLabelText('Margin amount'), { target: { value: '1' } })
    }

    const input = mocks.useStrategiesOpen.mock.calls.at(-1)?.[0]
    expect(input?.mode).toBe(mode)
  },
)

it('keeps the slider and hides the manual fields until they are unlocked', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  render(<LeverageActions {...PROPS} />)

  expect(screen.getByRole('slider')).toBeTruthy()
  expect(screen.queryByLabelText('Debt amount')).toBeNull()

  fireEvent.click(screen.getByLabelText(/enter amounts manually/i))
  expect(screen.getByLabelText('Debt amount')).toBeTruthy()
  // The slider stays: it is what seeded the amounts now showing.
  expect(screen.getByRole('slider')).toBeTruthy()
})
