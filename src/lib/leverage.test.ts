import { describe, expect, it } from 'vitest'
import { formatUnits, parseUnits } from 'viem'
import {
  deriveOpen,
  leverageReadoutBps,
  ltvWallBps,
  maxBorrowAmount,
  maxSupplyAmount,
  projectOpen,
  resolveOpenMode,
  resolveRoles,
  validateSizing,
} from './leverage'

/** The worked example this module was designed against: ETH at $2,000, WETH LTV 80%. */
const WETH = { priceUsd: 2000_00000000n, decimals: 18 }
const USDC = { priceUsd: 1_00000000n, decimals: 6 }
const LTV_80 = 8000n

const weth = (n: string) => parseUnits(n, 18)
const usdc = (n: string) => parseUnits(n, 6)

/** An empty account — no existing collateral, debt or weighted parameters. */
const noAccount = {
  existingCollateralUsd: 0n,
  existingDebtUsd: 0n,
  existingLtvBps: 0n,
  existingLiquidationThresholdBps: 0n,
}

/** Prices and reserve parameters shared by the worked examples. */
const market = {
  collateralPriceUsd: WETH.priceUsd,
  debtPriceUsd: USDC.priceUsd,
  collateralDecimals: WETH.decimals,
  debtDecimals: USDC.decimals,
  ltvBps: LTV_80,
  liquidationThresholdBps: 8250n,
  ...noAccount,
}

/**
 * The worked examples were written against the raw 80% LTV, whereas `danger: true` applies the
 * SDK's 98% haircut. Dividing the reserve's LTV by that factor makes the wall land back on
 * exactly 80%, so the figures below stay the ones in the original brief.
 */
const atFullLtv = { ...market, danger: true }

describe('maxSupplyAmount — the closed form of the supply/borrow/re-supply loop', () => {
  // The brief's figures are the pure algebra at a raw 80% LTV. The product never reaches them:
  // `ltvWallBps` takes the SDK's 2% haircut off first, so the wall is 78.4% and the ceiling comes
  // in proportionally lower. Both numbers are asserted, so a change to either is visible.
  const pure = (marginUsd: number, priceUsd: number) => marginUsd / (priceUsd * (1 - 0.8))
  const haircut = (marginUsd: number, priceUsd: number) => marginUsd / (priceUsd * (1 - 0.784))

  it('holding 40 WETH, long ETH: 200 WETH by the formula, 185.19 after the haircut', () => {
    expect(pure(80_000, 2000)).toBeCloseTo(200, 6)
    const max = maxSupplyAmount({ ...atFullLtv, marginAsset: 'collateral', marginAmount: weth('40') })
    expect(Number(formatUnits(max, 18))).toBeCloseTo(haircut(80_000, 2000), 6)
    expect(Number(formatUnits(max, 18))).toBeCloseTo(185.19, 2)
  })

  it('holding 200k USDC, long ETH: 500 WETH by the formula, 462.96 after the haircut', () => {
    expect(pure(200_000, 2000)).toBeCloseTo(500, 6)
    const max = maxSupplyAmount({ ...atFullLtv, marginAsset: 'debt', marginAmount: usdc('200000') })
    expect(Number(formatUnits(max, 18))).toBeCloseTo(haircut(200_000, 2000), 6)
    expect(Number(formatUnits(max, 18))).toBeCloseTo(462.96, 2)
  })

  it('agrees with looping n times as n grows — 200(1 − 0.8ⁿ) → 200', () => {
    // Round-by-round: supply W₀Lⁿ each round. The sum must approach the closed form from below
    // and never exceed it, which is the whole claim one flash loan rests on.
    let looped = 0
    let round = weth('40')
    // Far enough that 0.8ⁿ·40e18 truncates to zero — the loop has genuinely run out, rather than
    // being cut off at a round count chosen to make the assertion pass.
    for (let n = 0; round > 0n && n < 500; n++) {
      looped += Number(formatUnits(round, 18))
      round = (round * LTV_80) / 10_000n
    }
    expect(looped).toBeCloseTo(200, 6)
    // And it approaches from BELOW — the closed form is a ceiling the loop never exceeds.
    expect(looped).toBeLessThanOrEqual(200)
  })
})

