/**
 * liquidation — the prices at which an Aave position is liquidated.
 *
 * Aave liquidates when the health factor falls below 1:
 *   HF = Σ(amountᵢ × priceᵢ × LTᵢ) / debtUsd
 *
 * For each asset this module solves that equation for that asset's price, holding every other
 * price fixed — the "isolated" liquidation price that Aave's own UI and DeFi Saver quote. Both
 * sides are solved, because they are liquidated by opposite moves: COLLATERAL by falling, DEBT
 * by rising. A collateral-only view says nothing useful about a short, where the asset the user
 * has a view on is the borrowed one.
 *
 * Only volatile assets are quoted — see the note in `computeLiquidationView`.
 *
 * Thresholds are each reserve's raw `reserveLiquidationThreshold`. E-Mode
 * overrides are deliberately NOT applied; see the spec at
 * docs/superpowers/specs/2026-08-02-collateral-liquidation-price-design.md.
 */

export interface CollateralInput {
  symbol: string
  amount: number
  priceUsd: number
  /** Reserve's own liquidation threshold as a fraction, e.g. 0.825. */
  liquidationThreshold: number
}

/**
 * The subset of a supplied-asset row that the liquidation views read. Deliberately
 * narrower than the full row `useAavePositions` produces — callers map it into
 * `CollateralInput` and touch nothing else. Fields are optional because the source
 * row is assembled from on-chain reads that can legitimately be absent, which is why
 * every call site already defaults them.
 */
export interface SuppliedAssetLike {
  symbol: string
  amount?: number
  priceInUsd?: string
  liquidationThreshold?: number
}

/**
 * A supplied row plus the flag that decides whether it carries liquidation weight at all.
 * Required rather than optional: defaulting a missing flag would silently drop every row, and
 * an empty collateral set reads as "nothing can be liquidated" rather than as a wiring bug.
 */
export interface CollateralSuppliedLike extends SuppliedAssetLike {
  usageAsCollateralEnabledOnUser: boolean
}

/**
 * Supplied rows -> the collateral this module solves against. Only collateral-enabled supplies
 * carry liquidation weight, and Aave liquidates on its own oracle, so the price is `priceInUsd`
 * and never an API price.
 */
export function toCollateralInputs(assets: CollateralSuppliedLike[]): CollateralInput[] {
  return assets
    .filter(a => a.usageAsCollateralEnabledOnUser)
    .map(a => ({
      symbol: a.symbol,
      amount: a.amount ?? 0,
      priceUsd: Number(a.priceInUsd ?? 0),
      liquidationThreshold: a.liquidationThreshold ?? 0,
    }))
}

/**
 * A borrowed asset, for the debt-side solve.
 *
 * Debt has no liquidation threshold of its own — Aave counts it at face value — so unlike
 * {@link CollateralInput} there is nothing to weight it by.
 */
export interface DebtInput {
  symbol: string
  amount: number
  priceUsd: number
}

/** The subset of a borrowed-asset row the debt-side solve reads. */
export interface BorrowedAssetLike {
  symbol: string
  amount?: number
  priceInUsd?: string
}

/** Borrowed rows -> the debt this module solves against, on Aave's own oracle price. */
export function toDebtInputs(assets: BorrowedAssetLike[]): DebtInput[] {
  return assets.map(a => ({
    symbol: a.symbol,
    amount: a.amount ?? 0,
    priceUsd: Number(a.priceInUsd ?? 0),
  }))
}

export interface LiquidationRow {
  symbol: string
  /** null when this asset cannot liquidate the position on its own. */
  liquidationPriceUsd: number | null
  currentPriceUsd: number
  /**
   * Fractional. Negative on a collateral row (-0.32 = a 32% fall), positive on a debt row
   * (+0.41 = a 41% rise). null when price is null.
   */
  bufferPct: number | null
  isVolatile: boolean
  /**
   * Which side of the position this row prices, and so which way the price has to move: a
   * collateral asset liquidates you by FALLING, a debt asset by RISING. Quoting only the first
   * answers the wrong question for a short, where the asset with a view on it is the debt.
   */
  side: 'collateral' | 'debt'
}

export interface LiquidationView {
  rows: LiquidationRow[]
  /** Fractional and normally negative. null when not applicable. */
  marketWideDropPct: number | null
}

/**
 * Whether `LiquidationPriceBlock` has anything to render for this view — the single source of
 * truth for that decision, so surrounding chrome (dividers, spacing, wrapper margins) can key off
 * the same test the block itself uses instead of a stale copy of it.
 *
 * With more than one row the labels are symbol-qualified, so even an all-null view still has
 * something attributed to say ("USDC alone: None"). With one row or none, a null row is unnamed
 * and dropped, so there is something to show only if that lone row is priced.
 */
export function hasLiquidationRowsToShow(view: LiquidationView): boolean {
  return view.rows.length > 1 || view.rows.some(row => row.liquidationPriceUsd !== null)
}

/** Half-width of the band around $1.00 within which an asset counts as a stablecoin. */
export const STABLE_BAND = 0.02

/**
 * A symbol allowlist rots on every new stablecoin listing and silently
 * mislabels a depegged asset as safe, so classify on price instead.
 */
export function isVolatilePrice(priceUsd: number): boolean {
  return Math.abs(priceUsd - 1) > STABLE_BAND
}

