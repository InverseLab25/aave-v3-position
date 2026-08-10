import { expect, it, vi } from 'vitest'
import { solveBorrow } from './solveBorrow'
import type { SolveBorrowInput } from './solveBorrow'
import type { QuoteResponse } from '../adapters/types'

// WETH collateral at $2,000 (8dp oracle), USDC debt at $1. 18 and 6 decimals.
const BASE: Omit<SolveBorrowInput, 'quoteAt'> = {
  flashAmount: 10n ** 18n, // 1 WETH to repay
  debtMargin: 0n,
  slipNum: 9_950n, // 0.5% slippage
  rounds: 3,
  collateralPriceUsd: 200_000_000_000n,
  debtPriceUsd: 100_000_000n,
  collateralDecimals: 18,
  debtDecimals: 6,
}

/** A router at a fixed rate: `outPerInWad` collateral wei out per debt wei in, scaled by 1e18. */
function routerAt(outPerInWad: bigint) {
  return vi.fn(async (amountIn: bigint): Promise<QuoteResponse[]> => [
    {
      aggregator: 'KyberSwap',
      amountIn: amountIn.toString(),
      amountOut: ((amountIn * outPerInWad) / 10n ** 18n).toString(),
      amountOutUsd: '0',
      gasUsd: '0',
      netReturnUsd: 0,
      routeDetails: { type: 'kyber' as const, totalAmountIn: amountIn, paths: [] },
      rawQuote: {},
    } as unknown as QuoteResponse,
  ])
}

// 1 WETH per 2,000 USDC => 1e18 collateral wei per 2e9 debt wei => 5e8 collateral wei per debt
// wei, WAD-scaled. This is exactly the oracle-implied rate, so the seed lands in one round.
const ORACLE_RATE_WAD = 500_000_000n * 10n ** 18n

it('solves the borrow that repays the flash, in one round when the oracle agrees', async () => {
  const quoteAt = routerAt(ORACLE_RATE_WAD)
  const r = await solveBorrow({ ...BASE, quoteAt })

  expect(r.ok).toBe(true)
  if (!r.ok) return
  // One call: the seed already clears the flash, so no refinement round is spent.
  expect(quoteAt).toHaveBeenCalledTimes(1)
  // Guaranteed output (after slippage) must cover the whole flash — that is the point.
  expect(r.solved.minCollateralOut).toBeGreaterThanOrEqual(BASE.flashAmount)
  expect(r.solved.borrowAmount).toBe(r.solved.swapIn)
})

it('refines upward when the route prices worse than the oracle', async () => {
  // 20% worse than oracle: the seed cannot clear the flash and must be scaled up.
  const quoteAt = routerAt((ORACLE_RATE_WAD * 80n) / 100n)
  const r = await solveBorrow({ ...BASE, quoteAt })

  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(quoteAt.mock.calls.length).toBeGreaterThan(1)
  expect(r.solved.minCollateralOut).toBeGreaterThanOrEqual(BASE.flashAmount)
})

it('subtracts debt-asset margin from the borrow, since it is inside the same swap', async () => {
  const quoteAt = routerAt(ORACLE_RATE_WAD)
  const withoutMargin = await solveBorrow({ ...BASE, quoteAt })
  const withMargin = await solveBorrow({ ...BASE, debtMargin: 500_000_000n, quoteAt })

  if (!withoutMargin.ok || !withMargin.ok) throw new Error('expected both to solve')
  // The swap input is the same either way — the margin just pays for part of it.
  expect(withMargin.solved.swapIn).toBe(withoutMargin.solved.swapIn)
  expect(withMargin.solved.borrowAmount).toBe(withoutMargin.solved.borrowAmount - 500_000_000n)
})

it('reads the size back off the winning quote, not the loop bookkeeping', async () => {
  // A router that rounds its own amountIn down — the answer must follow the calldata.
  const quoteAt = vi.fn(async (amountIn: bigint): Promise<QuoteResponse[]> => {
    const settled = (amountIn / 1_000_000n) * 1_000_000n
    return [{
      aggregator: 'KyberSwap',
      amountIn: settled.toString(),
      amountOut: ((settled * ORACLE_RATE_WAD) / 10n ** 18n).toString(),
      amountOutUsd: '0', gasUsd: '0', netReturnUsd: 0,
      routeDetails: { type: 'kyber' as const, totalAmountIn: settled, paths: [] },
      rawQuote: {},
    } as unknown as QuoteResponse]
  })

  const r = await solveBorrow({ ...BASE, quoteAt })
  if (!r.ok) throw new Error('expected a solve')
  expect(r.solved.swapIn).toBe(BigInt(r.solved.best.amountIn))
})

it('rejects a zero flash rather than quoting for nothing', async () => {
  const quoteAt = routerAt(ORACLE_RATE_WAD)
  const r = await solveBorrow({ ...BASE, flashAmount: 0n, quoteAt })
  expect(r).toMatchObject({ ok: false, error: 'ZERO_FLASH' })
  expect(quoteAt).not.toHaveBeenCalled()
})

it('rejects a missing price rather than dividing by zero', async () => {
  const quoteAt = routerAt(ORACLE_RATE_WAD)
  const r = await solveBorrow({ ...BASE, debtPriceUsd: 0n, quoteAt })
  expect(r).toMatchObject({ ok: false, error: 'ZERO_RATE' })
  expect(quoteAt).not.toHaveBeenCalled()
})

it('reports no route rather than returning a stale quote', async () => {
  const quoteAt = vi.fn(async () => [])
  const r = await solveBorrow({ ...BASE, quoteAt })
  expect(r).toMatchObject({ ok: false, error: 'NO_ROUTE' })
})

it('gives up rather than looping forever when the route will not converge', async () => {
  // Output is constant regardless of input, so scaling up never helps.
  const quoteAt = vi.fn(async (amountIn: bigint): Promise<QuoteResponse[]> => [{
    aggregator: 'KyberSwap',
    amountIn: amountIn.toString(),
    amountOut: '1',
    amountOutUsd: '0', gasUsd: '0', netReturnUsd: 0,
    routeDetails: { type: 'kyber' as const, totalAmountIn: amountIn, paths: [] },
    rawQuote: {},
  } as unknown as QuoteResponse])

  const r = await solveBorrow({ ...BASE, rounds: 2, quoteAt })
  expect(r).toMatchObject({ ok: false, error: 'NOT_CONVERGING' })
  // Bounded: it does not keep asking forever.
  expect(quoteAt.mock.calls.length).toBeLessThanOrEqual(3)
})

it('refuses when the debt-asset margin alone already covers the swap', async () => {
  const quoteAt = routerAt(ORACLE_RATE_WAD)
  // A margin far larger than the swap needs leaves nothing to borrow, and the contract
  // reverts ZeroAmount on a zero borrow.
  const r = await solveBorrow({ ...BASE, debtMargin: 10n ** 12n, quoteAt })
  expect(r).toMatchObject({ ok: false, error: 'NOT_CONVERGING' })
})
