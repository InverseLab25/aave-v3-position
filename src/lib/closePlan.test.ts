import { describe, it, expect } from 'vitest'
import { maxUint256, parseUnits, type Address } from 'viem'
import {
  planWithdrawal,
  computeMinOut,
  canReuseSignature,
  reuseBlocker,
  routeCostPercent,
  isSlippageShapedFailure,
  suggestWiderSlippage,
  type HeldSignature,
} from './closePlan'

const COLL = parseUnits('100', 18)

describe('planWithdrawal', () => {
  it('withdraws exactly what the swap pulls on a partial close', () => {
    const requiredIn = parseUnits('40', 18)
    const w = planWithdrawal({ requiredIn, collAmount: COLL })

    expect(w.drainAll).toBe(false)
    expect(w.collateralToWithdraw).toBe(requiredIn)
    expect(w.pullAmount).toBe(requiredIn)
  })

  it('resolves the drain sentinel to the live balance for reuse checks', () => {
    const w = planWithdrawal({ requiredIn: COLL, collAmount: COLL })
    expect(w.collateralToWithdraw).toBe(maxUint256)
    expect(w.pullAmount).toBe(COLL)
    // The permit must cover the pull even after a rebase.
    expect(w.permitValue).toBeGreaterThan(w.pullAmount)
  })

  it('uses the drain sentinel when the swap needs everything', () => {
    const w = planWithdrawal({ requiredIn: COLL, collAmount: COLL })

    expect(w.drainAll).toBe(true)
    expect(w.collateralToWithdraw).toBe(maxUint256)
    // A drain pulls the LIVE balance, which rebases upward, so the permit must exceed the
    // balance that was read.
    expect(w.permitValue).toBeGreaterThan(COLL)
  })

  it('grants headroom above the pull so a re-quote does not invalidate the permit', () => {
    const requiredIn = parseUnits('40', 18)
    const w = planWithdrawal({ requiredIn, collAmount: COLL })

    expect(w.permitValue).toBeGreaterThan(requiredIn)
  })

  it('never authorises more than the balance plus its rebase allowance', () => {
    // A swap needing almost everything: 5% headroom on top would exceed the balance.
    const requiredIn = (COLL * 99n) / 100n
    const w = planWithdrawal({ requiredIn, collAmount: COLL })

    const ceiling = COLL + (COLL * 5n) / 10000n
    expect(w.permitValue).toBeLessThanOrEqual(ceiling)
  })
})

describe('computeMinOut', () => {
  const SLIP_NUM = 9990n // 0.1%

  it('floors at the router guarantee, not merely at the debt', () => {
    // The reported case: 200 WETH quoted at ~375k USDT against a ~210k debt. A debt-only
    // floor would accept 250k and hand the user a six-figure loss without an error.
    const quotedOut = 374_913_369_311n
    const debt = 210_075_604_836n
    const minOut = computeMinOut({ debt, quotedOut, slipNum: SLIP_NUM })

    expect(minOut).toBe((quotedOut * SLIP_NUM) / 10000n)
    expect(minOut).toBeGreaterThan(debt)
  })

  it('never drops below the debt, which must always be repayable', () => {
    // A close sized tightly: the router guarantee lands under the debt.
    const debt = 1_000_000n
    const minOut = computeMinOut({ debt, quotedOut: 900_000n, slipNum: SLIP_NUM })
    expect(minOut).toBe(debt)
  })

  it('tightens as slippage tightens', () => {
    const quotedOut = 1_000_000n
    const tight = computeMinOut({ debt: 1n, quotedOut, slipNum: 9990n }) // 0.1%
    const loose = computeMinOut({ debt: 1n, quotedOut, slipNum: 9500n }) // 5%
    expect(tight).toBeGreaterThan(loose)
  })
})

