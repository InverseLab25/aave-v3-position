import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RouteDetails } from './RouteDetails'

/**
 * A long on WETH against USDC: the contract borrows USDC and swaps it for WETH, so the swap
 * spends `swapIn` of the DEBT asset and receives COLLATERAL.
 *
 * `swapIn` is the borrow PLUS any margin posted in the debt asset, since both go into the one
 * swap — a rate quoted against the borrow alone reads far better than the market.
 *
 * `expectedOut` is the aggregator's own `amountOut`; `minOut` is that less the 50 bps slippage
 * tolerance. 3,100 USDC buys 1 WETH expected, 0.995 WETH guaranteed.
 */
const BASE = {
  expectedOut: 10n ** 18n,
  minOut: 995n * 10n ** 15n,
  swapIn: 3_100_000_000n,
  collateralSymbol: 'WETH',
  debtSymbol: 'USDC',
  collateralDecimals: 18,
  debtDecimals: 6,
  slippageBps: 50n,
}

it('quotes the expected rate from the route own amountOut', () => {
  render(<RouteDetails {...BASE} />)

  // 3,100 USDC for the 1 WETH the aggregator says it will deliver.
  expect(screen.getByText(/1 WETH = 3,100\.00 USDC/)).toBeTruthy()
})

it('quotes the guaranteed rate from the same route after slippage', () => {
  render(<RouteDetails {...BASE} />)

  // The same 3,100 USDC against the 0.995 WETH floor — worse by exactly the tolerance, which is
  // the only thing that should separate the two rows now that both come off one route.
  expect(screen.getByText(/1 WETH = 3,115\.58 USDC/)).toBeTruthy()
  // The row names the tolerance that produced it, so the gap is self-explaining.
  expect(screen.getByText('Guaranteed rate (-0.5%)')).toBeTruthy()
})

it('shows both legs of the swap with the floor alongside the expectation', () => {
  render(<RouteDetails {...BASE} />)

  expect(screen.getByText(/3,100\.0000 USDC → 1\.0000 WETH \(min 0\.9950\)/)).toBeTruthy()
})

it('keeps precision on a sub-1 rate instead of rounding it to zero', () => {
  // The inverse pair — a short, where collateral is USDC and debt is WETH. At 2dp both rates
  // would print "1 USDC = 0.00 WETH", which is worse than showing nothing.
  render(
    <RouteDetails
      {...BASE}
      collateralSymbol="USDC"
      debtSymbol="WETH"
      collateralDecimals={6}
      debtDecimals={18}
      expectedOut={3_100_000_000n}
      minOut={3_084_500_000n}
      swapIn={10n ** 18n}
    />,
  )

  expect(screen.getByText(/1 USDC = 0\.000323 WETH/)).toBeTruthy()
  expect(screen.getByText(/1 USDC = 0\.000324 WETH/)).toBeTruthy()
})

it('renders no guaranteed rate rather than a divide-by-zero when the route guarantees nothing', () => {
  render(<RouteDetails {...BASE} minOut={0n} />)

  expect(screen.queryByText(/Guaranteed rate/)).toBeNull()
  // The expectation stands on its own — it does not depend on any floor.
  expect(screen.getByText(/1 WETH = 3,100\.00 USDC/)).toBeTruthy()
})
