import { describe, it, expect } from 'vitest'
import { parseUnits } from 'viem'
import { quoteRate } from './deleverage'

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
