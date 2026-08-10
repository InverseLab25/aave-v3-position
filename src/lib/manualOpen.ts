import { BPS, ceilDiv } from './strategies-sdk/sizing'
import type { MarginLocation } from './strategies-sdk/sizing'

/**
 * Validation for hand-entered open amounts.
 *
 * `sizeOpen` solves margin + leverage into amounts and so cannot produce a combination the
 * contract rejects. Typed amounts can, and the expensive failure is a revert the user pays gas
 * for. Every check here maps to a specific on-chain guard, named in its comment.
 */

export type ManualOpenError =
  | 'ZERO_FLASH'
  | 'ZERO_BORROW'
  | 'MARGIN_EXCEEDS_BALANCE'
  | 'RATCHET_NO_POSITION'
  | 'SWAP_SHORTFALL'
  | 'LTV_EXCEEDED'

/** A realized rate, taken from a live quote rather than the oracle. */
export interface ManualQuote {
  amountIn: bigint
  amountOut: bigint
}

export interface ManualOpenInput {
  marginIn: MarginLocation
  marginAmount: bigint
  borrowAmount: bigint
  /** Flash-borrowed from Morpho, always denominated in the COLLATERAL asset. */
  flashAmount: bigint
  marginBalance: bigint
  /** Aave market-reference price, 8 decimals. */
  collateralPriceUsd: bigint
  debtPriceUsd: bigint
  collateralDecimals: number
  debtDecimals: number
  /** The NEW collateral reserve's own base parameters. */
  ltvBps: bigint
  liquidationThresholdBps: bigint
  /** `getUserAccountData` totals, 8dp USD — the same scale the prices above produce. */
  existingCollateralUsd: bigint
  existingDebtUsd: bigint
  /**
   * The account's CURRENT collateral-weighted LTV and liquidation threshold, in bps, straight
   * from `getUserAccountData` — so eMode and every already-supplied reserve are already baked
   * in. Zero when nothing is supplied, where `blendAccountBps` falls back to the new reserve's
   * own values.
   */
  existingLtvBps: bigint
  existingLiquidationThresholdBps: bigint
  /** Null until the first quote round lands. */
  quote: ManualQuote | null
  slippageBps: bigint
}

export interface ManualProjection {
  expectedSwapOut: bigint
  expectedCollateral: bigint
  expectedDebt: bigint
  /** Null on the ratchet path: equity added is ~zero, so the ratio says nothing. */
  expectedLeverageBps: bigint | null
  expectedHealthFactorBps: bigint
  impliedLtvBps: bigint
  /**
   * The collateral-weighted average LTV the resulting ACCOUNT would carry — the ceiling
   * `impliedLtvBps` has to clear, and not generally the new reserve's own `ltvBps`.
   */
  avgLtvBps: bigint
}

export type ManualOpenResult =
  | { ok: true; projection: ManualProjection }
  | { ok: false; error: ManualOpenError; suggestedBorrow: bigint | null }

/** The contract swaps borrow PLUS margin on the debt path — AaveV3Strategies.sol:491. */
function swapInFor(p: ManualOpenInput): bigint {
  return p.borrowAmount + (p.marginIn === 'debt' ? p.marginAmount : 0n)
}

function usd(amount: bigint, priceUsd: bigint, decimals: number): bigint {
  return (amount * priceUsd) / 10n ** BigInt(decimals)
}

/**
 * The borrow that would clear the flash at the rate the quote actually realized — not the
 * oracle's. Using the quote's own rate means the suggestion clears on the next attempt rather
 * than landing just short again.
 */
function suggestBorrow(p: ManualOpenInput, q: ManualQuote): bigint | null {
  const neededIn = ceilDiv(p.flashAmount * q.amountIn, q.amountOut)
  const padded = ceilDiv(neededIn * (BPS + p.slippageBps), BPS)
  const borrow = padded - (p.marginIn === 'debt' ? p.marginAmount : 0n)
  return borrow > 0n ? borrow : null
}

/**
 * Aave judges a borrow, and a liquidation, against the COLLATERAL-WEIGHTED AVERAGE of every
 * supplied reserve's parameters — not the incoming reserve's own. Applying the new reserve's
 * `ltvBps` to account-wide totals therefore rejects positions Aave would accept (when existing
 * collateral is looser, or eMode is on) and — the expensive direction — accepts borrows Aave
 * reverts (when existing collateral is tighter), leaving the user to pay the gas.
 *
 * That is the NORMAL case on the ratchet path rather than an edge one: ratchet requires a
 * pre-existing position by construction, so existing collateral always dominates the blend.
 *
 * `existingBps` arrives already weighted across the existing account, so weighting the two
 * sides by USD value is the whole calculation. With nothing supplied the denominator collapses
 * to the new collateral alone and this reduces exactly to `newBps`.
 */
function blendAccountBps(existingUsd: bigint, existingBps: bigint, newUsd: bigint, newBps: bigint): bigint {
  const total = existingUsd + newUsd
  if (total <= 0n) return newBps
  return (existingUsd * existingBps + newUsd * newBps) / total
}