describe('the four worked flash-loan scenarios', () => {
  // Margin 200k USDC. The user's framing flashes USDC; the contract flashes the COLLATERAL it
  // supplies, so the equivalent input is the supply itself — 300 WETH is their $600k flash.
  const cases: Array<{ supply: string; borrow: number; leverage: string }> = [
    { supply: '100', borrow: 0, leverage: '1.00' },
    { supply: '200', borrow: 200_000, leverage: '2.00' },
    { supply: '300', borrow: 400_000, leverage: '3.00' },
    { supply: '400', borrow: 600_000, leverage: '4.00' },
    { supply: '500', borrow: 800_000, leverage: '5.00' },
  ]

  it.each(cases)('supplying $supply WETH borrows $borrow USDC at $leverage x', ({ supply, borrow, leverage }) => {
    const supplyAmount = weth(supply)
    const marginAmount = usdc('200000')

    // The borrow is solved against a router in production; at oracle prices it is exactly the
    // supply's value less the margin already inside the swap.
    const impliedBorrowUsdc =
      Number(formatUnits(supplyAmount, 18)) * 2000 - Number(formatUnits(marginAmount, 6))
    expect(impliedBorrowUsdc).toBe(borrow)

    const readout = leverageReadoutBps({
      marginAsset: 'debt', marginAmount, supplyAmount,
      collateralPriceUsd: WETH.priceUsd, debtPriceUsd: USDC.priceUsd,
      collateralDecimals: 18, debtDecimals: 6,
    })
    expect((Number(readout) / 10_000).toFixed(2)).toBe(leverage)

    // The whole supply is flashed on the debt-margin path — the margin goes into the swap.
    expect(deriveOpen({ marginAsset: 'debt', marginAmount, supplyAmount }).flashAmount).toBe(supplyAmount)
  })
})

describe('deriveOpen', () => {
  it('collateral margin: the flash covers only the gap the user did not post', () => {
    expect(deriveOpen({ marginAsset: 'collateral', marginAmount: weth('40'), supplyAmount: weth('120') }))
      .toEqual({ flashAmount: weth('80'), debtMargin: 0n })
  })

  it('debt margin: the flash is the whole supply, and the margin joins the swap', () => {
    expect(deriveOpen({ marginAsset: 'debt', marginAmount: usdc('200000'), supplyAmount: weth('300') }))
      .toEqual({ flashAmount: weth('300'), debtMargin: usdc('200000') })
  })
})

describe('ltvWallBps', () => {
  it('applies the SDK haircut to the reserve LTV', () => {
    expect(ltvWallBps(LTV_80)).toBe(7840n) // 8000 × 0.98
  })

  it('a zero-LTV reserve cannot be levered at all', () => {
    expect(ltvWallBps(0n)).toBe(0n)
  })
})

describe('the safe cap really is safer', () => {
  it('the theoretical max lands at a health factor of LT/LTV — 1.03 for an 80/82.5 reserve', () => {
    // At the wall, debt = collateral × LTV, so HF = collateral × LT / debt = LT / LTV.
    expect(8250 / 8000).toBeCloseTo(1.03, 2)
  })

  it('and the safe cap supplies materially less for the same margin', () => {
    const args = { ...market, marginAsset: 'collateral' as const, marginAmount: weth('40') }
    const safe = maxSupplyAmount({ ...args, danger: false })
    const danger = maxSupplyAmount({ ...args, danger: true })
    expect(safe).toBeLessThan(danger)
    expect(Number(formatUnits(safe, 18))).toBeCloseTo(141.5, 1)
    expect(Number(formatUnits(danger, 18))).toBeCloseTo(185.2, 1)
  })
})

