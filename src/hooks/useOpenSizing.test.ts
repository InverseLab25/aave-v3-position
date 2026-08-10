import { expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { MarginLocation } from '../lib/strategies-sdk/sizing'
import { useOpenSizing } from './useOpenSizing'

const BASE = {
  // Widened deliberately: `as const` would narrow to "collateral" and make the ratchet
  // override below unassignable through `Partial<typeof BASE>`.
  marginIn: 'collateral' as MarginLocation,
  marginStr: '1',
  marginDecimals: 18,
  borrowStr: '',
  borrowDecimals: 6,
  flashStr: '',
  flashDecimals: 18,
  leverageBps: 20_000n,
  manualEnabled: false,
}

const sizingFor = (over: Partial<typeof BASE>) =>
  renderHook(() => useOpenSizing({ ...BASE, ...over })).result.current

it('solves from the margin and the slider while manual entry is locked', () => {
  const { sizing, manual } = sizingFor({})
  expect(manual).toBe(false)
  expect(sizing).toEqual({ kind: 'derived', marginAmount: 10n ** 18n, leverageBps: 20_000n })
})

it('takes the typed amounts once manual entry is unlocked', () => {
  const { sizing, manual } = sizingFor({ manualEnabled: true, borrowStr: '2500', flashStr: '2' })
  expect(manual).toBe(true)
  expect(sizing).toEqual({
    kind: 'manual',
    marginAmount: 10n ** 18n,
    borrowAmount: 2_500_000_000n,
    flashAmount: 2n * 10n ** 18n,
  })
})

it('forces manual with a zero margin on the ratchet path', () => {
  const { sizing, manual } = sizingFor({ marginIn: 'none', borrowStr: '2500', flashStr: '2' })
  expect(manual).toBe(true)
  expect(sizing).toEqual({
    kind: 'manual',
    marginAmount: 0n,
    borrowAmount: 2_500_000_000n,
    flashAmount: 2n * 10n ** 18n,
  })
})

it('withholds a sizing while a field is unparseable, rather than quoting a partial one', () => {
  expect(sizingFor({ marginStr: 'abc' }).sizing).toBeNull()
  expect(sizingFor({ manualEnabled: true, borrowStr: 'abc', flashStr: '2' }).sizing).toBeNull()
  expect(sizingFor({ manualEnabled: true, borrowStr: '2500', flashStr: 'abc' }).sizing).toBeNull()
})

// viem's parseUnits returns a NEGATIVE bigint for "-5" instead of throwing, and a negative
// amount clears every downstream guard (under the wallet balance, `allowance < negative` is
// false) only to die at encodeFunctionData with IntegerOutOfRange. Reject it at the boundary.
it('rejects a negative amount in any field', () => {
  expect(sizingFor({ marginStr: '-5' }).sizing).toBeNull()
  expect(sizingFor({ manualEnabled: true, borrowStr: '-2500', flashStr: '2' }).sizing).toBeNull()
  expect(sizingFor({ manualEnabled: true, borrowStr: '2500', flashStr: '-2' }).sizing).toBeNull()
})

it('withholds a derived sizing until the margin is positive', () => {
  expect(sizingFor({ marginStr: '' }).sizing).toBeNull()
  expect(sizingFor({ marginStr: '0' }).sizing).toBeNull()
})