describe('canReuseSignature', () => {
  const OWNER = '0x1111111111111111111111111111111111111111' as Address
  const ATOKEN = '0x2222222222222222222222222222222222222222' as Address
  const SPENDER = '0x3333333333333333333333333333333333333333' as Address
  const NOW = 1_000_000n

  const held: HeldSignature = {
    chainId: 1,
    owner: OWNER,
    aToken: ATOKEN,
    spender: SPENDER,
    nonce: 7n,
    value: parseUnits('42', 18),
    deadline: NOW + 300n,
    permit: { value: parseUnits('42', 18), deadline: NOW + 300n, v: 27, r: '0x', s: '0x' },
    revoke: { deadline: NOW + 300n, v: 27, r: '0x', s: '0x' },
  }

  const need = {
    chainId: 1,
    owner: OWNER,
    aToken: ATOKEN,
    spender: SPENDER,
    nonce: 7n,
    value: parseUnits('40', 18),
    nowSeconds: NOW,
  }

  it('reuses a signature that still covers the requirement', () => {
    expect(canReuseSignature(held, need)).toBe(true)
  })

  it('survives the small upward drift a re-quote produces', () => {
    // THE BUG: sized exactly, every 3-second refresh nudged `requiredIn` up a few wei and
    // invalidated the signature, so the user was asked to sign again on every tick.
    const drifted = { ...need, value: need.value + 1n }
    expect(canReuseSignature(held, drifted)).toBe(true)

    // And a whole percent of drift is still fine, because of the permit headroom.
    const driftedMore = { ...need, value: (need.value * 101n) / 100n }
    expect(canReuseSignature(held, driftedMore)).toBe(true)
  })

  it('refuses when the requirement outgrows what was signed', () => {
    expect(canReuseSignature(held, { ...need, value: held.value + 1n })).toBe(false)
  })

  it('refuses once the nonce has moved, which means it was already spent', () => {
    expect(canReuseSignature(held, { ...need, nonce: 8n })).toBe(false)
  })

  it('refuses too close to expiry to survive simulation and inclusion', () => {
    // 90 seconds left, under the 120s floor.
    expect(canReuseSignature(held, { ...need, nowSeconds: NOW + 210n })).toBe(false)
  })

  it('accepts while comfortably inside the validity window', () => {
    // 170 seconds left.
    expect(canReuseSignature(held, { ...need, nowSeconds: NOW + 130n })).toBe(true)
  })

  it('refuses across a different chain, owner, token or spender', () => {
    expect(canReuseSignature(held, { ...need, chainId: 8453 })).toBe(false)
    expect(canReuseSignature(held, { ...need, owner: SPENDER })).toBe(false)
    expect(canReuseSignature(held, { ...need, aToken: SPENDER })).toBe(false)
    expect(canReuseSignature(held, { ...need, spender: ATOKEN })).toBe(false)
  })

  it('compares addresses case-insensitively', () => {
    expect(canReuseSignature(held, { ...need, owner: OWNER.toUpperCase() as Address })).toBe(true)
  })

  it('refuses when nothing is held', () => {
    expect(canReuseSignature(null, need)).toBe(false)
  })
})

describe('planWithdrawal + canReuseSignature', () => {
  it('one signature covers a whole series of refreshed quotes', () => {
    // Sign against the first quote, then walk the size around by ±2% as the price moves.
    const first = planWithdrawal({ requiredIn: parseUnits('40', 18), collAmount: COLL })
    const OWNER = '0x1111111111111111111111111111111111111111' as Address
    const held: HeldSignature = {
      chainId: 1,
      owner: OWNER,
      aToken: OWNER,
      spender: OWNER,
      nonce: 1n,
      value: first.permitValue,
      deadline: 1000n,
      permit: { value: first.permitValue, deadline: 1000n, v: 27, r: '0x', s: '0x' },
      revoke: { deadline: 1000n, v: 27, r: '0x', s: '0x' },
    }

    // Spans the gap between sizeSwap's two paths: the oracle seed lands tight, the
    // probe-and-refine fallback overshoots, and one signature has to cover both.
    for (const pct of [90n, 98n, 100n, 102n, 110n, 120n]) {
      const requiredIn = (parseUnits('40', 18) * pct) / 100n
      const w = planWithdrawal({ requiredIn, collAmount: COLL })
      const reusable = canReuseSignature(held, {
        chainId: 1,
        owner: OWNER,
        aToken: OWNER,
        spender: OWNER,
        nonce: 1n,
        value: w.pullAmount,
        nowSeconds: 0n,
      })
      expect(reusable).toBe(true)
    }
  })
})

