/**
 * Pure math for opening a leveraged position.
 *
 * Everything strategies-sdk's sizeOpen needs that the SDK deliberately does not do itself:
 * turning prices and quotes into a swap rate, deciding whether a re-quote is warranted, and
 * bounding the leverage slider. No React, no network, no config.
 */
import { WAD } from './strategies-sdk'

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
