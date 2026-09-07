import type { TransactionPayload } from './types'

/** What a simulation that actually ran reports back. */
export interface SimulationResult {
  /** False when the call reverted. `amountOut` is then zero and tells you nothing. */
  ok: boolean
  /** Output measured as the sum of destination-token transfers to `from`, so taxes and router
   *  fees are in it. */
  amountOut: bigint
  /** Gas the call to `to` consumed. Excludes the 21k intrinsic and calldata gas. */
  gasUsed: number
  revertReason?: string
}

export interface SimulationInput {
  chainId: number
  /** Sender and recipient. Needs no funds: balance and allowance are overridden. */
  from: string
  /** The built transaction's target. */
  to: string
  /** The approval target. Equal to `to` for everything the leverage flows execute. */
  spender: string
  data: string
  tokenIn: string
  amountIn: string
  tokenOut: string
}

/**
 * The simulation input for a swap one of the leverage contracts will make.
 *
 * Shared by the open, close and flip flows so the three cannot drift on the part that is easy
 * to get subtly wrong. Every field here has a plausible wrong answer that still returns a
 * number rather than an error: the user's wallet instead of the contract that actually holds
 * the tokens mid-flash-loan, the position's assets instead of the swap's, or the size the
 * position was sized to instead of the size this particular quote was priced at. A measurement
 * of the wrong trade is worse than no measurement, because `minOut` is derived from it.
 */
export function swapSimulationInput(args: {
  chainId: number
  /** The contract making the swap — sender and recipient both. */
  caller: string
  tokenIn: string
  tokenOut: string
  /** The quote's own input size, not the position's. */
  amountIn: string
  tx: Pick<TransactionPayload, 'to' | 'spender' | 'data'>
}): SimulationInput {
  return {
    chainId: args.chainId,
    from: args.caller,
    to: args.tx.to,
    spender: args.tx.spender,
    data: args.tx.data,
    tokenIn: args.tokenIn,
    amountIn: args.amountIn,
    tokenOut: args.tokenOut,
  }
}
