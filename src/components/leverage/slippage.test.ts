import { describe, expect, it } from 'vitest'
import { MAX_SLIPPAGE_PERCENT, toSlippageBps } from './slippage'

describe('toSlippageBps', () => {
  it('converts a percent to basis points', () => {
    expect(toSlippageBps(0.5)).toBe(50n)
    expect(toSlippageBps(1)).toBe(100n)
    expect(toSlippageBps(0.1)).toBe(10n)
  })

  it('rounds to whole basis points — the contract has no finer unit', () => {
    // 0.005% is half a bp. Rounding down to 0 would silently mean "no tolerance at all", so it
    // rounds to the nearest, and anything under a quarter bp lands on zero honestly.
    expect(toSlippageBps(0.005)).toBe(1n)
    expect(toSlippageBps(0.004)).toBe(0n)
  })

  it('floors at zero rather than letting a negative widen the guarantee', () => {
    // A negative would raise `BPS - slippageBps` above BPS, making minOut EXCEED the route's own
    // output — a floor no route could ever clear, so every open would revert.
    expect(toSlippageBps(-1)).toBe(0n)
  })

  it('caps at the maximum, so the floor can never collapse to nothing', () => {
    // At 100% `BPS - slippageBps` is zero and minOut falls to the flash floor, which means
    // signing a swap with no output guarantee of its own. The cap keeps that unreachable.
    expect(toSlippageBps(100)).toBe(toSlippageBps(MAX_SLIPPAGE_PERCENT))
    expect(toSlippageBps(MAX_SLIPPAGE_PERCENT)).toBeLessThan(10_000n)
  })

  it('treats an unparseable entry as zero rather than NaN', () => {
    // The field hands over `parseFloat('') === NaN`; BigInt(NaN) throws, which would take the
    // whole panel down mid-keystroke.
    expect(toSlippageBps(Number.NaN)).toBe(0n)
  })
})
