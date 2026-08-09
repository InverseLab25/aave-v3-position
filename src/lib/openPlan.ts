/**
 * Pure math for opening a leveraged position.
 *
 * Everything strategies-sdk's sizeOpen needs that the SDK deliberately does not do itself:
 * turning prices and quotes into a swap rate, deciding whether a re-quote is warranted, and
 * bounding the leverage slider. No React, no network, no config.
 */
import {
  BPS,
  LTV_CEILING_FACTOR_BPS,
  WAD,
  maxLeverageForHealthFactorBps,
  maxLeverageForLtvBps,
  type SizeOpenError,
} from './strategies-sdk'

export interface OracleRateInput {
  /** Aave oracle prices, both on the same fixed-point scale. */
  collateralPriceUsd: bigint
  debtPriceUsd: bigint
  collateralDecimals: number
  debtDecimals: number
}

/**
 * A seed rate from oracle prices, in collateral wei per debt wei scaled by WAD.
 *
 * Free — costs no network call. But oracle prices are mid-market: they know nothing about the
 * DEX spread or this trade's price impact, so a size derived from this alone runs optimistic
 * and must be verified against a real quote before it is signed.
 *
 * Returns 0 when either price is missing, so sizeOpen rejects with ZERO_RATE instead of the
 * caller dividing by zero here.
 */
export function rateFromOracle(p: OracleRateInput): bigint {
  if (p.collateralPriceUsd <= 0n || p.debtPriceUsd <= 0n) return 0n
  return (
    (p.debtPriceUsd * 10n ** BigInt(p.collateralDecimals) * WAD) /
    (p.collateralPriceUsd * 10n ** BigInt(p.debtDecimals))
  )
}

/**
 * The rate an aggregator actually offered, in collateral wei per debt wei scaled by WAD.
 *
 * Authoritative for the size it was quoted at and no other — pricing is non-linear, so a rate
 * measured at one amount understates the impact of a materially larger one.
 */
export function rateFromQuote(p: { amountIn: bigint; amountOut: bigint }): bigint {
  if (p.amountIn <= 0n) return 0n
  return (p.amountOut * WAD) / p.amountIn
}

/** Quote, re-size, and at most one re-quote. Pricing is non-linear; a third round buys nothing. */
export const MAX_REFINE_ROUNDS = 2

/**
 * The health factor the leverage slider's safe range is built around.
 *
 * Fixed in this phase rather than user-configurable: the danger zone past it is an explicit
 * opt-in, which is a clearer control than letting the boundary itself be dragged.
 */
export const OPEN_TARGET_HF_BPS = 15_000n

/**
 * Whether the re-sized borrow warrants a fresh quote.
 *
 * Only growth does. A larger trade eats more price impact than the quote measured, so its rate
 * is optimistic and re-pricing is the honest move. A smaller trade prices at least as well —
 * the quote is a conservative floor for it, and re-quoting would only cost a round-trip.
 */
export function needsRequote(quotedAmountIn: bigint, resizedAmountIn: bigint): boolean {
  return resizedAmountIn > quotedAmountIn
}

/**
 * The swap-output floor to send on-chain, derived from the BUILT route.
 *
 * Built from `buildTransaction`'s amountOut rather than the quote's, because the build is
 * re-simulated and therefore authoritative — see TransactionPayload.amountOut.
 *
 * Never drops below `flashAmount`: the contract enforces both floors, and an output short of
 * the flash repayment reverts the whole transaction rather than merely disappointing.
 */
export function minOutFromBuild(p: {
  buildAmountOut: bigint
  slippageBps: bigint
  flashAmount: bigint
}): bigint {
  const slippageFloor = (p.buildAmountOut * (BPS - p.slippageBps)) / BPS
  return slippageFloor > p.flashAmount ? slippageFloor : p.flashAmount
}