describe('routeCostPercent', () => {
  it('measures what the route gives up, from the real figures in a blob', () => {
    // RouteID 48352013ztFEk5uA, a real 200 WETH -> USDT route.
    const pct = routeCostPercent('374426.834331', '374174.947802')
    expect(pct).toBeCloseTo(0.0673, 3)
  })

  it('reports a gain as negative cost', () => {
    expect(routeCostPercent('100', '101')).toBeCloseTo(-1, 6)
  })

  it('returns null when either side is unpriced', () => {
    expect(routeCostPercent(undefined, '100')).toBeNull()
    expect(routeCostPercent('100', undefined)).toBeNull()
    expect(routeCostPercent('0', '100')).toBeNull()
    expect(routeCostPercent('abc', '100')).toBeNull()
  })
})

describe('isSlippageShapedFailure', () => {
  it('recognises the router revert we actually get', () => {
    expect(isSlippageShapedFailure('Return amount is not enough')).toBe(true)
  })

  it('recognises the API wordings for the same condition', () => {
    expect(isSlippageShapedFailure('amount out is smaller than min')).toBe(true)
    expect(isSlippageShapedFailure('minReturnAmount not met')).toBe(true)
  })

  it('does not claim unrelated failures', () => {
    expect(isSlippageShapedFailure('TransferHelper: TRANSFER_FROM_FAILED')).toBe(false)
    expect(isSlippageShapedFailure('execution reverted: Paused')).toBe(false)
  })
})

describe('suggestWiderSlippage', () => {
  const PRESETS = [0.1, 0.5, 1]

  it('steps up to the next preset', () => {
    expect(suggestWiderSlippage(0.1, PRESETS, 5)).toBe(0.5)
    expect(suggestWiderSlippage(0.5, PRESETS, 5)).toBe(1)
  })

  it('never suggests beyond the cap', () => {
    expect(suggestWiderSlippage(0.5, PRESETS, 0.6)).toBeNull()
  })

  it('returns null when already at the top', () => {
    expect(suggestWiderSlippage(1, PRESETS, 5)).toBeNull()
  })

  it('handles a custom value between presets', () => {
    expect(suggestWiderSlippage(0.3, PRESETS, 5)).toBe(0.5)
  })
})

describe('reuseBlocker', () => {
  const A = '0x1111111111111111111111111111111111111111' as Address
  const B = '0x2222222222222222222222222222222222222222' as Address
  const NOW = 1_000_000n
  const held: HeldSignature = {
    chainId: 1, owner: A, aToken: A, spender: A,
    nonce: 7n, value: parseUnits('42', 18), deadline: NOW + 420n,
    permit: { value: parseUnits('42', 18), deadline: NOW + 420n, v: 27, r: '0x', s: '0x' },
    revoke: { deadline: NOW + 420n, v: 27, r: '0x', s: '0x' },
  }
  const need = {
    chainId: 1, owner: A, aToken: A, spender: A,
    nonce: 7n, value: parseUnits('40', 18), nowSeconds: NOW,
  }

  it('reports no blocker when the signature is good', () => {
    expect(reuseBlocker(held, need)).toBeNull()
  })

  it('names a spent nonce', () => {
    expect(reuseBlocker(held, { ...need, nonce: 8n })).toMatch(/already spent/)
  })

  it('quantifies how far the pull outgrew the allowance', () => {
    const blocker = reuseBlocker(held, { ...need, value: (held.value * 101n) / 100n })
    expect(blocker).toMatch(/pull grew past the signed allowance by 1\.0/)
  })

  it('reports remaining validity when too close to expiry', () => {
    expect(reuseBlocker(held, { ...need, nowSeconds: NOW + 350n })).toMatch(/only 70s validity left/)
  })

  it('names a changed collateral', () => {
    expect(reuseBlocker(held, { ...need, aToken: B })).toBe('collateral changed')
  })

  it('a 300s usable window survives a 4-minute review', () => {
    // deadline = now + 420, margin = 120 -> reusable until now + 300.
    expect(reuseBlocker(held, { ...need, nowSeconds: NOW + 240n })).toBeNull()
  })
})
