import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { buildTokenMap, positionTokens } from './tokenMeta'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address
const A_WETH = '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8' as Address
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
const V_USDC = '0x72E95b8931767C79bA4EeE721354d6E99a61D004' as Address

const collateral = {
  symbol: 'WETH',
  decimals: 18,
  underlyingAsset: WETH,
  aTokenAddress: A_WETH,
}
const debt = {
  symbol: 'USDC',
  decimals: 6,
  underlyingAsset: USDC,
  variableDebtTokenAddress: V_USDC,
}

describe('buildTokenMap', () => {
  it('names the underlying by its own symbol', () => {
    expect(buildTokenMap([collateral])[WETH.toLowerCase()]).toEqual({ symbol: 'WETH', decimals: 18 })
  })

  it('covers both sides of a pair', () => {
    const map = buildTokenMap([collateral, debt])

    expect(Object.keys(map).sort()).toEqual([USDC.toLowerCase(), WETH.toLowerCase()].sort())
  })

  it('keys every entry by lower-cased address, whatever case it was given in', () => {
    const map = buildTokenMap([{ ...collateral, underlyingAsset: WETH.toUpperCase() as Address }])

    expect(map[WETH.toLowerCase()]).toBeDefined()
  })

  it('skips an asset that is not there', () => {
    expect(buildTokenMap([collateral, null, undefined])[WETH.toLowerCase()]).toBeDefined()
  })
})

describe('positionTokens', () => {
  it('collects the aToken and the variable-debt token of a pair', () => {
    expect(positionTokens([collateral, debt])).toEqual([A_WETH, V_USDC])
  })

  it('collects nothing from an asset that carries neither', () => {
    expect(positionTokens([{ symbol: 'WETH', decimals: 18, underlyingAsset: WETH }])).toEqual([])
  })

  it('skips an asset that is not there', () => {
    expect(positionTokens([null, debt, undefined])).toEqual([V_USDC])
  })
})
