/**
 * What a position is worth against what it cost.
 *
 * This lived inside `AavePosition` — a component of nearly nine hundred lines — where it could
 * only be exercised by mounting React, and where three competing entry prices were reconciled by
 * a conditional expression in the middle of a render. That is also where the units quietly mixed:
 * realized P&L arrives from Aave's indexer in dollars and cannot be re-denominated, while the
 * other two legs were being reasoned about in the quote token.
 *
 * Nothing here reads state, storage or a clock. Every figure is an argument.
 */

type PnlSide = 'supply' | 'borrow'

/**
 * Which of the three answered.
 *
 * Reported rather than inferred. The component used to derive "is this an override?" by testing
 * the override map a second time, which meant the badge and the number could in principle
 * disagree about where the figure came from.
 */
type EntrySource = 'override' | 'measured' | 'none'

interface EntryPrice {
  /** USD per unit. Zero exactly when `source` is `none`. */
  usd: number
  source: EntrySource
}

interface EntryPriceInput {
  /** What the user typed for this row, if anything. */
  override?: number
  /**
   * Replayed from Aave's own ledger, every lot at what it actually cost — the router's rate where
   * a swap bought it, the block's oracle read where it was supplied from the wallet. See
   * `useAaveHistoricalInterest`.
   */
  measured?: number
}

/**
 * Hand-typed beats measured.
 *
 * The override is last-written-by-a-person and must never be quietly replaced. There used to be a
 * third source between them — a second ledger replayed from swap rows alone — and it was removed
 * rather than fixed: it could only see units that went through a router, so a position exited by
 * a plain Aave withdrawal left it holding lots the wallet no longer owned, and it averaged those
 * into every position opened afterwards. The fills belong IN the ledger that sees every movement,
 * which is where they are now.
 *
 * A non-positive figure is not a price. Zero is what both sources report for "unknown", and
 * accepting it would show a position acquired for nothing, which reads as pure profit.
 */
export function resolveEntryPrice({ override, measured }: EntryPriceInput): EntryPrice {
  if (override !== undefined && override > 0) return { usd: override, source: 'override' }
  if (measured !== undefined && measured > 0) return { usd: measured, source: 'measured' }
  return { usd: 0, source: 'none' }
}

export interface RowPnlInput {
  side: PnlSide
  entry: EntryPrice
  currentPriceUsd: number
  /** Balance as held, interest included. */
  amount: number
  /** The share of `amount` that is accrued interest rather than principal. */
  interestTokens: number
  /** Interest in dollars, signed: positive earned on a supply, negative paid on a borrow. */
  interestUsd: number
  /** Closed out already, from the indexer. Dollars, and not recoverable in any other unit. */
  realizedPnlUsd: number
}

export interface RowPnl {
  effectiveAvgEntry: number
  source: EntrySource
  /** What was actually bought at the entry price, with accrued interest taken out. */
  netPrincipal: number
  priceGainUsd: number
  interestUsd: number
  realizedPnlUsd: number
  totalPnlUsd: number
}

/** A row with nothing to say. Distinct from a row whose P&L happens to be zero. */
const unpriced = (entry: EntryPrice): RowPnl => ({
  effectiveAvgEntry: 0,
  source: entry.source,
  netPrincipal: 0,
  priceGainUsd: 0,
  interestUsd: 0,
  realizedPnlUsd: 0,
  totalPnlUsd: 0,
})

/**
 * One asset's profit and loss, in dollars.
 *
 * Three legs. `priceGainUsd` is unrealized and is the only one that needs an entry price;
 * `interestUsd` and `realizedPnlUsd` are facts that already happened. The price leg is signed by
 * side — a supply gains as the asset rises, a borrow gains as it falls, and reversing that would
 * report every profitable short as a loss of the same size.
 *
 * Interest is excluded from the priced quantity. It arrives as additional tokens, and valuing
 * those at the price delta would credit a gain to collateral that was never bought at the entry.
 *
 * With no entry price the whole row is reported empty rather than partially filled. An entry of
 * zero would otherwise price the entire holding as profit, which is the most flattering possible
 * way to be wrong.
 */
export function rowPnl(input: RowPnlInput): RowPnl {
  const { side, entry, currentPriceUsd, amount, interestTokens, interestUsd, realizedPnlUsd } = input
  if (!(entry.usd > 0)) return unpriced(entry)

  const netPrincipal = Math.max(0, amount - interestTokens)
  const priceDelta = side === 'supply' ? currentPriceUsd - entry.usd : entry.usd - currentPriceUsd
  const priceGainUsd = priceDelta * netPrincipal

  return {
    effectiveAvgEntry: entry.usd,
    source: entry.source,
    netPrincipal,
    priceGainUsd,
    interestUsd,
    realizedPnlUsd,
    totalPnlUsd: realizedPnlUsd + priceGainUsd + interestUsd,
  }
}

/**
 * The account total.
 *
 * Summed from the SAME rows the table renders, rather than recomputed from the raw positions, so
 * the headline figure cannot disagree with the lines beneath it — which it could when an override
 * was applied to a row but not to the total.
 */
export function portfolioPnl(rows: readonly RowPnl[]): number {
  return rows.reduce((sum, r) => sum + r.totalPnlUsd, 0)
}