/**
 * The two bounds the leverage slider needs.
 *
 * `hard` is Aave's LTV wall with the SDK's haircut applied — past it the borrow itself
 * reverts. `soft` is the leverage that still holds OPEN_TARGET_HF_BPS, and is the end of the
 * slider's safe range; the stretch between soft and hard is the opt-in danger zone.
 *
 * `soft` is null when the target HF is unreachable at any finite leverage, and `hard` is null
 * for an LTV at or above 100% — neither is a valid Aave reserve, but neither should throw.
 */
export function leverageCeilingBps(p: {
  ltvBps: bigint
  liquidationThresholdBps: bigint
}): { soft: bigint | null; hard: bigint | null } {
  const wall = maxLeverageForLtvBps(p.ltvBps)
  if (wall === null) return { soft: null, hard: null }

  const hard = (wall * LTV_CEILING_FACTOR_BPS) / BPS
  const target = maxLeverageForHealthFactorBps(p.liquidationThresholdBps, OPEN_TARGET_HF_BPS)
  if (target === null) return { soft: null, hard }

  return { soft: target > hard ? hard : target, hard }
}

/** Leverage slider step, in bps. Also the amount trimmed off the `hard` wall — see `sliderMax`. */
export const LEVERAGE_STEP_BPS = 100n

/**
 * The leverage slider's upper bound.
 *
 * `hard` (from `leverageCeilingBps`) is EXCLUSIVE: `sizeOpen` rejects with LEVERAGE_ABOVE_LTV
 * once `leverageBps >= ceiling`, and `ceiling` is exactly `hard`. A slider whose max is `hard`
 * therefore lets a user drag to a value the SDK then rejects. So whenever the computed ceiling
 * (soft, or hard once the danger zone is opened, or hard again when soft is unreachable) lands
 * exactly on `hard`, back it off by one slider step so every reachable value is accepted. `soft`
 * is normally strictly below `hard` and needs no adjustment — except the clamped case where
 * `leverageCeilingBps` itself sets `soft = hard`, which this same check catches.
 *
 * Lives here rather than in OpenPositionForm.tsx (which renders the slider) so LeverageActions
 * can clamp its `leverageBps` state to the same ceiling without either duplicating this math or
 * importing it from a component file — the latter trips
 * react-refresh/only-export-components, which wants component files to export components only.
 */
export function sliderMax(soft: bigint | null, hard: bigint, dangerEnabled: boolean): bigint {
  const raw = dangerEnabled || soft === null ? hard : soft
  return raw === hard ? hard - LEVERAGE_STEP_BPS : raw
}

/**
 * User-facing copy for a sizing rejection, per the design spec's "Sizing rejections" table.
 *
 * `SizeOpenError`'s members are internal enum names (`LEVERAGE_ABOVE_LTV`) meant for logs, not
 * a UI — showing them raw is Task "IMPORTANT 7". `LEVERAGE_ABOVE_LTV` additionally needs the
 * actual ceiling: the slider already clamps to it, so the message is only a backstop
 * explanation for whatever got the user past the slider (e.g. the danger-zone toggle).
 */
export function sizeOpenErrorMessage(
  error: SizeOpenError,
  ctx: { collateralSymbol: string; hardCeilingBps: bigint | null },
): string {
  switch (error) {
    case 'ZERO_MARGIN':
      return 'Enter a margin amount'
    case 'LEVERAGE_TOO_LOW':
      return 'Leverage must be above 1x'
    case 'LEVERAGE_ABOVE_LTV': {
      const n = ctx.hardCeilingBps !== null ? (Number(ctx.hardCeilingBps) / 10000).toFixed(2) : '?'
      return `Max leverage for ${ctx.collateralSymbol} is ${n}x`
    }
    case 'ZERO_RATE':
    case 'ZERO_PRICE':
      return 'Price data unavailable — retry'
    case 'INVALID_LTV':
      return 'This asset can\'t be used as collateral'
  }
}
