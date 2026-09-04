import { expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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
  expectedBasis: 'simulated' as const,
  expectedOut: 10n ** 18n,
  quotedOut: 10n ** 18n,
  minOut: 995n * 10n ** 15n,
  swapIn: 3_100_000_000n,
  collateralSymbol: 'WETH',
  debtSymbol: 'USDC',
  collateralDecimals: 18,
  debtDecimals: 6,
  slippageBps: 50n,
}

/** The inverse pair — a short, where collateral is USDC and debt is WETH. */
const INVERSE = {
  ...BASE,
  collateralSymbol: 'USDC',
  debtSymbol: 'WETH',
  collateralDecimals: 6,
  debtDecimals: 18,
  expectedBasis: 'simulated' as const,
  expectedOut: 3_100_000_000n,
  quotedOut: 3_100_000_000n,
  minOut: 3_084_500_000n,
  swapIn: 10n ** 18n,
}

it('quotes the expected rate from the route own amountOut', () => {
  render(<RouteDetails {...BASE} />)

  // 3,100 USDC for the 1 WETH the aggregator says it will deliver.
  expect(screen.getByText(/1 WETH = 3,100\.0000 USDC/)).toBeTruthy()
})

it('quotes the guaranteed rate from the same route after slippage', () => {
  render(<RouteDetails {...BASE} />)

  // The same 3,100 USDC against the 0.995 WETH floor — worse by exactly the tolerance, which is
  // the only thing that should separate the two rows now that both come off one route.
  expect(screen.getByText(/1 WETH = 3,115\.5779 USDC/)).toBeTruthy()
  // The row names the tolerance that produced it. Quoted debt-per-collateral the floor sits ABOVE
  // the expectation, so the label has to say so rather than claim a decrease.
  expect(screen.getByText('Guaranteed rate (+0.5%)')).toBeTruthy()
})

it('shows both legs of the swap with the floor alongside the expectation', () => {
  render(<RouteDetails {...BASE} />)

  expect(screen.getByText(/3,100\.0000 USDC → 1\.0000 WETH \(min 0\.9950\)/)).toBeTruthy()
})

it('picks whichever orientation puts the rate above 1, on either side of the pair', () => {
  // Quoted the way the props are shaped this is 1 USDC = 0.000322 WETH, which is unreadable; the
  // legible end of the same rate is the one that gets shown.
  render(<RouteDetails {...INVERSE} />)

  expect(screen.getByText(/1 WETH = 3,100\.0000 USDC/)).toBeTruthy()
  expect(screen.getByText(/1 WETH = 3,084\.5000 USDC/)).toBeTruthy()
  // This end of the pair falls with slippage, so here the minus sign is the literal one.
  expect(screen.getByText('Guaranteed rate (-0.5%)')).toBeTruthy()
})

it('keeps precision on a sub-1 rate instead of collapsing both rows onto one string', () => {
  render(<RouteDetails {...INVERSE} />)

  fireEvent.click(screen.getByLabelText('Flip rate direction'))

  // Four decimals would print both of these as "0.0003", which is the two rows agreeing on a
  // number neither of them holds. Significant digits keep the tolerance visible.
  expect(screen.getByText(/1 USDC = 0\.000322581 WETH/)).toBeTruthy()
  expect(screen.getByText(/1 USDC = 0\.000324202 WETH/)).toBeTruthy()
  expect(screen.getByText('Guaranteed rate (+0.5%)')).toBeTruthy()
})

it('flips back to the natural orientation on a second click', () => {
  render(<RouteDetails {...BASE} />)

  fireEvent.click(screen.getByLabelText('Flip rate direction'))
  expect(screen.getByText(/1 USDC = 0\.000322581 WETH/)).toBeTruthy()

  fireEvent.click(screen.getByLabelText('Flip rate direction'))
  expect(screen.getByText(/1 WETH = 3,100\.0000 USDC/)).toBeTruthy()
})

it('renders no guaranteed rate rather than a divide-by-zero when the route guarantees nothing', () => {
  render(<RouteDetails {...BASE} minOut={0n} />)

  expect(screen.queryByText(/Guaranteed rate/)).toBeNull()
  // The expectation stands on its own — it does not depend on any floor.
  expect(screen.getByText(/1 WETH = 3,100\.0000 USDC/)).toBeTruthy()
})

it('says nothing about the basis when the route was simulated', () => {
  // The ordinary case. A note on every open would be noise, and noise is what stops the
  // degraded case below from being noticed.
  render(<RouteDetails {...INVERSE} />)

  expect(screen.queryByText(/Not simulated/)).toBeNull()
})

it('warns when the expected rate is only the aggregator\'s own estimate', () => {
  // `built` and `quoted` both mean the simulator could not be reached, which the user can see
  // nowhere else — and it makes the expected rate a weaker promise than it looks.
  render(<RouteDetails {...INVERSE} expectedBasis="built" />)

  expect(screen.getByText(/Not simulated/)).toBeTruthy()
  // The floor is still enforced on chain either way, and the note has to say so or it reads as
  // "this trade is unprotected".
  expect(screen.getByText(/guaranteed rate below is still enforced/i)).toBeTruthy()
})

it('shows the quote beside the measurement, with how far apart they are', () => {
  // The aggregator claimed 1.0 WETH and the route really returns 0.996 — 0.4% of optimism the
  // user is about to sign against. Both rows, so the gap is visible rather than inferred.
  render(<RouteDetails {...INVERSE} expectedOut={996_000_000n} quotedOut={1_000_000_000n} />)

  expect(screen.getByText('Simulated rate')).toBeTruthy()
  expect(screen.getByText('Quoted rate')).toBeTruthy()
  expect(screen.getByText(/-0\.40%/)).toBeTruthy()
})

it('leaves the quote row out when nothing displaced it', () => {
  // On the `built` and `quoted` rungs `expectedOut` IS the quote. Printing it twice under two
  // labels would invent a second source that does not exist.
  render(<RouteDetails {...INVERSE} expectedBasis="quoted" quotedOut={1_000_000_000n} />)

  expect(screen.queryByText('Quoted rate')).toBeNull()
  expect(screen.getByText('Expected rate')).toBeTruthy()
})

it('leaves the quote row out when the two round to the same rate', () => {
  // Two identical rows read as two sources agreeing, when there is only one number.
  render(<RouteDetails {...INVERSE} />)

  expect(screen.queryByText('Quoted rate')).toBeNull()
})
