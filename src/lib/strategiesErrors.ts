/**
 * Turns an AaveV3Strategies revert into something a user can act on.
 *
 * The distinction that earns this module its existence: a router shortfall and a flash-repayment
 * shortfall look identical in a wallet, but the first means the swap missed the user's slippage
 * tolerance and the second means the borrow was sized too small for a rate that moved. Offering
 * "increase slippage" for the second would send the user round the same loop again.
 */
import { decodeErrorResult, parseAbi, type Hex } from 'viem'

export type StrategiesRemedy = 'widen-slippage' | 'requote' | 'refresh' | 'none'

interface StrategiesFailure {
  /** The Solidity error name, for logs. */
  error: string
  /** What to show the user. */
  message: string
  remedy: StrategiesRemedy
}

/** Only the errors a user can actually trip; the callback-guard errors are unreachable from here. */
const errorAbi = parseAbi([
  'error InsufficientOutputFromRouter()',
  'error InsufficientOutputForFlashLoanRepayment()',
  'error RouterNotAllowed()',
  'error Paused()',
  'error ZeroAmount()',
  'error SameAsset()',
  'error ZeroAddress()',
  'error NoDebt()',
] as const)

const FAILURES: Record<string, { message: string; remedy: StrategiesRemedy }> = {
  InsufficientOutputFromRouter: {
    message: 'The swap returned less than your slippage tolerance allowed. Try a wider slippage.',
    remedy: 'widen-slippage',
  },
  InsufficientOutputForFlashLoanRepayment: {
    message: 'The price moved and the borrow no longer covers the flash loan. Refresh the quote.',
    remedy: 'requote',
  },
  RouterNotAllowed: {
    message: 'That router is no longer allowlisted. Refresh to pick another route.',
    remedy: 'refresh',
  },
  Paused: { message: 'The contract is paused. Try again later.', remedy: 'refresh' },
  ZeroAmount: { message: 'One of the amounts was zero.', remedy: 'none' },
  SameAsset: { message: 'Collateral and debt must be different assets.', remedy: 'none' },
  ZeroAddress: { message: 'An address was missing.', remedy: 'none' },
  NoDebt: { message: 'This position has no debt.', remedy: 'none' },
}

/** Walks the error chain for the 4-byte revert data viem hangs off `cause`. */
function revertData(err: unknown): Hex | null {
  let node: unknown = err
  for (let depth = 0; node && typeof node === 'object' && depth < 5; depth++) {
    const data = (node as { data?: unknown }).data
    if (typeof data === 'string' && data.startsWith('0x')) return data as Hex
    node = (node as { cause?: unknown }).cause
  }
  return null
}

/** The mapped failure, or null when this is not a Strategies revert we recognise. */
export function decodeStrategiesError(err: unknown): StrategiesFailure | null {
  const data = revertData(err)
  if (!data) return null

  try {
    const { errorName } = decodeErrorResult({ abi: errorAbi, data })
    const mapped = FAILURES[errorName]
    return mapped ? { error: errorName, ...mapped } : null
  } catch {
    // Not one of ours — an unrelated revert, or data too short to decode.
    return null
  }
}
