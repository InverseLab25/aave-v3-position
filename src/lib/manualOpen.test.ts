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
  })
  if (!alone.ok || !withExisting.ok) throw new Error('expected ok')
  expect(withExisting.projection.expectedHealthFactorBps)
    .toBeGreaterThan(alone.projection.expectedHealthFactorBps)
})

it('reports no leverage figure for ratchet, where equity added is ~zero', () => {
  const r = validateManualOpen({
    ...BASE,
    marginIn: 'none',
    marginAmount: 0n,
    existingCollateralUsd: 1_000_000_000_000n,
  })
  if (!r.ok) throw new Error('expected ok')
  expect(r.projection.expectedLeverageBps).toBeNull()
})

it('projects without a quote so the form can render before the first round lands', () => {
  const r = validateManualOpen({ ...BASE, quote: null })
  expect(r.ok).toBe(true)
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
