import { describe, it, expect } from 'vitest'
import { parseUnits } from 'viem'
import { quoteRate, validateSwapTx, selectBuildableRoute, TX_GAS_CAP_2_24 } from './deleverage'

const WETH = 18
const USDC = 6

describe('quoteRate', () => {
  it('prices a collateral with more decimals than the debt (WETH -> USDC)', () => {
    // 1 WETH in, 2000 USDC out.
    const rate = quoteRate(parseUnits('2000', USDC), parseUnits('1', WETH), WETH, USDC)
    expect(Number(rate)).toBe(2000)
  })

  it('prices a collateral with fewer decimals than the debt (USDC -> WETH)', () => {
    // 2000 USDC in, 1 WETH out — the reciprocal, and well below 1.
    const rate = quoteRate(parseUnits('1', WETH), parseUnits('2000', USDC), USDC, WETH)
    expect(Number(rate)).toBe(0.0005)
  })

  it('prices equal decimals', () => {
    const rate = quoteRate(parseUnits('3', WETH), parseUnits('2', WETH), WETH, WETH)
    expect(Number(rate)).toBe(1.5)
  })

  it('is unaffected by the swap size, only the price', () => {
    const small = quoteRate(parseUnits('2000', USDC), parseUnits('1', WETH), WETH, USDC)
    const large = quoteRate(parseUnits('2000000', USDC), parseUnits('1000', WETH), WETH, USDC)
    expect(small).toBe(large)
  })

  it('truncates rather than rounding', () => {
    // Exact quotient is 1.234567890123456789, which the working scale carries whole. Truncation
    // (not rounding up) is what keeps a displayed rate from overstating a route.
    const requiredIn = 1_000_000_000_000_000_000n // 1 WETH
    const expectedOut = 1_234_567_890_123_456_789n // in an 18-decimal debt token
    const rate = quoteRate(expectedOut, requiredIn, WETH, WETH)
    expect(rate).toBe('1.234567890123456789')
  })

  it('returns null when nothing is swapped', () => {
    expect(quoteRate(parseUnits('2000', USDC), 0n, WETH, USDC)).toBeNull()
  })

  it('carries a rate far below 1 instead of bottoming out at zero', () => {
    // One unit of a 6-decimal debt token for a million WETH — 1e-12, which a fixed six-decimal
    // scale could not represent at all.
    const rate = quoteRate(1n, parseUnits('1000000', WETH), WETH, USDC)
    expect(Number(rate)).toBe(1e-12)
  })

  it('keeps a sub-1 rate precise enough to invert', () => {
    // Arbitrum 0x4ed0dd94…: 67,754.40695 USDT in, 36.112335215858211266 WETH out. The rate is
    // 0.000532986…, so a six-decimal scale kept three significant digits — and inverting 0.000532
    // priced the fill at 1,879.70 USDT per WETH rather than the 1,876.21 it actually filled at.
    const rate = quoteRate(36_112_335_215_858_211_266n, 67_754_406_950n, USDC, WETH)

    expect(1 / Number(rate)).toBeCloseTo(1876.2122843899, 6)
  })
})

describe('validateSwapTx — per-transaction gas cap', () => {
  const ok = {
    to: '0xR', spender: '0xR', data: '0xdead', value: '0',
  }

  it('judges the aggregator\'s own figure, not a padded one', () => {
    // The bug: the adapter padded its gas 20% and this check compared the padded number to the
    // cap, so a 1M USDC route measuring 13.2M was rejected 5 times in 6 — the pad, not the
    // route, put it over. A pad is for SETTING a limit, where over-estimating is refunded. It
    // has no business in a decision, where over-estimating costs the trade.
    const underCap = (TX_GAS_CAP_2_24 - 1_000_000n).toString()
    expect(validateSwapTx({ ...ok, gasEstimate: underCap }, true, TX_GAS_CAP_2_24)).toBeNull()
  })

  it('rejects a route whose gas cannot fit in one transaction', () => {
    // Base and Ethereum both refuse a transaction above 2^24 at the node, before it is ever
    // mined — "gas limit too high". Catching it here costs a route; catching it at send costs
    // the user three signatures and a rejection they cannot act on.
    const problem = validateSwapTx(
      { ...ok, gasEstimate: (TX_GAS_CAP_2_24 + 1n).toString() },
      true,
      TX_GAS_CAP_2_24,
    )
    expect(problem).toMatch(/gas/i)
  })

  it('accepts a route sitting exactly on the cap', () => {
    // The cap is inclusive: 16,777,216 passes validation, 16,777,217 does not.
    expect(validateSwapTx({ ...ok, gasEstimate: TX_GAS_CAP_2_24.toString() }, true, TX_GAS_CAP_2_24))
      .toBeNull()
  })

  it('skips the check on a chain with no cap', () => {
    // Arbitrum accepts 40M in a single transaction. An undefined cap must not become zero.
    expect(validateSwapTx({ ...ok, gasEstimate: '40000000' }, true, undefined)).toBeNull()
  })

  it('skips the check when the aggregator returned no gas figure', () => {
    // Absent is not zero and not infinite — we simply cannot judge, so we let the route through
    // and leave it to the simulation that runs before sending.
    expect(validateSwapTx(ok, true, TX_GAS_CAP_2_24)).toBeNull()
  })

  it('ignores an unparseable gas figure rather than failing the route', () => {
    expect(validateSwapTx({ ...ok, gasEstimate: 'lots' }, true, TX_GAS_CAP_2_24)).toBeNull()
  })
})

describe('selectBuildableRoute — gas cap fallthrough', () => {
  it('falls through an over-cap route to the next candidate', async () => {
    const built: Record<string, { to: string; spender: string; data: string; value: string; gasEstimate: string }> = {
      big: { to: '0xR', spender: '0xR', data: '0xaa', value: '0', gasEstimate: '20000000' },
      small: { to: '0xR', spender: '0xR', data: '0xbb', value: '0', gasEstimate: '9000000' },
    }
    const { selected, rejected } = await selectBuildableRoute(['big', 'small'], {
      build: async (c) => built[c],
      isAllowlisted: () => true,
      label: (c) => c,
      txGasCap: TX_GAS_CAP_2_24,
    })

    expect(selected?.candidate).toBe('small')
    expect(rejected[0]).toContain('big')
    expect(rejected[0]).toMatch(/gas/i)
  })
})
