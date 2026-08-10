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
    // Only WETH is quoted: USDC is a stablecoin, so its liquidation price is unreachable noise.
    expect(view.rows.map(r => r.symbol)).toEqual(['WETH'])
    expect(view.rows.map(r => r.liquidationPriceUsd)).toEqual([null])
    expect(view.rows.map(r => r.bufferPct)).toEqual([null])
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
  it('puts the asset needing the smallest price drop first', () => {
    // Weighted: WETH 308,550 + USDC 800 + cbBTC 336,000 = 645,350 vs $400k debt.
    // WETH  liq price = (400000 - 336800) / 82.5 = 766.06  -> buffer -0.7952
    // cbBTC liq price = (400000 - 309350) / 3.5  = 25900.00 -> buffer -0.7302
    // cbBTC needs the smaller fall, so it must lead. USDC is a stablecoin, so it carries its
    // weight in the totals above but is not quoted a row of its own.
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'USDC', amount: 1000, priceUsd: 1, liquidationThreshold: 0.8 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
      ],
      400000,
    )
    expect(view.rows.map(r => r.symbol)).toEqual(['cbBTC', 'WETH'])
  })

  it('sorts assets that cannot liquidate the position last', () => {
    // cbBTC carries no liquidation weight, so no cbBTC price can sink the position.
    const view = computeLiquidationView(
      [
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0 },
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
      ],
      200000,
    )
    expect(view.rows.map(r => r.symbol)).toEqual(['WETH', 'cbBTC'])
    expect(view.rows.at(-1)?.liquidationPriceUsd).toBeNull()
  })
})

describe('computeLiquidationView — market-wide correlated drop', () => {
  it('is null with a single volatile collateral (identical to that row)', () => {
    const view = computeLiquidationView(
      [{ symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 }],
      209824,
    )
    expect(view.marketWideDropPct).toBeNull()
  })

  it('is null when all collateral is stablecoins', () => {
    const view = computeLiquidationView(
      [
        { symbol: 'USDC', amount: 400000, priceUsd: 1, liquidationThreshold: 0.8 },
        { symbol: 'USDT', amount: 100000, priceUsd: 1, liquidationThreshold: 0.75 },
      ],
      100000,
    )
    expect(view.marketWideDropPct).toBeNull()
  })

  it('computes the shared fall across two volatile collaterals', () => {
    // weightedVolatile = 308,550 + 336,000 = 644,550 ; no stables ; debt 400,000
    // f = 400000 / 644550 = 0.6205880  ->  drop = -0.3794120
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
      ],
      400000,
    )
    expect(view.marketWideDropPct).toBeCloseTo(-0.3794120, 6)
  })

  it('excludes stablecoin collateral from the volatile weight', () => {
    // weightedStable = 80,000 ; weightedVolatile = 644,550 ; debt 500,000
    // f = (500000 - 80000) / 644550 = 0.6516174  ->  drop = -0.3483826
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
        { symbol: 'USDC', amount: 100000, priceUsd: 1, liquidationThreshold: 0.8 },
      ],
      500000,
    )
    expect(view.marketWideDropPct).toBeCloseTo(-0.3483826, 6)
  })

  it('is null when stablecoin collateral alone already covers the debt', () => {
    // weightedStable = 320,000 > debt 100,000, so no fall in volatile prices liquidates.
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
        { symbol: 'USDC', amount: 400000, priceUsd: 1, liquidationThreshold: 0.8 },
      ],
      100000,
    )
    expect(view.marketWideDropPct).toBeNull()
  })

  it('requires a smaller fall than any single asset falling alone', () => {
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
      ],
      400000,
    )
    const worstSingle = Math.min(...view.rows.map(r => Math.abs(r.bufferPct as number)))
    expect(Math.abs(view.marketWideDropPct as number)).toBeLessThan(worstSingle)
  })
})

describe('computeLiquidationView — debt-side rows', () => {
  // The shape a short takes: stablecoin collateral, volatile debt. A collateral-only view
  // answers the wrong question here — USDC falling is not what liquidates this position.
  const collateral = [{ symbol: 'USDC', amount: 1000, priceUsd: 1, liquidationThreshold: 0.78 }]
  const debt = [{ symbol: 'WETH', amount: 0.01, priceUsd: 2000 }]

  it('returns the price the borrowed asset must RISE to', () => {
    // Weighted collateral is 1,000 × 0.78 = 780, against 0.01 WETH of debt: 780 / 0.01 = 78,000.
    const view = computeLiquidationView(collateral, 20, debt)
    const weth = view.rows.find(r => r.symbol === 'WETH')
    expect(weth?.side).toBe('debt')
    expect(weth?.liquidationPriceUsd).toBeCloseTo(78_000, 6)
  })

  it('reports the buffer as a POSITIVE fraction — a rise, not a fall', () => {
    const view = computeLiquidationView(collateral, 20, debt)
    expect(view.rows.find(r => r.symbol === 'WETH')?.bufferPct).toBeGreaterThan(0)
  })

  it('drops the stablecoin collateral row — it is the noise this replaces', () => {
    // USDC would have to fall to $0.026, which is not a risk anyone is managing. It still
    // carries its full weight in the WETH price solved above.
    const view = computeLiquidationView(collateral, 20, debt)
    expect(view.rows.map(r => r.symbol)).toEqual(['WETH'])
  })

  it('orders by how far the price has to move, whichever way it moves', () => {
    // A volatile collateral needing a 20% fall leads a volatile debt needing a 50% rise.
    const view = computeLiquidationView(
      [{ symbol: 'WETH', amount: 100, priceUsd: 2000, liquidationThreshold: 0.8 }],
      120_000,
      [{ symbol: 'WBTC', amount: 1, priceUsd: 60_000 }],
    )
    expect(view.rows.map(r => r.symbol)).toEqual(['WETH', 'WBTC'])
    expect(view.rows[0].bufferPct).toBeLessThan(0)
    expect(view.rows[1].bufferPct).toBeGreaterThan(0)
  })

  it('excludes debt already past the weighted collateral', () => {
    // $900 of other debt against $780 of weighted collateral: this leg cannot be what tips it.
    const view = computeLiquidationView(
      collateral, 920, [{ symbol: 'WETH', amount: 0.01, priceUsd: 2000 }, { symbol: 'DAI', amount: 900, priceUsd: 1 }],
    )
    expect(view.rows.find(r => r.symbol === 'WETH')?.liquidationPriceUsd).toBeNull()
  })

  it('omits debt rows entirely when none are passed — the existing callers are unchanged', () => {
    const view = computeLiquidationView(collateral, 20)
    expect(view.rows.every(r => r.side === 'collateral')).toBe(true)
  })
})
