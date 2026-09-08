import { formatUnits, type Address } from 'viem'

/**
 * Why a close could not be planned. The three cases need different responses, and prose
 * alone cannot be branched on:
 *
 *  - `wallet`     — nothing connected yet. Not something the modal asks the user to fix.
 *  - `deployment` — paused contract, empty router allowlist, unsupported chain. Picking
 *                   different collateral cannot help; only the operator can fix it.
 *  - `pair`       — no route, underwater position, native sentinel. Actionable: try other
 *                   collateral.
 *
 * Reporting a `deployment` failure as if it were a `pair` failure is what sends users
 * round in circles trying every collateral they hold.
 */
/**
 * `aggregator` is deliberately not `pair`: the price source refused to answer, so nothing has
 * been learned about this pair and picking a different one will not help. Waiting will.
 */
export type CloseErrorKind = 'wallet' | 'deployment' | 'pair' | 'aggregator'

export class CloseError extends Error {
  readonly kind: CloseErrorKind

  constructor(kind: CloseErrorKind, message: string) {
    super(message)
    this.name = 'CloseError'
    this.kind = kind
  }
}

/**
 * Normalise anything thrown during planning into a kind and a message. An unrecognised
 * throw is reported as `pair` — the only kind that invites the user to try something else,
 * which is the safe default when we do not actually know what failed.
 */
export function toCloseError(e: unknown): { kind: CloseErrorKind; message: string } {
  if (e instanceof CloseError) return { kind: e.kind, message: e.message }
  return { kind: 'pair', message: e instanceof Error ? e.message : String(e) }
}

/**
 * Significant digits every rate is carried at, whatever its magnitude.
 *
 * A FIXED number of decimal places cannot do this job, because a rate's magnitude is a property
 * of the pair rather than of the code: 67,754 USDT for 36.1 WETH is 0.000532986… one way round
 * and 1,876.21 the other, and six decimal places keep sixteen significant digits of the second
 * and three of the first. Three is enough to read the price and not enough to invert it — 0.000532
 * inverts to 1,879.70, which is a wrong number rather than a rounded one.
 */
const RATE_SIGNIFICANT_DIGITS = 18

/** Floor on the working scale, so a rate in the millions still carries its cents. */
const MIN_RATE_DECIMALS = 6

/** Ceiling on it, so a rate approaching zero cannot ask for an unbounded string. */
const MAX_RATE_DECIMALS = 48

/**
 * Decimal places to carry a quotient at so it keeps {@link RATE_SIGNIFICANT_DIGITS} of them.
 *
 * The digit counts differ by at most one from log10 of the quotient, which is as much precision
 * as choosing a scale needs — being one place out costs a spare digit, never a significant one.
 */
function rateScale(numerator: bigint, denominator: bigint): number {
  const magnitude = numerator.toString().length - denominator.toString().length
  const wanted = RATE_SIGNIFICANT_DIGITS - magnitude
  return Math.min(MAX_RATE_DECIMALS, Math.max(MIN_RATE_DECIMALS, wanted))
}

/**
 * Debt token per 1 collateral token on a quote, as a decimal string.
 *
 * The two sides have different decimals, so the ratio has to be rescaled:
 *   rate = (expectedOut / 10^debtDec) / (requiredIn / 10^collDec)
 * Evaluated in bigint by folding both scales and the working scale into the numerator before
 * the single division, so the only rounding is one truncation at the end — converting each
 * side to a double first would round twice before the divide even happens.
 *
 * Returns null when nothing is being swapped and no rate is defined.
 */
export function quoteRate(
  expectedOut: bigint,
  requiredIn: bigint,
  collateralDecimals: number,
  debtDecimals: number,
): string | null {
  if (requiredIn <= 0n) return null
  const numerator = expectedOut * 10n ** BigInt(collateralDecimals)
  const denominator = requiredIn * 10n ** BigInt(debtDecimals)
  const scale = rateScale(numerator, denominator)
  return formatUnits((numerator * 10n ** BigInt(scale)) / denominator, scale)
}

/** EIP-2612 typed data for an Aave V3 aToken permit (spender = deleverager). */
export function buildPermitTypedData(args: {
  aToken: Address
  aTokenName: string
  chainId: number
  owner: Address
  spender: Address
  value: bigint
  nonce: bigint
  deadline: bigint
}) {
  return {
    domain: {
      name: args.aTokenName,
      version: '1', // Aave V3 aToken EIP712_REVISION
      chainId: args.chainId,
      verifyingContract: args.aToken,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit' as const,
    message: {
      owner: args.owner,
      spender: args.spender,
      value: args.value,
      nonce: args.nonce,
      deadline: args.deadline,
    },
  }
}
