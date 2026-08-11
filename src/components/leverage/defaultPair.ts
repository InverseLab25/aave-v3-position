import type { AvailableReserve } from '../../hooks/useAavePositions'
import { isVolatilePrice } from '../../utils/liquidation'

/**
 * What the long/short pair selects to before the user touches it, in order of preference.
 *
 * Symbol first, because the default should be the pair people actually open — WETH against USDC —
 * rather than whichever reserve Aave happens to return first, which is what ordering on price
 * alone produced. USDT is the fallback on a chain that lists no USDC; the prefix match takes
 * USDT0 with it, since Polygon and Arbitrum list Tether under that name.
 *
 * Price stays the fallback classifier rather than growing into a longer allowlist: a symbol list
 * rots on every new listing and would call a depegged asset a stablecoin. See `isVolatilePrice`.
 */
const PREFERRED_SUBJECTS = ['WETH']
const PREFERRED_QUOTES = ['USDC', 'USDT']

/**
 * Exact matches across the whole preference list before any prefix match.
 *
 * Ordering matters both ways. Exact-first keeps native USDC ahead of bridged USDC.e, which the
 * prefix also matches and which several chains list alongside it — picking the bridged one is a
 * thinner market for no reason. Prefix-second is what lets USDT0 stand in for USDT, and it only
 * ever applies once nothing exact has been found.
 */
const bySymbol = (reserves: AvailableReserve[], preferred: string[]) => {
  const upper = reserves.map((r) => ({ r, symbol: r.symbol.toUpperCase() }))
  for (const symbol of preferred) {
    const exact = upper.find((c) => c.symbol === symbol)
    if (exact) return exact.r
  }
  for (const symbol of preferred) {
    const prefixed = upper.find((c) => c.symbol.startsWith(symbol))
    if (prefixed) return prefixed.r
  }
  return undefined
}

/**
 * The pair the form opens on, given the reserves the chain lists.
 *
 * Its own module rather than a helper inside the panel: the panel exports a component, and a file
 * that exports both breaks fast refresh. Being pure over the reserve list also means a test can
 * check a default without mounting the panel and every contract read it makes.
 *
 * Both legs resolve together because they must not collide. A pair whose sides are the same asset
 * cannot be quoted, so the quote is chosen from the reserves the subject did not take — on a
 * single-reserve chain that correctly leaves it undefined rather than duplicating the subject.
 */
export function defaultPair(reserves: AvailableReserve[]): {
  subject: AvailableReserve | undefined
  quote: AvailableReserve | undefined
} {
  const subject =
    bySymbol(reserves, PREFERRED_SUBJECTS)
    ?? reserves.find((r) => isVolatilePrice(Number(r.priceInUsd)))
    ?? reserves[0]

  const notSubject = reserves.filter((r) => r.underlyingAsset !== subject?.underlyingAsset)
  const quote =
    bySymbol(notSubject, PREFERRED_QUOTES)
    ?? notSubject.find((r) => !isVolatilePrice(Number(r.priceInUsd)))
    ?? notSubject[0]

  return { subject, quote }
}
