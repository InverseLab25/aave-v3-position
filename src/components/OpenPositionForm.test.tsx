import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { OpenPositionForm } from './OpenPositionForm'

// This file renders more than once, unlike PositionPreview.test.tsx's null-render second case —
// vitest.config.ts does not set `test.globals`, so @testing-library/react's auto-cleanup (which
// only self-registers when it finds a global `afterEach`) never kicks in. Clean up explicitly.
afterEach(cleanup)

const BASE = {
  marginStr: '1.0', onMarginChange: vi.fn(), marginBalance: '4.2', marginSymbol: 'WETH',
  marginIn: 'collateral' as const, onMarginInChange: vi.fn(),
  collateralSymbol: 'WETH', debtSymbol: 'USDC',
  leverageBps: 20_000n, onLeverageChange: vi.fn(),
  ltvBps: 7500n, liquidationThresholdBps: 8000n,
  dangerEnabled: false, onDangerToggle: vi.fn(),
}

it('caps the slider at the soft health-factor ceiling by default', () => {
  render(<OpenPositionForm {...BASE} />)
  // WETH at LT 80% holds HF 1.5 up to 2.14x.
  expect(screen.getByRole('slider').getAttribute('max')).toBe('21428')
})

it('extends the slider to just below the hard LTV wall once the danger zone is enabled', () => {
  render(<OpenPositionForm {...BASE} dangerEnabled />)
  // hard is 39200 (3.92x) but is EXCLUSIVE — sizeOpen rejects leverageBps >= ceiling — so the
  // slider's max is one 100bps step below it: 39100.
  expect(screen.getByRole('slider').getAttribute('max')).toBe('39100')
})

it('keeps the slider max strictly below the hard LTV wall (WETH: LTV 7500 -> hard 39200)', () => {
  render(<OpenPositionForm {...BASE} dangerEnabled />)
  const max = Number(screen.getByRole('slider').getAttribute('max'))
  expect(max).toBeLessThan(39200)
})

it('disables the control entirely when the reserve has no valid LTV', () => {
  render(<OpenPositionForm {...BASE} ltvBps={10_000n} />)
  expect(screen.getByRole('slider').hasAttribute('disabled')).toBe(true)
})

it('shows the margin balance as the ceiling for the amount', () => {
  render(<OpenPositionForm {...BASE} />)
  expect(screen.getByText(/max 4\.2 WETH/i)).toBeTruthy()
})
