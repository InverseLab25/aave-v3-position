import { describe, it, expect } from 'vitest'
import { preferInverted, statedRate } from './swapRoute'

describe('preferInverted', () => {
  it('prices the volatile leg per stable when a stable is being sold', () => {
    // Selling USDC for WETH reads as "1 WETH = 2,444 USDC", never "1 USDC = 0.000409 WETH".
    // Which reading is legible depends on the pair, not on the direction the swap runs.
    expect(preferInverted('USDC', 'WETH')).toBe(true)
  })

  it('leaves a sale of the volatile leg in the swap\'s own direction', () => {
    expect(preferInverted('WETH', 'USDC')).toBe(false)
  })

  it('reads case-insensitively, since symbols arrive as the chain spells them', () => {
    expect(preferInverted('usdc', 'weth')).toBe(true)
  })

  it('leaves a pair it recognises neither side of alone', () => {
    // A wrong answer here costs a reader one glance, so guessing beats blocking — but guessing
    // in the swap's own direction is the honest default.
    expect(preferInverted('AERO', 'BRETT')).toBe(false)
  })
})

describe('statedRate', () => {
  const USDC_INTO_WETH = {
    srcSymbol: 'USDC', dstSymbol: 'WETH', srcDecimals: 6, dstDecimals: 18,
    spentAmount: 1_000_000_000_000n, // 1,000,000 USDC
  }

  it('states a stable-for-volatile swap as the price of the volatile leg', () => {
    // The reported bug: "1 USDC = 0.000409 WETH" is arithmetically fine and unreadable.
    const shown = statedRate({ ...USDC_INTO_WETH, returnAmount: 409_000_000_000_000_000_000n })

    expect(shown?.unit).toBe('WETH')
    expect(shown?.quote).toBe('USDC')
    expect(Number(shown?.rate)).toBeCloseTo(2444.98, 1)
  })

  it('inverts from the amounts, not by dividing an already-rounded rate', () => {
    // Dividing into the rounded 0.000409 gives 2444.99; the amounts give 2444.987775. Rounding
    // twice is what turned a 0.000532989 fill into 1,879.6992 instead of 1,876.2123 once before.
    const shown = statedRate({ ...USDC_INTO_WETH, returnAmount: 409_000_000_000_000_000_000n })

    expect(Number(shown?.rate)).toBeCloseTo(2444.987775, 4)
  })

  it('leaves a volatile-for-stable swap in its own direction', () => {
    const shown = statedRate({
      srcSymbol: 'WETH', dstSymbol: 'USDC', srcDecimals: 18, dstDecimals: 6,
      spentAmount: 10n ** 18n, returnAmount: 2_444_000_000n,
    })

    expect(shown?.unit).toBe('WETH')
    expect(shown?.quote).toBe('USDC')
    expect(Number(shown?.rate)).toBeCloseTo(2444, 1)
  })

  it('makes the worse fill the BIGGER number once inverted', () => {
    // The trap. Un-inverted, a worse fill is a smaller rate; inverted it is a larger one, and a
    // "worst rate" line that moved the wrong way would read as the better of the two.
    const expected = statedRate({ ...USDC_INTO_WETH, returnAmount: 409_000_000_000_000_000_000n })
    const worst = statedRate({ ...USDC_INTO_WETH, returnAmount: 408_000_000_000_000_000_000n })

    expect(Number(worst?.rate)).toBeGreaterThan(Number(expected?.rate))
  })

  it('has no rate to state when a leg is zero', () => {
    // Zero has no ratio in EITHER direction, so this cannot be left to the divisor guard alone —
    // that would report the other direction as a flat zero.
    expect(statedRate({ ...USDC_INTO_WETH, returnAmount: 0n })).toBeNull()
    expect(statedRate({ ...USDC_INTO_WETH, spentAmount: 0n, returnAmount: 1n })).toBeNull()
  })
})

describe('statedRate — the other reading', () => {
  const SWAP = {
    srcSymbol: 'USDC', dstSymbol: 'WETH', srcDecimals: 6, dstDecimals: 18,
    spentAmount: 1_000_000_000_000n, returnAmount: 409_000_000_000_000_000_000n,
  }

  it('carries both readings, so a flip in the UI does not divide a rounded number', () => {
    // The toggle has to show the same fact from the other end, not an approximation of it. Both
    // come off the amounts here, once, rather than the UI inverting what it was handed.
    const shown = statedRate(SWAP)!

    expect(shown.inverse.unit).toBe('USDC')
    expect(shown.inverse.quote).toBe('WETH')
    expect(Number(shown.inverse.rate)).toBeCloseTo(0.000409, 6)
  })
})
