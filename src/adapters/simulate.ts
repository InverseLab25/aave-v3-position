import { limitedFetch } from './http'
import type { TransactionPayload } from './types'
import { ATTRIBUTION } from './nordstern'

/**
 * Gas limit every simulation runs under.
 *
 * The endpoint defaults to 50% of the block gas limit, and under that default a route above
 * roughly 400k USDC comes back `success: false` with a bare `Call failed` at ~14.1M gas —
 * which reads exactly like a revert and is not one. Measured on Base: a KyberSwap route that
 * "reverted" on the default succeeded at this limit, using 33.9M.
 *
 * Deliberately far above any chain's per-transaction cap. The point is to measure what a route
 * really costs, including when that turns out to be more than the chain will allow; judging it
 * against the cap is the caller's job and needs the true figure to do it.
 */
export const SIMULATION_GAS = 60_000_000

/** What a simulation that actually ran reports back. */
export interface SimulationResult {
  /** False when the call reverted. `amountOut` is then zero and tells you nothing. */
  ok: boolean
  /** Output measured as a real balance delta at `from`, so taxes and router fees are in it. */
  amountOut: bigint
  /** Gas the call to `to` consumed. Excludes the 21k intrinsic and calldata gas. */
  gasUsed: number
  revertReason?: string
}

export interface SimulationInput {
  chainId: number
  /** Sender and recipient. Needs no funds: balance and allowance are overridden to `amountIn`. */
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

/**
 * What a route would actually return, measured against live chain state.
 *
 * Null means the question could not be asked — the simulator was unreachable, refused, or
 * answered with something unreadable. That is NOT evidence about the route, and a caller must
 * not treat it as one; fall back to the aggregator's own figure instead. A route that ran and
 * reverted comes back as a result with `ok: false`, which IS evidence.
 */
export async function simulateSwap(
  input: SimulationInput,
  signal?: AbortSignal,
): Promise<SimulationResult | null> {
  try {
    const res = await limitedFetch(`https://api.nordstern.finance/simulate/${input.chainId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ATTRIBUTION },
      signal,
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        spender: input.spender,
        data: input.data,
        tokenIn: input.tokenIn,
        amountIn: input.amountIn,
        tokenOut: input.tokenOut,
        gas: String(SIMULATION_GAS),
      }),
    })
    // A reverting route is still a 200. Anything else is the service failing, not the route.
    if (!res.ok) return null

    const json = (await res.json()) as {
      success?: boolean
      amountOut?: string
      gasUsed?: number
      revertReason?: string
    }
    if (json.amountOut === undefined) return null

    return {
      ok: json.success === true,
      amountOut: BigInt(json.amountOut),
      gasUsed: json.gasUsed ?? 0,
      ...(json.revertReason !== undefined && { revertReason: json.revertReason }),
    }
  } catch {
    return null
  }
}
