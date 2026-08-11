import { describe, it, expect } from 'vitest'
import type { AvailableReserve } from '../../hooks/useAavePositions'
import { defaultPair } from './defaultPair'

/**
 * The pair the long/short form opens on. It is the first thing a user sees and the thing most of
 * them will trade without changing, so landing on the wrong side of it is not cosmetic — it
 * pre-selects a position.
 */
const reserve = (symbol: string, priceInUsd: string): AvailableReserve =>
  ({
    symbol,
    priceInUsd,
    // Address only has to be distinct — the collision check compares underlyings.
    underlyingAsset: `0x${symbol.toLowerCase().padEnd(40, '0')}` as `0x${string}`,
  }) as AvailableReserve

/** Aave returns reserves in its own order, which is not the order anyone wants to trade in. */
const ETHEREUM = [
  reserve('DAI', '1.0001'),
  reserve('WBTC', '95000'),
  reserve('WETH', '1890'),
  reserve('USDT', '1.0000'),
  reserve('USDC', '0.9999'),
]

describe('defaultPair — the preferred pair', () => {
  it('opens on WETH against USDC', () => {
    const { subject, quote } = defaultPair(ETHEREUM)

    expect(subject?.symbol).toBe('WETH')
    expect(quote?.symbol).toBe('USDC')
  })

  it('prefers WETH over a volatile reserve listed ahead of it', () => {
    // WBTC comes first in the list and is just as volatile, so the old price-only rule picked it.
    expect(defaultPair(ETHEREUM).subject?.symbol).not.toBe('WBTC')
  })

  it('prefers USDC over a stablecoin listed ahead of it', () => {
    // DAI is first and prices inside the stable band, so price alone selected it.
    expect(defaultPair(ETHEREUM).quote?.symbol).not.toBe('DAI')
  })

  it('falls back to USDT on a chain that lists no USDC', () => {
    const noUsdc = ETHEREUM.filter((r) => r.symbol !== 'USDC')
    expect(defaultPair(noUsdc).quote?.symbol).toBe('USDT')
  })

  it('prefers USDC over USDT when both are listed', () => {
    // Order the list so USDT comes first: the preference must come from the list of preferred
    // symbols, not from whichever the chain happens to return earlier.
    const usdtFirst = [reserve('WETH', '1890'), reserve('USDT', '1'), reserve('USDC', '1')]
    expect(defaultPair(usdtFirst).quote?.symbol).toBe('USDC')
  })

  it('accepts USDT0 as the Tether fallback', () => {
    // Polygon and Arbitrum list Tether as USDT0; exact matching alone would skip it and fall
    // through to the price heuristic, landing on whatever stable came first.
    const arbitrum = [reserve('WETH', '1890'), reserve('DAI', '1'), reserve('USDT0', '1')]
    expect(defaultPair(arbitrum).quote?.symbol).toBe('USDT0')
  })

  it('prefers native USDC over bridged USDC.e', () => {
    // Several chains list both, and the prefix matches either. The bridged one is the thinner
    // market, so an exact match has to beat a prefix match even when it is listed later.
    const withBridged = [reserve('WETH', '1890'), reserve('USDC.e', '1'), reserve('USDC', '1')]
    expect(defaultPair(withBridged).quote?.symbol).toBe('USDC')
  })

  it('takes bridged USDC.e when it is the only USDC on the chain', () => {
    const bridgedOnly = [reserve('WETH', '1890'), reserve('DAI', '1'), reserve('USDC.e', '1')]
    expect(defaultPair(bridgedOnly).quote?.symbol).toBe('USDC.e')
  })

  it('still prefers an exact USDT over a bridged USDC.e', () => {
    // Exact beats prefix across the WHOLE preference list, not per entry — otherwise USDC.e
    // would win on the first pass purely for sitting earlier in PREFERRED_QUOTES.
    const mixed = [reserve('WETH', '1890'), reserve('USDC.e', '1'), reserve('USDT', '1')]
    expect(defaultPair(mixed).quote?.symbol).toBe('USDT')
  })
})

describe('defaultPair — chains without the preferred assets', () => {
  it('falls back to the volatile reserve where WETH is not listed', () => {
    const bsc = [reserve('USDC', '1'), reserve('WBNB', '612'), reserve('USDT', '1')]
    const { subject, quote } = defaultPair(bsc)

    expect(subject?.symbol).toBe('WBNB')
    expect(quote?.symbol).toBe('USDC')
  })

  it('never puts the same asset on both legs', () => {
    // A pair whose sides match cannot be quoted, so the form would sit on dead input. With one
    // volatile reserve and nothing stable, the quote has to come off the price heuristic's
    // fallback rather than repeating the subject.
    const thin = [reserve('WETH', '1890'), reserve('WBTC', '95000')]
    const { subject, quote } = defaultPair(thin)

    expect(subject?.symbol).toBe('WETH')
    expect(quote?.symbol).toBe('WBTC')
  })

  it('leaves the quote undefined rather than duplicating a lone reserve', () => {
    const { subject, quote } = defaultPair([reserve('WETH', '1890')])

    expect(subject?.symbol).toBe('WETH')
    expect(quote).toBeUndefined()
  })

  it('returns nothing while the reserve list is still empty', () => {
    // The list arrives asynchronously, so this is the state on first render every time.
    expect(defaultPair([])).toEqual({ subject: undefined, quote: undefined })
  })
})
