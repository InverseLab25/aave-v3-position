import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { RateLine } from './RateLine'

/** The Arbitrum fill: 67,754.40695 USDT for 36.112335215858211266 WETH. */
const arbitrum = {
  srcSymbol: 'USDT',
  srcDecimals: 6,
  dstSymbol: 'WETH',
  dstDecimals: 18,
  spentAmount: 67_754_406_950n,
  returnAmount: 36_112_335_215_858_211_266n,
}

describe('RateLine', () => {
  it('quotes the volatile side when a stable paid for it', () => {
    // "1 WETH = 1,876 USDT" is the readable direction; "1 USDT = 0.000533 WETH" is not.
    render(<RateLine {...arbitrum} />)

    expect(screen.getByText(/1 WETH = 1,876\.2123 USDT/)).toBeTruthy()
  })

  it('flips direction when asked', () => {
    render(<RateLine {...arbitrum} />)

    fireEvent.click(screen.getByRole('button', { name: /swap rate direction/i }))

    expect(screen.getByText(/1 USDT = 0\.000532989 WETH/)).toBeTruthy()
  })

  it('inverts from the amounts rather than from the rounded rate', () => {
    // Dividing into a six-decimal 0.000532 gives 1,879.6992. The amounts say 1,876.2123.
    render(<RateLine {...arbitrum} />)

    expect(screen.queryByText(/1,879\.6992/)).toBeNull()
  })

  it('quotes a major per whatever bought it, whichever way the swap ran', () => {
    // WBTC in, WETH out. The swap's own direction would say "1 WBTC = 20 WETH"; the reading people
    // hold is the ETH price, so the major leg becomes the unit.
    render(
      <RateLine
        srcSymbol="WBTC" srcDecimals={8}
        dstSymbol="WETH" dstDecimals={18}
        spentAmount={5_000_000n} returnAmount={10n ** 18n}
      />,
    )

    expect(screen.getByText(/1 WETH = 0\.05 WBTC/)).toBeTruthy()
  })

  it('keeps the swap-s own direction when neither side is recognised', () => {
    render(
      <RateLine
        srcSymbol="LINK" srcDecimals={18}
        dstSymbol="UNI" dstDecimals={18}
        spentAmount={2n * 10n ** 18n} returnAmount={10n ** 18n}
      />,
    )

    expect(screen.getByText(/1 LINK = 0\.5 UNI/)).toBeTruthy()
  })

  it('says nothing at all when a leg is zero', () => {
    // No ratio exists in EITHER direction, so there is no price to stateand a zero would be a lie.
    const { container } = render(<RateLine {...arbitrum} spentAmount={0n} />)

    expect(container.firstChild).toBeNull()
  })
})