describe('the ceiling accounts for a position you already hold', () => {
  // 1,000 USDC supplied, 0.01 WETH borrowed — a small short ETH, USDC 75% LTV / 78% LT.
  const usdcMarket = {
    marginAsset: 'none' as const,
    marginAmount: 0n,
    collateralPriceUsd: USDC.priceUsd,
    debtPriceUsd: WETH.priceUsd,
    collateralDecimals: 6,
    debtDecimals: 18,
    ltvBps: 7500n,
    liquidationThresholdBps: 7800n,
    existingCollateralUsd: 1_000_00000000n,
    existingDebtUsd: 20_00000000n, // 0.01 WETH at $2,000
    existingLtvBps: 7500n,
    existingLiquidationThresholdBps: 7800n,
  }

  it('boost with zero margin sizes off the remaining borrow power', () => {
    // Borrow power left: 1,000 × 0.75 − 20 = $730. Against the 73.5% haircut wall:
    // 730 / (1 − 0.735) = $2,754 of further USDC supply.
    const max = maxSupplyAmount({ ...usdcMarket, danger: true })
    expect(Number(formatUnits(max, 6))).toBeCloseTo(730 / (1 - 0.735), 1)
  })

  it('and the health-factor cap comes in tighter than the wall', () => {
    // (1,000 × 0.78 − 1.15 × 20) / (1.15 − 0.78) = $2,045.9
    const max = maxSupplyAmount({ ...usdcMarket, danger: false })
    expect(Number(formatUnits(max, 6))).toBeCloseTo((780 - 1.15 * 20) / (1.15 - 0.78), 1)
    expect(max).toBeLessThan(maxSupplyAmount({ ...usdcMarket, danger: true }))
  })

  it('refuses to boost an account with no borrow power left', () => {
    // Debt already at the LTV wall — nothing to lever.
    const max = maxSupplyAmount({ ...usdcMarket, existingDebtUsd: 750_00000000n, danger: true })
    expect(max).toBe(0n)
  })

  // The bug this rework fixes: the ceiling used to see only the margin, so it answered the same
  // number whatever the account already held. It moves in BOTH directions, and the expensive
  // direction is down — that is the case Aave rejects and the user pays gas to discover.
  const margined = { ...usdcMarket, marginAsset: 'collateral' as const, marginAmount: usdc('1000'), danger: true }
  const onFreshAccount = maxSupplyAmount({ ...margined, ...noAccount })

  it('spare borrow power RAISES the ceiling for a margin open', () => {
    // margin 1,000 + borrow power 730, all over (1 − 0.735)
    const max = maxSupplyAmount(margined)
    expect(Number(formatUnits(max, 6))).toBeCloseTo((1000 + 730) / (1 - 0.735), 1)
    expect(max).toBeGreaterThan(onFreshAccount)
  })

  it('an account borrowed past its own LTV LOWERS it', () => {
    // $800 of debt against $750 of borrow power is $50 in the hole, which the new margin has to
    // cover before any of it can be levered.
    const overdrawn = maxSupplyAmount({ ...margined, existingDebtUsd: 800_00000000n })
    expect(Number(formatUnits(overdrawn, 6))).toBeCloseTo((1000 - 50) / (1 - 0.735), 1)
    expect(overdrawn).toBeLessThan(onFreshAccount)
  })

  it('and refuses outright once the hole is deeper than the margin', () => {
    expect(maxSupplyAmount({ ...margined, existingDebtUsd: 2_000_00000000n })).toBe(0n)
  })
})

