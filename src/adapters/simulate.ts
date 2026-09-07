import { keccak256, encodeAbiParameters } from 'viem'
import { limitedFetch } from './http'
import { simulationRpc } from '../config/rpc'
import type { TransactionPayload } from './types'

/**
 * Gas limit every simulation runs under.
 *
 * Deliberately far above any chain's per-transaction cap. The point is to measure what a route
 * really costs, including when that turns out to be more than the chain will allow; judging it
 * against the cap is the caller's job and needs the true figure to do it. Measured on Base, a
 * KyberSwap route at 1M USDC used 33.9M.
 */
export const SIMULATION_GAS = 60_000_000

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

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad32 = (address: string) => '0x' + address.slice(2).toLowerCase().padStart(64, '0')

/** Storage key for `mapping(address => T)` at `slot`, and for one nested a level deeper. */
const slot1 = (key: string, slot: number) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key as `0x${string}`, BigInt(slot)]))
const slot2 = (a: string, b: string, slot: number) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [b as `0x${string}`, slot1(a, slot)]))

/** Enough of anything to cover any trade, written into the balance and allowance slots. */
const HUGE = '0x' + (10n ** 30n).toString(16).padStart(64, '0')

interface Slots {
  bal: number
  allow: number
}

/**
 * Token storage layouts already established, so the probe never runs for them.
 *
 * A deployed token's layout cannot change: the slots are fixed by its source, and an
 * upgradeable proxy has to preserve them or it breaks its own storage. So this is a cache with
 * no invalidation problem, and skipping the probe saves forty round trips before a quote.
 *
 * Each entry was produced by the probe below and agreed with the token.
 */
const KNOWN_SLOTS: Record<string, Slots> = {
  // Base USDC (FiatTokenV2).
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { bal: 9, allow: 10 },
  // Base WETH (WETH9: name, symbol, decimals, balanceOf, allowance).
  '8453:0x4200000000000000000000000000000000000006': { bal: 3, allow: 4 },
}

/** Layouts found at runtime, and the tokens we failed to find one for. Session-lived. */
const discovered = new Map<string, Slots | null>()

/** Exposed for tests, which must not inherit a layout cached by an earlier one. */
export function clearSlotCache(): void {
  discovered.clear()
}

async function rpc(url: string, method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
  const res = await limitedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) return undefined
  const json = (await res.json()) as { result?: unknown; error?: unknown }
  return json.error !== undefined ? undefined : json.result
}

/**
 * Which storage slots hold a token's balances and allowances, found rather than known.
 *
 * This is the cost of simulating ourselves rather than asking a hosted simulator. Every token
 * picks its own layout, so the only portable answer is to write a value into a candidate slot
 * and ask the token whether it agrees. All candidates go at once, because twenty probes in
 * series would cost more than the simulation they enable.
 *
 * Standard Solidity mappings only. A Vyper token or an unusual proxy finds nothing, and that is
 * reported rather than guessed around: a wrong slot leaves the caller with no balance, the swap
 * reverts, and a bad override reads exactly like a bad route.
 */
async function findSlots(
  url: string,
  chainId: number,
  token: string,
  owner: string,
  spender: string,
  signal?: AbortSignal,
): Promise<Slots | null> {
  const key = `${chainId}:${token.toLowerCase()}`
  const known = KNOWN_SLOTS[key]
  if (known) return known
  if (discovered.has(key)) return discovered.get(key) ?? null

  const balanceOf = '0x70a08231' + owner.slice(2).toLowerCase().padStart(64, '0')
  const allowance =
    '0xdd62ed3e' +
    owner.slice(2).toLowerCase().padStart(64, '0') +
    spender.slice(2).toLowerCase().padStart(64, '0')

  const probe = async (n: number, storageKey: string, data: string): Promise<number> => {
    const result = await rpc(url, 'eth_call', [{ to: token, data }, 'latest', { [token]: { stateDiff: { [storageKey]: HUGE } } }], signal)
    return typeof result === 'string' && result !== '0x' && BigInt(result) === BigInt(HUGE) ? n : -1
  }

  const range = [...Array(20).keys()]
  const bal = (await Promise.all(range.map((n) => probe(n, slot1(owner, n), balanceOf)))).find((n) => n >= 0)
  const allow =
    bal === undefined
      ? undefined
      : (await Promise.all(range.map((n) => probe(n, slot2(owner, spender, n), allowance)))).find((n) => n >= 0)

  const found = bal !== undefined && allow !== undefined ? { bal, allow } : null
  discovered.set(key, found)
  return found
}

/** The shape `eth_simulateV1` answers with, narrowed to what is read here. */
interface SimulatedCall {
  status?: string
  returnData?: string
  gasUsed?: string
  logs?: { address: string; topics: string[]; data: string }[]
  error?: { message?: string; data?: string }
}

/** One ABI word holding 32, which is both the offset and the length of a one-word `bytes`. */
const WORD_32 = '0'.repeat(62) + '20'

