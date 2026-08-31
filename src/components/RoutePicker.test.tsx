import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RoutePicker } from './RoutePicker'

const routes = [
  { aggregator: 'KyberSwap', amountOut: '2120.3621' },
  { aggregator: 'Nordstern', amountOut: '2119.9000' },
]

describe('RoutePicker', () => {
  it('stays out of the way when only one aggregator answered', () => {
    // A picker with nothing to pick reads as a decision the user has to make before continuing.
    const { container } = render(
      <RoutePicker routes={routes.slice(0, 1)} symbol="USDC" pinned={null} onPin={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('marks the winner as active while nothing is pinned', () => {
    render(<RoutePicker routes={routes} symbol="USDC" pinned={null} onPin={vi.fn()} />)

    expect(screen.getByRole('button', { name: /KyberSwap/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /Nordstern/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('moves the active row to the pin, even though the pin prices worse', () => {
    render(<RoutePicker routes={routes} symbol="USDC" pinned="Nordstern" onPin={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Nordstern/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /KyberSwap/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('shows how far behind the winner each other route is', () => {
    render(<RoutePicker routes={routes} symbol="USDC" pinned={null} onPin={vi.fn()} />)

    // (2120.3621 − 2119.9) / 2120.3621 = 0.0218%
    expect(screen.getByText('−0.02%')).toBeTruthy()
  })

  it('reports a pin, and hands the choice back through "Use best"', () => {
    const onPin = vi.fn()
    const { rerender } = render(
      <RoutePicker routes={routes} symbol="USDC" pinned={null} onPin={onPin} />,
    )
    // Nothing to reset to while the ranking is already deciding.
    expect(screen.queryByText('Use best')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Nordstern/ }))
    expect(onPin).toHaveBeenCalledWith('Nordstern')

    rerender(<RoutePicker routes={routes} symbol="USDC" pinned="Nordstern" onPin={onPin} />)
    fireEvent.click(screen.getByText('Use best'))
    expect(onPin).toHaveBeenLastCalledWith(null)
  })

  it('takes no clicks while a quote is in flight', () => {
    // The list is about to be replaced, so a click landing now pins a row from the old prices.
    const onPin = vi.fn()
    render(<RoutePicker routes={routes} symbol="USDC" pinned={null} onPin={onPin} disabled />)

    fireEvent.click(screen.getByRole('button', { name: /Nordstern/ }))
    expect(onPin).not.toHaveBeenCalled()
  })
})
