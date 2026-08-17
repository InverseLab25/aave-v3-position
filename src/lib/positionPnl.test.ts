import { describe, expect, it } from 'vitest'
import { portfolioPnl, resolveEntryPrice, rowPnl, type RowPnlInput } from './positionPnl'

describe('resolveEntryPrice', () => {
  it('prefers what a person typed over anything derived', () => {
    // An override is last-written-by-a-human and must never be quietly replaced.
    expect(resolveEntryPrice({ override: 2500, fills: 1876, indexer: 1873 })).toEqual({
      usd: 2500,
      source: 'override',
    })
  })

  it('prefers the fills over the indexer', () => {
    // The fills are what the wallet actually paid; the indexer reports an oracle read at the
    // block, which for a leveraged open is a different number — 1,873.66 against 1,876.21.
    expect(resolveEntryPrice({ fills: 1876.21, indexer: 1873.66 })).toEqual({
      usd: 1876.21,
      source: 'fills',
    })
  })

  it('falls back to the indexer when there are no fills', () => {
    // A position supplied through Aave directly emits no swap, so there is nothing to derive from.
    expect(resolveEntryPrice({ indexer: 1873.66 })).toEqual({ usd: 1873.66, source: 'indexer' })
  })

  it('reports that nothing could price it, rather than reporting zero as a price', () => {
    expect(resolveEntryPrice({})).toEqual({ usd: 0, source: 'none' })
  })

  it('ignores a non-positive figure from any source', () => {
    // Zero is what every one of these reports for "unknown", and treating it as a price shows a
    // position as having been acquired for nothing — which reads as pure profit.
    expect(resolveEntryPrice({ override: 0, fills: 1876 }).source).toBe('fills')
    expect(resolveEntryPrice({ fills: null, indexer: 1873 }).source).toBe('indexer')
    expect(resolveEntryPrice({ override: -5, fills: 0, indexer: 0 }).source).toBe('none')
  })
})

const row = (over: Partial<RowPnlInput> = {}): RowPnlInput => ({
  side: 'supply',
  entry: { usd: 1800, source: 'fills' },
  currentPriceUsd: 2000,
  amount: 10,
  interestTokens: 0,
  interestUsd: 0,
  realizedPnlUsd: 0,
  ...over,
})

describe('rowPnl', () => {
  it('gains on a supply when the price rises above what was paid', () => {
    expect(rowPnl(row()).priceGainUsd).toBeCloseTo(2000, 6)
  })

  it('gains on a borrow when the price FALLS below what was sold at', () => {
    // A short profits from a fall, so the delta is signed the other way. Getting this backwards
    // would report every profitable short as a loss of the same size.
    const short = rowPnl(row({ side: 'borrow', entry: { usd: 2000, source: 'fills' }, currentPriceUsd: 1800 }))

    expect(short.priceGainUsd).toBeCloseTo(2000, 6)
  })

  it('prices only the principal, not the interest the principal earned', () => {
    // Interest arrives as more tokens. Counting those at the price delta would credit a gain to
    // collateral that was never bought at the entry price.
    const r = rowPnl(row({ amount: 11, interestTokens: 1 }))

    expect(r.netPrincipal).toBeCloseTo(10, 9)
    expect(r.priceGainUsd).toBeCloseTo(2000, 6)
  })

  it('never lets interest exceed the balance and turn the principal negative', () => {
    const r = rowPnl(row({ amount: 1, interestTokens: 3 }))

    expect(r.netPrincipal).toBe(0)
    expect(r.priceGainUsd).toBe(0)
  })

  it('adds up realized, price and interest into the total', () => {
    const r = rowPnl(row({ realizedPnlUsd: 150, interestUsd: 25 }))

    expect(r.totalPnlUsd).toBeCloseTo(2000 + 150 + 25, 6)
  })

  it('claims no price gain when nothing could price the entry', () => {
    // The alternative is an entry of zero, which reports the whole position as profit.
    const r = rowPnl(row({ entry: { usd: 0, source: 'none' } }))

    expect(r.priceGainUsd).toBe(0)
    expect(r.totalPnlUsd).toBe(0)
    expect(r.effectiveAvgEntry).toBe(0)
  })

  it('still reports realized P&L and interest when the entry is unknown', () => {
    // Both are facts that happened; only the unrealized leg depends on knowing the entry.
    const r = rowPnl(row({ entry: { usd: 0, source: 'none' }, realizedPnlUsd: 150, interestUsd: 25 }))

    expect(r.totalPnlUsd).toBe(0)
  })

  it('carries the source through, so the UI can say where the number came from', () => {
    expect(rowPnl(row({ entry: { usd: 2500, source: 'override' } })).source).toBe('override')
  })
})

describe('portfolioPnl', () => {
  it('sums the rows it is given', () => {
    // Summed from the SAME resolved entries the rows display, so the headline figure cannot
    // disagree with the lines beneath it.
    const rows = [
      rowPnl(row({ realizedPnlUsd: 100 })),
      rowPnl(row({ side: 'borrow', entry: { usd: 2000, source: 'fills' }, currentPriceUsd: 1900, amount: 5 })),
    ]

    expect(portfolioPnl(rows)).toBeCloseTo(2000 + 100 + 500, 6)
  })

  it('is zero for an account with nothing in it', () => {
    expect(portfolioPnl([])).toBe(0)
  })
})