/**
 * The amount a router reported returning, where the shape is one this recognises.
 *
 * A cross-check on the log sum, never a replacement for it, so it is allowed to give up. Two
 * shapes appear across the routers here — Nordstern's Guard answers with a bare `uint256`, and
 * Socket's AllowanceHolder wraps its inner call's return as `bytes`, which is an offset and a
 * length (both 32) ahead of the word. Anything else returns null rather than a guess: the last
 * 32 bytes of almost any return value parse as a plausible `uint256`, so a decoder that always
 * answers would invent numbers for routers it has never seen.
 *
 * Sliced rather than ABI-decoded. This runs on every measured route of every refresh, and the
 * whole job is two string comparisons and one `BigInt`.
 */
function reportedOut(data: string | undefined): bigint | null {
  if (!data) return null
  const h = data.startsWith('0x') ? data.slice(2) : data
  if (h.length === 64) return BigInt('0x' + h)
  if (h.length === 192 && h.slice(0, 64) === WORD_32 && h.slice(64, 128) === WORD_32) {
    return BigInt('0x' + h.slice(128))
  }
  return null
}

/**
 * What a route would actually return, measured against live chain state.
 *
 * Null means the question could not be asked — no endpoint for the chain, the node was
 * unreachable, or the token's layout could not be found. That is NOT evidence about the route,
 * and a caller must not treat it as one; fall back to the aggregator's own figure instead. A
 * route that ran and reverted comes back as a result with `ok: false`, which IS evidence.
 *
 * Measured on Base against the hosted simulator this replaced: identical output on every route
 * tested, to the last digit, at roughly a quarter of the latency — 741ms against 3485ms over
 * three routes, because that service answers one request at a time and an RPC does not.
 */
export async function simulateSwap(
  input: SimulationInput,
  signal?: AbortSignal,
): Promise<SimulationResult | null> {
  const url = simulationRpc(input.chainId)
  if (!url) return null

  try {
    const slots = await findSlots(url, input.chainId, input.tokenIn, input.from, input.spender, signal)
    if (!slots) return null

    const result = await rpc(
      url,
      'eth_simulateV1',
      [
        {
          blockStateCalls: [
            {
              stateOverrides: {
                // Funds and an allowance, so the swap can actually pull. Without both it
                // reverts on an empty balance, which is indistinguishable from a bad route.
                [input.tokenIn]: {
                  stateDiff: {
                    [slot1(input.from, slots.bal)]: HUGE,
                    [slot2(input.from, input.spender, slots.allow)]: HUGE,
                  },
                },
                // Native balance for the caller. Unused with validation off, but a route that
                // wraps or unwraps needs it.
                [input.from]: { balance: '0x5556BC75E2D63100000' },
              },
              calls: [
                {
                  from: input.from,
                  to: input.to,
                  data: input.data,
                  gas: '0x' + SIMULATION_GAS.toString(16),
                },
              ],
            },
          ],
          // Off. It exists to surface native transfers as logs, but the output below is
          // matched on `log.address === tokenOut` and a traced native transfer carries the
          // zero address — and `tokenOut` here is always an ERC20 reserve, never native. So it
          // never matched anything and only made the node trace every call in the route.
          traceTransfers: false,
          // No balance or nonce checks. The caller is a contract mid-flash-loan that holds
          // nothing at the block we simulate against.
          validation: false,
        },
        'latest',
      ],
      signal,
    )

    const call = (result as { calls?: SimulatedCall[] }[] | undefined)?.[0]?.calls?.[0]
    if (!call) return null

    const gasUsed = call.gasUsed ? Number(BigInt(call.gasUsed)) : 0
    if (call.status !== '0x1') {
      return {
        ok: false,
        amountOut: 0n,
        gasUsed,
        ...(call.error?.message !== undefined && { revertReason: call.error.message }),
      }
    }

    // The LAST destination-token transfer into the caller, found from the end. The same rule
    // `swapFromTransfers` uses on a real receipt, so "what did we receive" means one thing
    // everywhere. Filtered to the caller because a router taking its fee in the destination
    // token emits a transfer of it too, and that is output the caller never receives.
    const to = pad32(input.from)
    const landed = (call.logs ?? []).findLast(
      (log) =>
        log.address.toLowerCase() === input.tokenOut.toLowerCase() &&
        log.topics[0] === TRANSFER &&
        log.topics[2] === to,
    )
    const logOut = landed ? BigInt(landed.data) : 0n

    // The router's own figure wins where it gave one in a shape we recognise: it is the exact
    // amount the router accounted for, with no filtering to get wrong.
    const reported = reportedOut(call.returnData)
    const amountOut = reported ?? logOut

    // Loud, because they should agree to the wei and did on every route sampled. A one-word
    // return is also indistinguishable from a `bool`, so a router answering `true` would report
    // 1 wei here — the transfers are the check that catches it.
    if (reported !== null && logOut > 0n && reported !== logOut) {
      console.warn(
        `simulate: ${input.to} returned ${reported} but ${logOut} reached ${input.from} — using the returned figure`,
      )
    }

    return { ok: true, amountOut, gasUsed }
  } catch {
    return null
  }
}
