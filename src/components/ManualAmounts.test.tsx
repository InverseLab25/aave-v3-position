import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ManualAmounts } from './ManualAmounts'
import { manualOpenErrorMessage } from '../lib/manualOpen'

const PROPS = {
  supplyStr: '3.0',
  onSupplyChange: vi.fn(),
  collateralSymbol: 'WETH',
  debtSymbol: 'USDC',
  flashDisplay: '2.0',
  borrowDisplay: '5020',
  borrowIsEstimate: false,
  message: null,
}

it('takes only the supply, and shows the flash and borrow as derived', () => {
  render(<ManualAmounts {...PROPS} />)

  // The supply is the one editable field — the other two are consequences of it.
  expect(screen.getByLabelText('Supply amount')).toBeTruthy()
  expect(screen.queryByLabelText(/flash amount/i)).toBeNull()
  expect(screen.queryByLabelText(/debt amount/i)).toBeNull()

  expect(screen.getByText('2.0 WETH')).toBeTruthy()
  expect(screen.getByText('5020 USDC')).toBeTruthy()
})

it('reports edits as raw strings so the parent owns parsing', () => {
  const onSupplyChange = vi.fn()
  render(<ManualAmounts {...PROPS} onSupplyChange={onSupplyChange} />)
  fireEvent.change(screen.getByLabelText('Supply amount'), { target: { value: '4.5' } })
  expect(onSupplyChange).toHaveBeenCalledWith('4.5')
})

it('shows a dash rather than a stale figure before the derived amounts land', () => {
  render(<ManualAmounts {...PROPS} flashDisplay={null} borrowDisplay={null} />)
  // The figures from PROPS must not linger once the props say there is nothing to show.
  expect(screen.queryByText('2.0 WETH')).toBeNull()
  expect(screen.queryByText('5020 USDC')).toBeNull()
  expect(screen.getAllByText('—')).toHaveLength(2)
})

it('shows the validation message when there is one, and nothing when there is not', () => {
  // Derived from the real copy: a hard-coded string would keep passing if the message changed.
  const msg = manualOpenErrorMessage('SUPPLY_BELOW_MARGIN', {
    marginSymbol: 'WETH', collateralSymbol: 'WETH', marginBalance: '5.0',
  })

  const { rerender } = render(<ManualAmounts {...PROPS} />)
  expect(screen.queryByText(msg)).toBeNull()

  rerender(<ManualAmounts {...PROPS} message={msg} />)
  expect(screen.getByText(msg)).toBeTruthy()
})
