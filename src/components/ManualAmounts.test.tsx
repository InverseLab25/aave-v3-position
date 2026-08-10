import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ManualAmounts } from './ManualAmounts'

const PROPS = {
  borrowStr: '2000',
  onBorrowChange: vi.fn(),
  flashStr: '1.0',
  onFlashChange: vi.fn(),
  debtSymbol: 'USDC',
  collateralSymbol: 'WETH',
  message: null,
}

it('labels the two fields by what they borrow from', () => {
  render(<ManualAmounts {...PROPS} />)
  expect(screen.getByLabelText('Debt amount')).toBeTruthy()
  expect(screen.getByLabelText('Flash amount')).toBeTruthy()
  expect(screen.getByText(/borrow from Aave/i)).toBeTruthy()
  expect(screen.getByText(/flash from Morpho/i)).toBeTruthy()
})

it('reports edits as raw strings so the parent owns parsing', () => {
  const onBorrowChange = vi.fn()
  render(<ManualAmounts {...PROPS} onBorrowChange={onBorrowChange} />)
  fireEvent.change(screen.getByLabelText('Debt amount'), { target: { value: '2500' } })
  expect(onBorrowChange).toHaveBeenCalledWith('2500')
})

it('shows the shortfall message when there is one, and nothing when there is not', () => {
  const { rerender } = render(<ManualAmounts {...PROPS} />)
  expect(screen.queryByText(/short by/i)).toBeNull()

  rerender(<ManualAmounts {...PROPS} message="Short by 0.5 WETH." />)
  expect(screen.getByText('Short by 0.5 WETH.')).toBeTruthy()
})