function project(p: ManualOpenInput, expectedSwapOut: bigint): ManualProjection {
  // The collateral path supplies flash + margin and the output repays the flash, leaving the
  // surplus in the position. The debt path supplies the flash alone and the whole output lands
  // as collateral — the margin is already inside it. Mirrors AaveV3Strategies.sol:479-491, and
  // matches `sizeOpen`'s expectedCollateral for the same flows.
  const expectedCollateral = p.marginIn === 'debt' ? expectedSwapOut : p.marginAmount + expectedSwapOut

  const newCollUsd = usd(expectedCollateral, p.collateralPriceUsd, p.collateralDecimals)
  const collUsd = newCollUsd + p.existingCollateralUsd
  const debtUsd = usd(p.borrowAmount, p.debtPriceUsd, p.debtDecimals) + p.existingDebtUsd
  const equityUsd = collUsd - debtUsd

  // Account-wide totals must be judged by account-wide parameters — see `blendAccountBps`.
  const avgLtvBps = blendAccountBps(
    p.existingCollateralUsd, p.existingLtvBps, newCollUsd, p.ltvBps,
  )
  const avgLiquidationThresholdBps = blendAccountBps(
    p.existingCollateralUsd, p.existingLiquidationThresholdBps, newCollUsd, p.liquidationThresholdBps,
  )

  return {
    expectedSwapOut,
    expectedCollateral,
    expectedDebt: p.borrowAmount,
    expectedLeverageBps:
      p.marginIn === 'none' || equityUsd <= 0n ? null : (collUsd * BPS) / equityUsd,
    expectedHealthFactorBps: debtUsd > 0n ? (collUsd * avgLiquidationThresholdBps) / debtUsd : 0n,
    impliedLtvBps: collUsd > 0n ? (debtUsd * BPS) / collUsd : BPS,
    avgLtvBps,
  }
}

export function validateManualOpen(p: ManualOpenInput): ManualOpenResult {
  const fail = (error: ManualOpenError, suggestedBorrow: bigint | null = null): ManualOpenResult =>
    ({ ok: false, error, suggestedBorrow })

  // The contract's own ZeroAmount guards — AaveV3Strategies.sol:274 and :331.
  if (p.flashAmount <= 0n) return fail('ZERO_FLASH')
  if (p.borrowAmount <= 0n) return fail('ZERO_BORROW')
  if (p.marginAmount > p.marginBalance) return fail('MARGIN_EXCEEDS_BALANCE')

  // Ratchet adds no equity, so with nothing already supplied it opens a position the user has
  // no stake in — and the borrow would have no collateral to sit against.
  if (p.marginIn === 'none' && p.existingCollateralUsd <= 0n) return fail('RATCHET_NO_POSITION')

  // Before the first quote there is no rate to judge coverage against. Project the shape of the
  // position anyway so the preview renders, and let the quote round decide.
  if (!p.quote || p.quote.amountIn <= 0n || p.quote.amountOut <= 0n) {
    return { ok: true, projection: project(p, 0n) }
  }

  const expectedSwapOut = (swapInFor(p) * p.quote.amountOut) / p.quote.amountIn

  // The hard floor: the swap output must repay the flash, or the whole transaction reverts —
  // AaveV3Strategies.sol:502, which fires independently of the user's minOut.
  if (expectedSwapOut < p.flashAmount) {
    return fail('SWAP_SHORTFALL', suggestBorrow(p, p.quote))
  }

  const projection = project(p, expectedSwapOut)

  // Aave's `borrow` reverts at the LTV wall, so land strictly below it. The wall is the
  // account's blended LTV, which is what `validateBorrow` actually compares against.
  if (projection.impliedLtvBps >= projection.avgLtvBps) return fail('LTV_EXCEEDED')

  return { ok: true, projection }
}

/**
 * User-facing copy for a manual rejection. The enum members are internal names meant for logs;
 * showing them raw is the same mistake `sizeOpenErrorMessage` exists to avoid.
 *
 * Amounts arrive pre-formatted as strings — this module is bigint-only and has no business
 * knowing decimals or locale.
 */
export function manualOpenErrorMessage(
  error: ManualOpenError,
  ctx: {
    marginSymbol: string
    debtSymbol: string
    collateralSymbol: string
    marginBalance: string
    shortfall: string
    suggestedBorrow: string | null
  },
): string {
  switch (error) {
    case 'ZERO_FLASH':
      return 'Enter a flash amount'
    case 'ZERO_BORROW':
      return 'Enter a debt amount'
    case 'MARGIN_EXCEEDS_BALANCE':
      return `You have ${ctx.marginBalance} ${ctx.marginSymbol}`
    case 'RATCHET_NO_POSITION':
      return 'Ratchet needs collateral already supplied — post margin instead'
    case 'SWAP_SHORTFALL': {
      const fix = ctx.suggestedBorrow
        ? ` Raise debt to about ${ctx.suggestedBorrow} ${ctx.debtSymbol}, or lower the flash.`
        : ' Lower the flash amount.'
      return `The borrow is ${ctx.shortfall} ${ctx.collateralSymbol} short of repaying the flash.${fix}`
    }
    case 'LTV_EXCEEDED':
      return `Too much debt against this much ${ctx.collateralSymbol} — Aave would reject the borrow`
  }
}
