/**
 * How to format the tokens a receipt can name, and which ones not to report at all.
 *
 * A leveraged open or close moves the aToken and the variable-debt token as well as the
 * underlyings — Aave mints and burns both as transfers from and to the zero address, so they land
 * in the wallet's netted deltas. They are the POSITION rather than the wallet, and the position
 * already has a panel of its own, so they are filtered out of the settled report instead of
 * padding it with a second copy of what the projection said.
 */
import type { Address } from 'viem'

export interface TokenMeta {
  symbol: string
  decimals: number
}

/** What both screens already hold about a reserve, whichever of their own shapes it came in. */
export interface TokenMetaSource {
  symbol: string
  decimals: number
  underlyingAsset: Address
  /** Aave's interest-bearing token — the collateral side of a position. */
  aTokenAddress?: Address
  /** Aave's variable-debt token — the borrowed side. */
  variableDebtTokenAddress?: Address
}

/** Symbol and decimals per underlying token, keyed by LOWER-CASED address. */
export function buildTokenMap(
  sources: readonly (TokenMetaSource | null | undefined)[],
): Record<string, TokenMeta> {
  const map: Record<string, TokenMeta> = {}
  for (const s of sources) {
    if (!s) continue
    map[s.underlyingAsset.toLowerCase()] = { symbol: s.symbol, decimals: s.decimals }
  }
  return map
}

/** The aToken and variable-debt addresses of these reserves — the rows to leave out. */
export function positionTokens(
  sources: readonly (TokenMetaSource | null | undefined)[],
): Address[] {
  const found: Address[] = []
  for (const s of sources) {
    if (!s) continue
    if (s.aTokenAddress) found.push(s.aTokenAddress)
    if (s.variableDebtTokenAddress) found.push(s.variableDebtTokenAddress)
  }
  return found
}