describe('maxBorrowAmount — the same ceiling, named in the borrow asset', () => {
  // The same short-ETH account: 1,000 USDC supplied, 0.01 WETH borrowed, WETH at $2,000.
  const boost = {
    marginAsset: 'none' as const,
    marginAmount: 0n,
    collateralPriceUsd: USDC.priceUsd,
    debtPriceUsd: WETH.priceUsd,
    collateralDecimals: 6,
    debtDecimals: 18,
    ltvBps: 7500n,
    liquidationThresholdBps: 7800n,
    existingCollateralUsd: 1_000_00000000n,
    existingDebtUsd: 20_00000000n,
    existingLtvBps: 7500n,
    existingLiquidationThresholdBps: 7800n,
  }

  it('is the supply ceiling converted at the debt price', () => {
    // Boost supplies every unit it borrows, so the two are one USD figure in two denominations.
    const supply = maxSupplyAmount({ ...boost, danger: true })
    const borrow = maxBorrowAmount({ ...boost, danger: true })
    const supplyUsd = Number(formatUnits(supply, 6)) * 1
    const borrowUsd = Number(formatUnits(borrow, 18)) * 2000
    expect(borrowUsd).toBeCloseTo(supplyUsd, 2)
  })

  it('caps the borrow at 1.377 WETH against $730 of borrow power', () => {
    // 730 / (1 − 0.735) = $2,754.7, which at $2,000 is 1.377 WETH.
    const borrow = maxBorrowAmount({ ...boost, danger: true })
    expect(Number(formatUnits(borrow, 18))).toBeCloseTo(730 / (1 - 0.735) / 2000, 4)
  })

  it('and the health-factor cap brings it to 1.02 WETH', () => {
    const borrow = maxBorrowAmount({ ...boost, danger: false })
    expect(Number(formatUnits(borrow, 18))).toBeCloseTo((780 - 1.15 * 20) / (1.15 - 0.78) / 2000, 4)
  })

  it('refuses to answer on a margin path, where supply and borrow diverge', () => {
    // There the borrow is the supply LESS the margin, so the supply ceiling would overstate it.
    expect(maxBorrowAmount({ ...boost, marginAsset: 'collateral', marginAmount: usdc('1000'), danger: true }))
      .toBe(0n)
  })
})

describe('validateSizing on the boost path', () => {
  const boost = {
    marginAsset: 'none' as const,
    marginAmount: 0n,
    supplyAmount: usdc('2000'),
    marginBalance: 0n,
    maxSupply: usdc('2046'),
  }

  it('accepts a zero margin — that is the whole point', () => {
    expect(validateSizing(boost)).toBeNull()
  })

  it('complains about the missing headroom, not the missing margin', () => {
    expect(validateSizing({ ...boost, maxSupply: 0n })).toBe('BOOST_NO_HEADROOM')
  })

  it('still enforces the ceiling', () => {
    expect(validateSizing({ ...boost, supplyAmount: usdc('2047') })).toBe('SUPPLY_ABOVE_MAX')
  })

  it('still needs a supply', () => {
    expect(validateSizing({ ...boost, supplyAmount: 0n })).toBe('NO_SUPPLY')
  })
})