export function computeLiquidationView(
  collateral: CollateralInput[],
  debtUsd: number,
  debt: DebtInput[] = [],
): LiquidationView {
  if (debtUsd <= 0.001) return { rows: [], marketWideDropPct: null }

  const usable = collateral.filter(c => c.amount > 0 && c.priceUsd > 0)
  if (usable.length === 0) return { rows: [], marketWideDropPct: null }

  // Total liquidation-threshold-weighted collateral. HF = totalWeighted / debtUsd.
  const totalWeighted = usable.reduce(
    (sum, c) => sum + c.amount * c.priceUsd * c.liquidationThreshold,
    0,
  )

  /**
   * The price a BORROWED asset has to rise to for HF to reach 1, holding every other price fixed.
   *
   * The mirror of the collateral solve below. Aave liquidates at
   * `weightedCollateral == totalDebt`, so with this asset's own contribution taken out of the
   * debt side:  P = (weightedCollateral - otherDebtUsd) / amount.
   */
  const debtRows: LiquidationRow[] = debt
    .filter(d => d.amount > 0 && d.priceUsd > 0)
    .map(d => {
      const otherDebtUsd = debtUsd - d.amount * d.priceUsd
      const headroomUsd = totalWeighted - otherDebtUsd
      // <= 0 means the rest of the debt already exceeds the weighted collateral: this leg's
      // price cannot be what tips it, because the position is at or past liquidation already.
      const liquidationPriceUsd = headroomUsd > 0 ? headroomUsd / d.amount : null
      return {
        symbol: d.symbol,
        liquidationPriceUsd,
        currentPriceUsd: d.priceUsd,
        bufferPct: liquidationPriceUsd === null ? null : liquidationPriceUsd / d.priceUsd - 1,
        isVolatile: isVolatilePrice(d.priceUsd),
        side: 'debt' as const,
      }
    })

  const rows: LiquidationRow[] = usable.map(c => {
    const weighted = c.amount * c.priceUsd * c.liquidationThreshold
    // Debt left uncovered once every OTHER asset's weighted collateral is applied.
    const uncovered = debtUsd - (totalWeighted - weighted)
    const denominator = c.amount * c.liquidationThreshold

    // denominator === 0 -> the asset carries no liquidation weight at all.
    // uncovered <= 0     -> the other collateral already covers the debt, so this
    //                       asset could fall to zero without liquidating anything.
    const canLiquidate = denominator > 0 && uncovered > 0
    const liquidationPriceUsd = canLiquidate ? uncovered / denominator : null

    return {
      symbol: c.symbol,
      liquidationPriceUsd,
      currentPriceUsd: c.priceUsd,
      bufferPct: liquidationPriceUsd === null ? null : liquidationPriceUsd / c.priceUsd - 1,
      isVolatile: isVolatilePrice(c.priceUsd),
      side: 'collateral' as const,
    }
  })
  rows.push(...debtRows)

  // Quote only assets whose price can plausibly reach the number.
  //
  // A stablecoin's liquidation price is arithmetically correct and practically meaningless — a
  // USDC row reading "$0.03" invites the reader to treat a depeg as the risk when the real one
  // is the volatile leg on the other side. Dropping the ROW does not drop the asset: stable
  // collateral still carries its full weight in `totalWeighted`, and stable debt still counts in
  // `debtUsd`, so every price quoted here already accounts for it.
  const priceable = rows.filter(r => r.isVolatile)

  // Closest to liquidation first: the asset needing the SMALLEST move leads, whichever way it
  // has to move — collateral buffers are negative and debt buffers positive, so the comparison
  // is on MAGNITUDE. Among collateral rows alone that is the same order as before (all negative,
  // so smallest magnitude is the largest value). Rows that cannot liquidate the position have no
  // buffer and sort last.
  priceable.sort((a, b) => {
    if (a.bufferPct === null && b.bufferPct === null) return 0
    if (a.bufferPct === null) return 1
    if (b.bufferPct === null) return -1
    return Math.abs(a.bufferPct) - Math.abs(b.bufferPct)
  })

  // Collateral-only by design: it answers "how far can the market fall", and debt rising is a
  // different question that no single factor across both sides would express.
  return { rows: priceable, marketWideDropPct: marketWideDrop(usable, totalWeighted, debtUsd) }
}

/**
 * The single factor by which every volatile collateral would have to fall
 * *together* to reach HF = 1, with stablecoin collateral holding its value.
 *
 * Returns null when the figure would be noise or meaningless:
 *  - fewer than 2 volatile collaterals (identical to that one asset's own row)
 *  - no volatile weight at all
 *  - stablecoin collateral alone already covers the debt
 */
function marketWideDrop(
  usable: CollateralInput[],
  totalWeighted: number,
  debtUsd: number,
): number | null {
  const volatile = usable.filter(c => isVolatilePrice(c.priceUsd))
  if (volatile.length < 2) return null

  const weightedVolatile = volatile.reduce(
    (sum, c) => sum + c.amount * c.priceUsd * c.liquidationThreshold,
    0,
  )
  if (!(weightedVolatile > 0)) return null

  const weightedStable = totalWeighted - weightedVolatile
  const factor = (debtUsd - weightedStable) / weightedVolatile
  if (!(factor > 0)) return null

  return factor - 1
}
