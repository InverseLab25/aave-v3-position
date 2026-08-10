import { describe, expect, it } from 'vitest'
import { manualOpenErrorMessage, validateManualOpen } from './manualOpen'
import type { ManualOpenInput } from './manualOpen'

// WETH collateral at $2,000 (8dp), USDC debt at $1. 18 and 6 decimals respectively.
const BASE: ManualOpenInput = {
  marginIn: 'collateral',
  marginAmount: 10n ** 18n,          // 1 WETH
  borrowAmount: 2_000_000_000n,      // 2,000 USDC
  flashAmount: 10n ** 18n,           // 1 WETH
  marginBalance: 5n * 10n ** 18n,
  collateralPriceUsd: 200_000_000_000n, // 2000 * 1e8
  debtPriceUsd: 100_000_000n,           // 1 * 1e8
  collateralDecimals: 18,
  debtDecimals: 6,
  ltvBps: 8000n,
  liquidationThresholdBps: 8300n,
  existingCollateralUsd: 0n,
  existingDebtUsd: 0n,
  existingLtvBps: 0n,
  existingLiquidationThresholdBps: 0n,
  // 2,000 USDC in -> 1 WETH out: exactly covers a 1 WETH flash.
  quote: { amountIn: 2_000_000_000n, amountOut: 10n ** 18n },
  slippageBps: 50n,
}

it('accepts a position whose swap exactly covers the flash', () => {
  const r = validateManualOpen(BASE)
  expect(r.ok).toBe(true)
})

it('rejects a zero flash before anything else', () => {
  const r = validateManualOpen({ ...BASE, flashAmount: 0n, borrowAmount: 0n })
  expect(r).toMatchObject({ ok: false, error: 'ZERO_FLASH' })
})

it('rejects a zero borrow', () => {
  const r = validateManualOpen({ ...BASE, borrowAmount: 0n })
  expect(r).toMatchObject({ ok: false, error: 'ZERO_BORROW' })
})

it('rejects margin above the wallet balance', () => {
  const r = validateManualOpen({ ...BASE, marginBalance: 10n ** 17n })
  expect(r).toMatchObject({ ok: false, error: 'MARGIN_EXCEEDS_BALANCE' })
})

it('rejects ratchet with no existing position', () => {
  const r = validateManualOpen({ ...BASE, marginIn: 'none', marginAmount: 0n })
  expect(r).toMatchObject({ ok: false, error: 'RATCHET_NO_POSITION' })
})

it('rejects a borrow that cannot swap into the flash, and suggests one that can', () => {
  // Halve the borrow: 1,000 USDC buys 0.5 WETH, short of the 1 WETH flash.
  const r = validateManualOpen({ ...BASE, borrowAmount: 1_000_000_000n })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error).toBe('SWAP_SHORTFALL')
  // 1 WETH needs 2,000 USDC at the quoted rate, padded by 0.5% slippage.
  expect(r.suggestedBorrow).toBe(2_010_000_000n)
})

it('subtracts debt-asset margin from the suggested borrow, since it joins the swap', () => {
  const r = validateManualOpen({
    ...BASE, marginIn: 'debt', marginAmount: 500_000_000n, borrowAmount: 100_000_000n,
  })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.suggestedBorrow).toBe(2_010_000_000n - 500_000_000n)
})

it('rejects a position whose implied LTV reaches the reserve ceiling', () => {
  // The swap buys collateral worth what was borrowed, so LTV = D/(M+D) and clearing 80% needs
  // D >= 4M. With $2,000 of margin that is $8,000 of debt; 9,000 USDC lands at 8181 bps.
  const r = validateManualOpen({
    ...BASE,
    borrowAmount: 9_000_000_000n,
    quote: { amountIn: 9_000_000_000n, amountOut: 45n * 10n ** 17n },
  })
  expect(r).toMatchObject({ ok: false, error: 'LTV_EXCEEDED' })
})

it('projects collateral as margin plus swap output on the collateral path', () => {
  const r = validateManualOpen(BASE)
  if (!r.ok) throw new Error('expected ok')
  expect(r.projection.expectedCollateral).toBe(2n * 10n ** 18n)
  expect(r.projection.expectedDebt).toBe(2_000_000_000n)
})

it('projects collateral as the swap output alone on the debt path', () => {
  // The flash is repaid out of the output, so the margin is already inside it. The rate is
  // doubled from BASE so the resulting position clears the LTV ceiling rather than tripping it.
  const r = validateManualOpen({
    ...BASE,
    marginIn: 'debt',
    marginAmount: 0n,
    quote: { amountIn: 2_000_000_000n, amountOut: 2n * 10n ** 18n },
  })
  if (!r.ok) throw new Error('expected ok')
  expect(r.projection.expectedCollateral).toBe(2n * 10n ** 18n)
})