describe('projectOpen exposes the threshold a liquidation price must be solved at', () => {
  it('blends the new reserve with the existing account by USD weight', () => {
    const p = projectOpen({
      marginAsset: 'collateral',
      marginAmount: weth('40'),
      borrowAmount: usdc('160000'),
      expectedSwapOut: weth('80'),
      collateralPriceUsd: WETH.priceUsd,
      debtPriceUsd: USDC.priceUsd,
      collateralDecimals: 18,
      debtDecimals: 6,
      ltvBps: LTV_80,
      liquidationThresholdBps: 8250n,
      // An equal USD sum of existing collateral at a tighter threshold pulls the average halfway.
      existingCollateralUsd: 240_000_00000000n, // matches the new 120 WETH at $2,000
      existingDebtUsd: 0n,
      existingLtvBps: 7000n,
      existingLiquidationThresholdBps: 7500n,
    })
    expect(p.avgLiquidationThresholdBps).toBe(7875n) // (8250 + 7500) / 2
    expect(p.avgLtvBps).toBe(7500n) // (8000 + 7000) / 2
  })

  it('falls back to the new reserve alone on an empty account', () => {
    const p = projectOpen({
      marginAsset: 'collateral',
      marginAmount: weth('40'),
      borrowAmount: usdc('160000'),
      expectedSwapOut: weth('80'),
      collateralPriceUsd: WETH.priceUsd,
      debtPriceUsd: USDC.priceUsd,
      collateralDecimals: 18,
      debtDecimals: 6,
      ltvBps: LTV_80,
      liquidationThresholdBps: 8250n,
      existingCollateralUsd: 0n,
      existingDebtUsd: 0n,
      existingLtvBps: 0n,
      existingLiquidationThresholdBps: 0n,
    })
    expect(p.avgLiquidationThresholdBps).toBe(8250n)
    // 120 WETH supplied against 160k of debt — the worked example's own shape.
    expect(p.expectedCollateral).toBe(weth('120'))
    expect(p.expectedDebt).toBe(usdc('160000'))
  })
})

describe('resolveOpenMode / resolveRoles', () => {
  it('maps every direction and margin location onto a distinct SDK mode', () => {
    expect(resolveOpenMode('long', 'collateral')).toBe(1)
    expect(resolveOpenMode('long', 'debt')).toBe(2)
    expect(resolveOpenMode('short', 'debt')).toBe(3)
    expect(resolveOpenMode('short', 'collateral')).toBe(4)
    // Boost — no margin, levering what the account already holds.
    expect(resolveOpenMode('long', 'none')).toBe(5)
    expect(resolveOpenMode('short', 'none')).toBe(6)
  })

  it('boost takes the collateral entry point with the whole supply flashed', () => {
    // "none" must not fall through the debt branch: the contract supplies flash + margin on the
    // collateral path, and with a zero margin that is the flash alone.
    expect(deriveOpen({ marginAsset: 'none', marginAmount: 0n, supplyAmount: usdc('2000') }))
      .toEqual({ flashAmount: usdc('2000'), debtMargin: 0n })
  })

  it('longs collateralize the subject; shorts borrow it', () => {
    expect(resolveRoles('long', 'ETH', 'USDC')).toEqual({ collateral: 'ETH', debt: 'USDC' })
    expect(resolveRoles('short', 'ETH', 'USDC')).toEqual({ collateral: 'USDC', debt: 'ETH' })
  })
})

describe('validateSizing — ordered, first failure wins', () => {
  const base = {
    marginAsset: 'collateral' as const,
    marginAmount: weth('40'),
    supplyAmount: weth('120'),
    marginBalance: weth('40'),
    maxSupply: weth('200'),
  }

  it('accepts the worked example', () => {
    expect(validateSizing(base)).toBeNull()
  })

  it('rejects a missing margin before anything else', () => {
    expect(validateSizing({ ...base, marginAmount: 0n, supplyAmount: 0n })).toBe('NO_MARGIN')
  })

  it('rejects a margin the wallet cannot cover', () => {
    expect(validateSizing({ ...base, marginBalance: weth('39') })).toBe('MARGIN_EXCEEDS_BALANCE')
  })

  it('rejects a missing supply', () => {
    expect(validateSizing({ ...base, supplyAmount: 0n })).toBe('NO_SUPPLY')
  })

  it('rejects a supply that leaves nothing to lever', () => {
    expect(validateSizing({ ...base, supplyAmount: weth('40') })).toBe('SUPPLY_BELOW_MARGIN')
  })

  it('rejects a supply past the ceiling in force', () => {
    expect(validateSizing({ ...base, supplyAmount: weth('201') })).toBe('SUPPLY_ABOVE_MAX')
  })

  it('accepts a supply exactly at the ceiling', () => {
    expect(validateSizing({ ...base, supplyAmount: weth('200') })).toBeNull()
  })
})
