import { describe, it, expect, vi } from 'vitest'
import { parseUnits } from 'viem'
import { sizeSwap, oracleSeed } from './sizing'
import { CloseError } from './deleverage'
import type { QuoteResponse } from '../adapters/types'

/** A quote at `amountIn` returning `amountOut`. Only the fields sizing reads are populated. */
const quote = (amountIn: bigint, amountOut: bigint): QuoteResponse => ({
  aggregator: 'KyberSwap',
  amountIn: amountIn.toString(),
  amountOut: amountOut.toString(),
  amountOutUsd: '0',
  gasUsd: '0',
  netReturnUsd: 0,
  rawQuote: {},
  routeDetails: { type: 'kyber', totalAmountIn: amountIn, paths: [] },
})

const COLL = 10n ** 18n * 10n // 10 collateral tokens
const DEBT = 10n ** 18n * 1000n // 1000 debt tokens
const NEEDED = (DEBT * 10050n) / 10000n // +0.5% accrual buffer
const SLIP_NUM = 9990n // 0.1% slippage

/** A linear market: every unit of collateral is worth `price` units of debt. */
const linear = (price: bigint) => async (amountIn: bigint) => [quote(amountIn, amountIn * price)]

describe('sizeSwap', () => {
  it('sizes to a fraction of the collateral when the position is well covered', async () => {
    const result = await sizeSwap({
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
      quoteAt: linear(500n), // 10 coll -> 5000 debt, debt is 1000
    })

    expect(result.covered).toBe(true)
    expect(result.guaranteed).toBe(true)
    expect(result.requiredIn).toBeLessThan(COLL)
    // Guaranteed output must clear the buffered debt, not merely the raw debt.
    expect(result.minDebtOut).toBeGreaterThanOrEqual(NEEDED)
  })

  it('drains and reports covered=false when the position is underwater', async () => {
    const result = await sizeSwap({
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
      quoteAt: linear(50n), // 10 coll -> 500 debt, short of the 1000 debt
    })

    expect(result.covered).toBe(false)
    expect(result.guaranteed).toBe(false)
    expect(result.requiredIn).toBe(COLL)
  })

  it('throws a pair-kind error when nothing routes', async () => {
    const err = await sizeSwap({
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
      quoteAt: async () => [],
    }).catch((e) => e)

    expect(err).toBeInstanceOf(CloseError)
    expect((err as CloseError).kind).toBe('pair')
  })

  // ---- Flaw ①: requiredIn must always describe a size that was actually quoted ----

  it('never returns a requiredIn that was not quoted, even when rounds are exhausted', async () => {
    // A market that keeps coming up just short, so the loop scales up every round and never
    // converges. Before the fix, the last iteration advanced requiredIn past the size `best`
    // was quoted at and exited, leaving the withdrawal and the router calldata disagreeing.
    const seen: bigint[] = []
    const quoteAt = async (amountIn: bigint) => {
      seen.push(amountIn)
      // Always 1% below what this size would need to satisfy `needed`.
      const needAtThisSize = (NEEDED * 10000n) / SLIP_NUM
      return [quote(amountIn, (needAtThisSize * 99n) / 100n)]
    }

    const result = await sizeSwap({
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
      quoteAt,
    })

    expect(BigInt(result.best.amountIn)).toBe(result.requiredIn)
    expect(seen).toContain(result.requiredIn)
  })

  it('keeps requiredIn consistent with best on the drain fallback', async () => {
    // First quote succeeds at full size; the refining quote fails entirely.
    let call = 0
    const quoteAt = async (amountIn: bigint) => {
      call += 1
      return call === 1 ? [quote(amountIn, amountIn * 500n)] : []
    }

    const result = await sizeSwap({
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
      quoteAt,
    })

    expect(result.requiredIn).toBe(COLL)
    expect(BigInt(result.best.amountIn)).toBe(result.requiredIn)
  })

  it('rejects a quote whose amountIn exceeds the available collateral', async () => {
    const quoteAt = async () => [quote(COLL * 2n, DEBT * 10n)]

    const err = await sizeSwap({
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
      quoteAt,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(CloseError)
    expect((err as CloseError).message).toMatch(/unusable input amount/)
  })

  it('rejects a zero amountIn rather than passing it to the contract', async () => {
    const quoteAt = async () => [quote(0n, DEBT * 2n)]

    const err = await sizeSwap({
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
      quoteAt,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(CloseError)
  })

  // ---- Flaw ②: the gate must be `needed`, not `debt` ----

  it('refuses a plan that covers the debt but not the accrual buffer', async () => {
    // Guaranteed output lands strictly between `debt` and `needed` — the band that used to
    // pass the gate and then revert on-chain once interest accrued.
    const between = DEBT + (NEEDED - DEBT) / 2n
    const quotedOut = (between * 10000n) / SLIP_NUM // so that guaranteedOut(quotedOut) ≈ between
    const quoteAt = async (amountIn: bigint) => [quote(amountIn, quotedOut)]

    const result = await sizeSwap({
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
      quoteAt,
    })

    expect(result.minDebtOut).toBeGreaterThanOrEqual(DEBT)
    expect(result.minDebtOut).toBeLessThan(NEEDED)
    expect(result.guaranteed).toBe(false)
  })

  // ---- User-chosen swap size ----

  describe('fixedIn', () => {
    const base = {
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
    }

    it('quotes exactly the requested amount and does not solve for a size', async () => {
      const quoteAt = vi.fn(linear(500n))
      const chosen = COLL / 2n

      const result = await sizeSwap({ ...base, quoteAt, fixedIn: chosen })

      expect(result.requiredIn).toBe(chosen)
      // One call, not the full-collateral probe plus refinement rounds.
      expect(quoteAt).toHaveBeenCalledTimes(1)
      expect(quoteAt).toHaveBeenCalledWith(chosen)
    })

    it('allows swapping far more than the debt needs, to convert collateral', async () => {
      // The whole point of the override: dump all collateral into the debt asset. Output is
      // 5000 against a 1000 debt, and that surplus is what the contract forwards to the user.
      const result = await sizeSwap({ ...base, quoteAt: linear(500n), fixedIn: COLL })

      expect(result.requiredIn).toBe(COLL)
      expect(result.covered).toBe(true)
      expect(result.guaranteed).toBe(true)
      expect(result.expectedOut).toBeGreaterThan(DEBT)
    })

    it('reports not-covered when the chosen amount cannot repay the debt', async () => {
      // 1% of the collateral, priced at 500 -> 50 debt tokens against a 1000 debt.
      const result = await sizeSwap({ ...base, quoteAt: linear(500n), fixedIn: COLL / 100n })

      expect(result.covered).toBe(false)
      expect(result.guaranteed).toBe(false)
    })

    it('rejects an amount larger than the supplied collateral', async () => {
      const err = await sizeSwap({
        ...base,
        quoteAt: linear(500n),
        fixedIn: COLL + 1n,
      }).catch((e) => e)

      expect(err).toBeInstanceOf(CloseError)
      expect((err as CloseError).message).toMatch(/more collateral than you have/)
    })

    it('rejects a zero amount', async () => {
      const err = await sizeSwap({ ...base, quoteAt: linear(500n), fixedIn: 0n }).catch((e) => e)
      expect(err).toBeInstanceOf(CloseError)
    })

    it('still refuses a size whose guaranteed output misses the accrual buffer', async () => {
      const between = DEBT + (NEEDED - DEBT) / 2n
      const quotedOut = (between * 10000n) / SLIP_NUM
      const result = await sizeSwap({
        ...base,
        quoteAt: async (amountIn: bigint) => [quote(amountIn, quotedOut)],
        fixedIn: COLL / 2n,
      })

      expect(result.guaranteed).toBe(false)
    })
  })

  // ---- Oracle seeding: one call per refresh instead of two ----

  describe('seedIn', () => {
    const base = {
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
    }

    /** A seed generous enough to clear `needed` on a market priced at 500. */
    const goodSeed = ((NEEDED * 10000n) / SLIP_NUM / 500n) * 2n

    it('answers in a single call when the seed already clears the requirement', async () => {
      const quoteAt = vi.fn(linear(500n))

      const result = await sizeSwap({ ...base, quoteAt, seedIn: goodSeed })

      expect(quoteAt).toHaveBeenCalledTimes(1)
      expect(quoteAt).toHaveBeenCalledWith(goodSeed)
      expect(result.guaranteed).toBe(true)
      expect(result.covered).toBe(true)
      expect(result.requiredIn).toBe(goodSeed)
    })

    it('falls back to the full probe when the seed comes up short', async () => {
      const quoteAt = vi.fn(linear(500n))
      // Far too small to repay the debt — the oracle disagreeing with the route must cost a
      // round, not produce an undersized swap.
      const result = await sizeSwap({ ...base, quoteAt, seedIn: COLL / 1000n })

      expect(quoteAt.mock.calls.length).toBeGreaterThan(1)
      expect(quoteAt).toHaveBeenCalledWith(COLL) // the probe still happens
      expect(result.guaranteed).toBe(true)
      expect(result.minDebtOut).toBeGreaterThanOrEqual(NEEDED)
    })

    it('ignores a seed at or above the full collateral', async () => {
      const quoteAt = vi.fn(linear(500n))
      await sizeSwap({ ...base, quoteAt, seedIn: COLL })
      // Seeding the whole balance is the probe, so it must not be treated as a shortcut
      // that skips coverage detection.
      expect(quoteAt).toHaveBeenCalledWith(COLL)
    })

    it('is overridden by an explicit user amount', async () => {
      const quoteAt = vi.fn(linear(500n))
      const chosen = COLL / 4n

      const result = await sizeSwap({ ...base, quoteAt, seedIn: goodSeed, fixedIn: chosen })

      expect(result.requiredIn).toBe(chosen)
      expect(quoteAt).toHaveBeenCalledTimes(1)
      expect(quoteAt).toHaveBeenCalledWith(chosen)
    })
  })

  describe('oracleSeed', () => {
    it('sizes collateral from the two oracle prices', async () => {
      // 1000 debt tokens (18dp) at $1, collateral at $2000 -> ~0.5 collateral, plus margins.
      const seed = oracleSeed({
        needed: parseUnits('1000', 18),
        slipNum: 10000n, // no slippage, to isolate the price maths
        collateralDecimals: 18,
        debtDecimals: 18,
        collateralPrice: parseUnits('2000', 8),
        debtPrice: parseUnits('1', 8),
      })
      const asNumber = Number(seed) / 1e18
      // 0.5 plus the 0.3% seed margin.
      expect(asNumber).toBeGreaterThan(0.5)
      expect(asNumber).toBeLessThan(0.51)
    })

    it('handles mismatched decimals', async () => {
      // 2000 USDC (6dp) of debt at $1, collateral WETH at $2000 -> ~1 WETH.
      const seed = oracleSeed({
        needed: parseUnits('2000', 6),
        slipNum: 10000n,
        collateralDecimals: 18,
        debtDecimals: 6,
        collateralPrice: parseUnits('2000', 8),
        debtPrice: parseUnits('1', 8),
      })
      const asNumber = Number(seed) / 1e18
      expect(asNumber).toBeGreaterThan(1)
      expect(asNumber).toBeLessThan(1.01)
    })

    it('widens the seed as slippage widens', async () => {
      const args = {
        needed: parseUnits('1000', 18),
        collateralDecimals: 18,
        debtDecimals: 18,
        collateralPrice: parseUnits('2000', 8),
        debtPrice: parseUnits('1', 8),
      }
      const tight = oracleSeed({ ...args, slipNum: 9990n })! // 0.1%
      const loose = oracleSeed({ ...args, slipNum: 9900n })! // 1%
      expect(loose).toBeGreaterThan(tight)
    })

    it('returns undefined when a price is missing', async () => {
      expect(
        oracleSeed({
          needed: parseUnits('1000', 18),
          slipNum: 10000n,
          collateralDecimals: 18,
          debtDecimals: 18,
          collateralPrice: 0n,
          debtPrice: parseUnits('1', 8),
        }),
      ).toBeUndefined()
    })
  })

  it('stops quoting as soon as a size satisfies the requirement', async () => {
    const quoteAt = vi.fn(linear(500n))

    await sizeSwap({
      collAmount: COLL,
      debt: DEBT,
      needed: NEEDED,
      slipNum: SLIP_NUM,
      rounds: 3,
      quoteAt,
    })

    // One full-collateral quote to gauge price, one verification at the sized amount.
    // The conservative estimate means refinement rounds should not fire on a linear market.
    expect(quoteAt).toHaveBeenCalledTimes(2)
  })
})