it('folds the existing account position into the health factor on every mode', () => {
  const alone = validateManualOpen(BASE)
  const withExisting = validateManualOpen({
    ...BASE,
    existingCollateralUsd: 1_000_000_000_000n, // $10,000
    existingDebtUsd: 0n,
    // Same parameters as the incoming reserve, so this isolates the fold-in from the blend.
    existingLtvBps: 8000n,
    existingLiquidationThresholdBps: 8300n,
  })
  if (!alone.ok || !withExisting.ok) throw new Error('expected ok')
  expect(withExisting.projection.expectedHealthFactorBps)
    .toBeGreaterThan(alone.projection.expectedHealthFactorBps)
})

it('judges an account with no existing collateral on the new reserve alone', () => {
  // The blend must reduce EXACTLY to the pre-blend behaviour when there is nothing to blend
  // with, whatever the account-wide fields happen to carry.
  const r = validateManualOpen(BASE)
  if (!r.ok) throw new Error('expected ok')
  expect(r.projection.avgLtvBps).toBe(8000n)                      // the reserve's own ltvBps
  expect(r.projection.expectedHealthFactorBps).toBe(16_600n)      // $4,000 x 0.83 / $2,000

  // Account-wide parameters carry no weight with no collateral behind them.
  const noisy = validateManualOpen({
    ...BASE, existingLtvBps: 1000n, existingLiquidationThresholdBps: 1500n,
  })
  if (!noisy.ok) throw new Error('expected ok')
  expect(noisy.projection).toEqual(r.projection)
})

it('rejects a borrow the blended LTV cannot carry, even though the new reserve alone could', () => {
  // $10,000 of an existing long-tail collateral at 30% LTV, already $5,000 in debt. The new
  // WETH leg lands at an implied 50% LTV — comfortably inside WETH's own 80%, and comfortably
  // OUTSIDE the 44.28% the account's collateral-weighted average allows. Aave's validateBorrow
  // checks the average, so judging this on WETH's 80% waves through a borrow that reverts.
  const p = {
    ...BASE,
    existingCollateralUsd: 1_000_000_000_000n, // $10,000
    existingDebtUsd: 500_000_000_000n,         // $5,000
    existingLtvBps: 3000n,
    existingLiquidationThresholdBps: 4000n,
  }
  expect(validateManualOpen(p)).toMatchObject({ ok: false, error: 'LTV_EXCEEDED' })

  // Pin the arithmetic that makes it a rejection rather than an accident of the fixture: the
  // implied 5000 bps clears the reserve's own 8000 and only trips the blended ceiling.
  const loosened = validateManualOpen({ ...p, existingLtvBps: 8000n })
  if (!loosened.ok) throw new Error('expected ok once the existing collateral is not the binding constraint')
  expect(loosened.projection.impliedLtvBps).toBe(5000n)
  expect(loosened.projection.avgLtvBps).toBe(8000n)
})

it('weights the health factor by the account liquidation threshold, not the new reserve\'s', () => {
  // $10,000 already supplied at a 50% threshold, against $4,000 of new WETH at 83%. The blend
  // is (10,000 x 5000 + 4,000 x 8300) / 14,000 = 5942 bps, so HF = $14,000 x 0.5942 / $2,000.
  const r = validateManualOpen({
    ...BASE,
    existingCollateralUsd: 1_000_000_000_000n,
    existingDebtUsd: 0n,
    existingLtvBps: 8000n,
    existingLiquidationThresholdBps: 5000n,
  })
  if (!r.ok) throw new Error('expected ok')
  expect(r.projection.expectedHealthFactorBps).toBe(41_594n)
  // The new reserve's own 8300 would have read 58,100 — a third safer than the account is.
})

it('reports no leverage figure for ratchet, where equity added is ~zero', () => {
  const r = validateManualOpen({
    ...BASE,
    marginIn: 'none',
    marginAmount: 0n,
    existingCollateralUsd: 1_000_000_000_000n,
    existingLtvBps: 8000n,
    existingLiquidationThresholdBps: 8300n,
  })
  if (!r.ok) throw new Error('expected ok')
  expect(r.projection.expectedLeverageBps).toBeNull()
})

it('projects without a quote so the form can render before the first round lands', () => {
  const r = validateManualOpen({ ...BASE, quote: null })
  if (!r.ok) throw new Error('expected ok')
  // Asserting only `ok` would pass against a projection of anything at all. With no rate to
  // apply there is no swap output yet, so the position is the margin and nothing more.
  expect(r.projection.expectedSwapOut).toBe(0n)
  expect(r.projection.expectedCollateral).toBe(BASE.marginAmount)
})

describe('manualOpenErrorMessage', () => {
  it('names the shortfall and the borrow that would clear it', () => {
    const msg = manualOpenErrorMessage('SWAP_SHORTFALL', {
      marginSymbol: 'WETH', debtSymbol: 'USDC', collateralSymbol: 'WETH',
      marginBalance: '5.0', shortfall: '0.5', suggestedBorrow: '2,010',
    })
    expect(msg).toContain('0.5')
    expect(msg).toContain('2,010')
  })
})
