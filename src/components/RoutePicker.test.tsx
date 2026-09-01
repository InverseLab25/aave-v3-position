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

describe('RoutePicker — measured against quoted', () => {
  it('shows what a route was measured to return alongside what it claimed', () => {
    // The gap between the two is the only thing on screen saying whether an aggregator's own
    // number can be taken at face value. A quote is self-reported and nothing on this path can
    // check it; the measurement is a balance delta against live state.
    render(
      <RoutePicker
        routes={[
          { aggregator: 'KyberSwap', amountOut: '364.1774', measuredOut: '364.0219' },
          { aggregator: 'Nordstern', amountOut: '364.0140', measuredOut: '364.0101' },
        ]}
        symbol="WETH"
        pinned={null}
        onPin={vi.fn()}
      />,
    )

    expect(screen.getByText(/364\.0219/)).toBeTruthy()
    expect(screen.getByText(/364\.1774/)).toBeTruthy()
  })

  it('shows the quote alone for a route nothing measured', () => {
    // Rejected before the build, so there is no measurement — and inventing one, or hiding the
    // row, would both say more than is known.
    render(
      <RoutePicker
        routes={[
          { aggregator: 'KyberSwap', amountOut: '364.1774', measuredOut: '364.0219' },
          { aggregator: 'Nordstern', amountOut: '364.0140' },
        ]}
        symbol="WETH"
        pinned={null}
        onPin={vi.fn()}
      />,
    )

    expect(screen.getByText(/364\.0140 WETH/)).toBeTruthy()
  })

  it('measures the shortfall between rows on the measured figures', () => {
    // Comparing a measured winner against a quoted runner-up measures the aggregators' honesty,
    // not the routes — and the percentage would move when nobody's price had.
    render(
      <RoutePicker
        routes={[
          { aggregator: 'KyberSwap', amountOut: '400', measuredOut: '200' },
          { aggregator: 'Nordstern', amountOut: '399', measuredOut: '100' },
        ]}
        symbol="WETH"
        pinned={null}
        onPin={vi.fn()}
      />,
    )

    expect(screen.getByText(/−50\.00%/)).toBeTruthy()
  })
})
