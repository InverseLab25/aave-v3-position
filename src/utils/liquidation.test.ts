import { describe, it, expect } from 'vitest'
import { computeLiquidationView } from './liquidation'

describe('computeLiquidationView — single volatile collateral, stablecoin debt', () => {
  // 100 WETH @ $3,740 with LT 0.825 backing $209,824 of USDC debt.
  // Weighted collateral = 100 * 3740 * 0.825 = 308,550  ->  HF = 1.4706
  // Liquidation when 100 * p * 0.825 = 209,824  ->  p = 209824 / 82.5 = 2543.3212
  const collateral = [
    { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
  ]

  it('returns the price WETH must fall to for HF to reach 1', () => {
    const view = computeLiquidationView(collateral, 209824)
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0].symbol).toBe('WETH')
    expect(view.rows[0].liquidationPriceUsd).toBeCloseTo(2543.3212, 3)
  })

  it('reports the buffer as a negative fraction of the current price', () => {
    const view = computeLiquidationView(collateral, 209824)
    expect(view.rows[0].bufferPct).toBeCloseTo(-0.3199676, 6)
    expect(view.rows[0].currentPriceUsd).toBe(3740)
  })

  it('marks WETH as volatile', () => {
    const view = computeLiquidationView(collateral, 209824)
    expect(view.rows[0].isVolatile).toBe(true)
  })
})

describe('computeLiquidationView — assets that cannot liquidate the position', () => {
  it('returns null when the other collateral already covers the debt', () => {
    // WETH weighted = 308,550; USDC weighted = 320,000; total = 628,550 vs $100k debt.
    // Either asset alone could fall to zero and the other would still cover it.
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'USDC', amount: 400000, priceUsd: 1, liquidationThreshold: 0.8 },
      ],
      100000,
    )
    expect(view.rows.map(r => r.liquidationPriceUsd)).toEqual([null, null])
    expect(view.rows.map(r => r.bufferPct)).toEqual([null, null])
  })

  it('returns null for an asset with a zero liquidation threshold', () => {
    // WETH carries no liquidation weight, so no WETH price can save or sink the position.
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0 },
        { symbol: 'USDC', amount: 400000, priceUsd: 1, liquidationThreshold: 0.8 },
      ],
      400000,
    )
    const weth = view.rows.find(r => r.symbol === 'WETH')
    expect(weth?.liquidationPriceUsd).toBeNull()
  })

  it('skips assets with a zero balance or a missing price', () => {
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'GHOST', amount: 0, priceUsd: 500, liquidationThreshold: 0.7 },
        { symbol: 'NOPRICE', amount: 10, priceUsd: 0, liquidationThreshold: 0.7 },
      ],
      209824,
    )
    expect(view.rows.map(r => r.symbol)).toEqual(['WETH'])
  })

  it('returns an empty view when there is no debt', () => {
    const view = computeLiquidationView(
      [{ symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 }],
      0,
    )
    expect(view.rows).toEqual([])
    expect(view.marketWideDropPct).toBeNull()
  })

  it('returns an empty view when there is no usable collateral', () => {
    expect(computeLiquidationView([], 100000).rows).toEqual([])
  })
})

describe('computeLiquidationView — row ordering', () => {
  it('puts the asset needing the smallest price drop first, nulls last', () => {
    // Weighted: WETH 308,550 + USDC 800 + cbBTC 336,000 = 645,350 vs $400k debt.
    // WETH  liq price = (400000 - 336800) / 82.5 = 766.06  -> buffer -0.7952
    // cbBTC liq price = (400000 - 309350) / 3.5  = 25900.00 -> buffer -0.7302
    // cbBTC needs the smaller fall, so it must lead. USDC cannot liquidate -> last.
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'USDC', amount: 1000, priceUsd: 1, liquidationThreshold: 0.8 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
      ],
      400000,
    )
    expect(view.rows.map(r => r.symbol)).toEqual(['cbBTC', 'WETH', 'USDC'])
  })
})
