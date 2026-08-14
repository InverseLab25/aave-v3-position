import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useViewMode } from './useViewMode'

const ADDRESS = '0x1111111111111111111111111111111111111111'

/** Puts a path in the bar, since the hook reads `window.location` rather than taking an argument. */
function at(path: string) {
  window.history.pushState({}, '', path)
  return renderHook(() => useViewMode()).result.current
}

describe('useViewMode', () => {
  it('reads a Base address URL', () => {
    expect(at(`/base/address/${ADDRESS}`)).toEqual({ viewAddress: ADDRESS, viewChainId: 8453 })
  })

  it('reads an Arbitrum address URL', () => {
    expect(at(`/arbitrum/address/${ADDRESS}`)).toEqual({ viewAddress: ADDRESS, viewChainId: 42161 })
  })

  it('reads every chain the app is configured for, not a list of its own', () => {
    // The bug this replaces: a second hardcoded slug map that stopped at Ethereum while the app
    // itself had grown to eight chains, so every other one silently fell through to "no view".
    expect(at(`/optimism/address/${ADDRESS}`).viewChainId).toBe(10)
    expect(at(`/polygon/address/${ADDRESS}`).viewChainId).toBe(137)
    expect(at(`/avalanche/address/${ADDRESS}`).viewChainId).toBe(43114)
  })

  it('matches a hyphenated chain slug', () => {
    // `\\w+` cannot match a hyphen, so a two-word chain was unreachable however it was spelled.
    expect(at(`/base-sepolia/address/${ADDRESS}`).viewChainId).toBe(84532)
  })

  it('keeps the short names that were already in circulation', () => {
    // URLs already shared, and `eth` is not derivable from the chain's name.
    expect(at(`/eth/address/${ADDRESS}`).viewChainId).toBe(1)
    expect(at(`/ethereum/address/${ADDRESS}`).viewChainId).toBe(1)
    expect(at(`/mainnet/address/${ADDRESS}`).viewChainId).toBe(1)
  })

  it('accepts a chain slug in any case', () => {
    expect(at(`/Base/address/${ADDRESS}`).viewChainId).toBe(8453)
  })

  it('lower-cases the address, so one account is one cache key however it was typed', () => {
    expect(at(`/base/address/${ADDRESS.toUpperCase().replace('0X', '0x')}`).viewAddress).toBe(ADDRESS)
  })

  it('ignores a chain the app has no configuration for', () => {
    expect(at(`/fantom/address/${ADDRESS}`)).toEqual({})
  })

  it('ignores a malformed address', () => {
    expect(at('/base/address/0xnothex')).toEqual({})
  })

  it('ignores a path that is not a view URL', () => {
    expect(at('/')).toEqual({})
  })
})
