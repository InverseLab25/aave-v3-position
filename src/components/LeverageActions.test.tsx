import { afterEach, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  getStrategiesAddress: vi.fn(),
  useStrategiesOpen: vi.fn(),
  useChainId: vi.fn(),
}))

vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStrategiesAddress: mocks.getStrategiesAddress,
}))
vi.mock('../hooks/useStrategiesOpen', () => ({ useStrategiesOpen: mocks.useStrategiesOpen }))
vi.mock('wagmi', () => ({ useChainId: mocks.useChainId, useConnection: () => ({ address: undefined }) }))

import { LeverageActions } from './LeverageActions'

// This file renders more than once per describe block; vitest.config.ts does not set
// `test.globals`, so @testing-library/react's auto-cleanup never self-registers. See the
// same note in OpenPositionForm.test.tsx.
afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.useStrategiesOpen.mockReturnValue({
    preview: null, previewError: null, isQuoting: false,
    refresh: vi.fn(), frozen: { current: false },
    execute: vi.fn(), step: 'idle', txHash: undefined, execError: null,
  })
})

const PROPS = { suppliedAssets: [], availableReserves: [], viewAddress: undefined }

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
