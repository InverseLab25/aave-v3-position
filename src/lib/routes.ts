import type { Address } from 'viem'
import { getAdaptersForChain, quoteField } from '../adapters'
import { AggregatorHttpError } from '../adapters/http'
import type { Adapter, Asset, QuoteResponse, TransactionPayload } from '../adapters/types'
import { simulateSwap, swapSimulationInput } from '../adapters/simulate'
import type { SimulationInput, SimulationResult } from '../adapters/simulate'
import { getChainConfig, getTxGasCap } from '../config/chains'

/**
 * Everything the open, close and flip flows do with a swap route, in one place.
 *
 * Quote the field, rank it, honour a pin, build every candidate, validate the calldata,
 * measure it against live state and pick the winner. The three flows used to carry their own
 * copies of the first half and their own wiring for the second, and every fix to one had to be
 * made three times. They now differ only in what they hand in — the assets, the contract that
 * executes the swap, and the bar a candidate has to clear — and nothing else.
 *
 * Primitives first (`validateSwapTx`, `selectBuildableRoute`, `routeKey`, `effectiveOut`), then
 * the two entry points the flows call: `quoteRoutes` and `selectRoute`.
 */

/**
 * Aggregators either contract can actually route through.
 *
 * Applies to AaveV3Strategies as much as AaveV3Deleverager: both approve `router` and then
 * call `router` with the caller's calldata (`_swap`, AaveV3Strategies.sol:620), so the same
 * two conditions bind on both. Filtering by `supportsExecution` alone is NOT equivalent — that
 * flag only says the adapter returns a transaction at all.
 *
 * Two conditions have to hold, and only the first is a property of the aggregator:
 *
 *  1. Its ERC20 approval-spender equals its call target, it needs no per-swap signature,
 *     and it can direct output to an arbitrary recipient — both contracts approve `router`,
 *     call `router`, and expect the output on themselves. This rules out CowSwap (off-chain
 *     intent) and any Permit2-signature flow (1inch/0x) a contract can't sign. OpenOcean,
 *     Odos and ParaSwap all satisfy it — ParaSwap only since Augustus v6.2, where the
 *     approval spender is the router itself rather than a separate TokenTransferProxy.
 *
 *  2. Its router is on the deleverager's on-chain allowlist. Nordstern's Guard is on Base and
 *     Arbitrum only — see script/RouterSetup.s.sol. KyberSwap's router is allowlisted on all
 *     three chains but is deliberately not named here any more, so nothing quotes it.
 *
 *     This list has no chain dimension, so condition 2 holding on SOME chain is what gets a
 *     name in. What keeps Nordstern away from mainnet, where its Guard is not allowlisted, is
 *     the adapter itself: GUARDS in adapters/nordstern.ts has no entry for chain 1, so
 *     `getQuote` returns null there and the route is never ranked. Mainnet's `adapters` list
 *     in config/chains.ts does not name it either. Both have to keep agreeing with the
 *     allowlist — a Guard added to GUARDS before it is allowlisted on that chain reintroduces
 *     exactly the sized-then-rejected failure this comment exists to prevent.
 *
 * A router's address is only known after `buildTransaction`, i.e. after a quote has been
 * paid for, so condition 2 cannot be checked during sizing. Quoting an aggregator that fails
 * either condition therefore does more than waste quota: it can win the ranking, get sized
 * against, and then be rejected at build time — leaving the flow to fall back to a strictly
 * worse route. On the open path that surfaces as a spurious "the rate moved" error the user
 * can do nothing about, because the route it sized against was never usable.
 *
 * To widen this: allowlist the router on-chain FIRST (RouterSetup.s.sol, owner-signed),
 * then add the name here. Never the other way round.
 *
 * Socket satisfies both. Its AllowanceHolder (0x50c4E75a512F2A14A7b304787Adf79C4531A5909, the
 * same address on both chains) is allowlisted on AaveV3Strategies on Base and Arbitrum, read
 * off `getAllowedRouters()` on 2026-09-04. Socket signs each route for whoever `userAddress`
 * names and its AllowanceHolder rejects anyone else with `CallerNotSignedUser()` (0x85132e0f),
 * so naming the Strategies contract there is the whole requirement — its `contractCaller`
 * parameter adds nothing and is not sent. Quoted and simulated as the contract on Base at
 * 25,243 USDC, every route executed and measured within 0.003% of its quote.
 *
 * What Socket does cost is 20bps of the INPUT on every route, to
 * 0xe3D091bcb9406Ddb9a121e37f4eb1345336AFBBf. That is the unkeyed public host; a request keyed
 * with `x-api-key` and an `affiliate` header comes back with no fee at all. Unkeyed, Socket
 * therefore loses to Nordstern on every trade by roughly that margin and the extra quoting is
 * close to wasted. The key is what makes it competitive.
 *
 * Mainnet has neither: no Nordstern Guard, and Socket's AllowanceHolder is not on the
 * Deleverager's allowlist, which holds KyberSwap's router alone. So chain 1 currently ranks
 * nothing, KyberSwap no longer being named here.
 *
 * `0x` is the direct 0x adapter, on the Swap API's AllowanceHolder endpoint (Socket's route
 * through the same venue is keyed `Socket/0x`, not `0x`). It satisfies
 * condition 1: `transaction.to` and the approval spender are both the AllowanceHolder
 * (0x0000000000001fF3684f28c67538d4D072C22734, one address on all three chains), the output is
 * sent to `taker`, and the adapter quotes with the Strategies contract as taker. Condition 2 is
 * a per-chain owner broadcast of RouterSetup.s.sol with ROUTERS set to that address; on a chain
 * where it has not run, every 0x route is rejected at build time as not allowlisted and the
 * flow falls through to the rest of the field.
 */
export const COMPATIBLE_ADAPTERS = ['Nordstern', 'Socket', '0x'] as const

/**
 * How many routes are built and measured, best-quoted first.
 *
 * Four. Only the top of the ranking is ever simulated: each measurement is an `eth_simulateV1`
 * on the user's own RPC quota (there is no public fallback, see `simulationRpc`), and a preview
 * repeats every few seconds. Past the fourth quote the field is a tail — the quotes land within
 * half a percent of each other and the measured drift from quote to reality is usually under
 * 0.05%, so the winner is almost always in the first four. Direct adapters plus Socket's
 * per-venue routes make the whole field several times this, and measuring all of it was
 * spending quota confirming losers.
 *
 * The cut is on quotes because nothing has been measured yet. A quote is the least reliable
 * number in this flow, so a route just outside the cut can in principle be the true winner; that
 * is the price of not simulating everything, and it is deliberate.
 */
export const MAX_MEASURED_ROUTES = 4

/**
 * What identifies one row: 'Adapter/Venue' where the adapter named a venue, the adapter otherwise.
 *
 * The single place this lives. Keying measurements or pins on `aggregator` alone collapses
 * every Socket route onto one entry, so they all report the winner's measurement and pinning
 * any of them pins all of them. Keying on the venue alone is the opposite trap: Socket's
 * KyberSwap row and our direct KyberSwap adapter are different routes with different calldata,
 * and they would share a key and a label.
 */
export function routeKey(q: { aggregator: string; routeId?: string }): string {
  return q.routeId ? `${q.aggregator}/${q.routeId}` : q.aggregator
}

/**
 * The candidates a run may use once the user has pinned an aggregator in the route list.
 *
 * A pin overrides the ranking, so it is a filter and not a reorder: the point of pinning is to
 * refuse the route that won, and moving the pick to the front would quietly hand the trade back
 * to that route the moment the pinned one failed to build. An empty result against a non-empty
 * input is what each flow turns into "that route cannot serve this trade".
 */
export function applyPin<T>(
  routes: T[],
  pinned: string | undefined,
  nameOf: (r: T) => string,
): T[] {
  return pinned ? routes.filter((r) => nameOf(r) === pinned) : routes
}

/**
 * The per-transaction gas ceiling on chains that enforce EIP-7825: 2^24 = 16,777,216.
 *
 * Verified against live nodes rather than taken from the spec — Ethereum and Base both accept a
 * transaction at exactly this figure and refuse one at 16,777,217 with "gas limit too high",
 * before any funds or nonce check runs. Arbitrum accepts 40,000,000, so the cap is per chain and
 * lives in the chain config; this constant is only the value those two share.
 */
export const TX_GAS_CAP_2_24 = 16_777_216n

/**
 * Most gas a route may quote and still be measured, on a chain with a per-transaction cap.
 *
 * 14M. The simulation there runs under 16M, and the contract spends its own on top of the
 * swap, so a route quoting more could neither be measured nor sent. Refusing it saves the
 * simulation. Uncapped chains (Arbitrum, 40M) are not held to it.
 */
export const MAX_ROUTE_GAS = 14_000_000n

/**
 * Largest calldata a route may carry, in bytes.
 *
 * 25KB. Only KyberSwap has ever exceeded it in any sample taken here — 22 to 25KB on Base at
 * 1M USDC — and those routes measured over the chain's per-transaction gas cap.
 */
export const MAX_CALLDATA_BYTES = 25 * 1024

/**
 * Reasons a built router transaction cannot be handed to the deleverager. The contract
 * approves `router`, then calls `router` with zero value, so anything that violates
 * those assumptions must be caught before the user signs a permit — a revert this
 * late costs gas and leaves the signature live for the rest of its deadline.
 */
export function validateSwapTx(
  tx: { to: string; data: string; value: string; spender: string; gasEstimate?: string },
  isRouterAllowlisted: boolean,
  /** The chain's per-transaction gas ceiling. Undefined means the chain enforces none. */
  txGasCap?: bigint,
): string | null {
  if (tx.to.toLowerCase() !== tx.spender.toLowerCase()) {
    return 'approval target and call target differ'
  }
  if (!tx.data || tx.data === '0x') return 'router returned empty calldata'
  // LibCall.callContract sends no ETH, so a route needing msg.value can never execute.
  let value: bigint
  try {
    value = BigInt(tx.value || '0')
  } catch {
    return `unparseable tx value "${tx.value}"`
  }
  if (value !== 0n) return `route requires ${value} wei of ETH; the deleverager sends none`
  if (!isRouterAllowlisted) return `router ${tx.to} is not allowlisted on the deleverager`
  // Calldata is charged before the first opcode runs — 4 gas a zero byte, 16 otherwise — and
  // KyberSwap ships tens of kilobytes where every other route here is a kilobyte or two.
  // Measured on Base at 1M USDC: a 25KB Kyber route needed 18.1M gas against the 16.78M cap
  // while quoting 12.5M, so the gas check above passes it and the chain would not. This is a
  // blunt instrument on purpose — an exact figure needs a simulation, and a route this large
  // has never been the winner in any sample.
  if (tx.data.length > 2 + MAX_CALLDATA_BYTES * 2) {
    return `route carries ${Math.round((tx.data.length - 2) / 2048)}KB of calldata, over the ${MAX_CALLDATA_BYTES / 1024}KB limit`
  }
  // A route that cannot fit in one transaction is rejected by the node, not by a revert, so
  // there is no simulation to catch it and no error the user can act on. Aggregator gas is an
  // estimate rather than a measurement, so this catches the clearly-impossible rather than the
  // marginal — an absent or unparseable figure is not evidence and is left alone.
  if (tx.gasEstimate) {
    let gas: bigint
    try {
      gas = BigInt(tx.gasEstimate)
    } catch {
      return null
    }
    if (txGasCap !== undefined && gas > txGasCap) {
      return `route needs ${gas} gas; this chain caps a transaction at ${txGasCap}`
    }
    if (txGasCap !== undefined && gas > MAX_ROUTE_GAS) {
      return `route needs ${gas} gas, over the ${MAX_ROUTE_GAS} a route may quote on this chain`
    }
  }
  return null
}

/**
 * The output figure to trust for a built route.
 *
 * A simulation wins whenever there is one. It is the only figure here that was MEASURED — a
 * real balance delta at the recipient against live state, so transfer taxes and router fees are
 * already in it. The alternative is the aggregator's own claim about its own route, which is
 * self-reported and can be shaded, and which nothing on this path can check.
 *
 * The one fallback is a null simulation, and it is not a verdict: it means the simulator could
 * not be ASKED — down, rate-limited, unreachable. Penalising that would let an outage silently
 * re-rank every trade, or block them all. A simulation that ran and reverted is different, and
 * does not reach here at all: {@link selectBuildableRoute} rejects the route outright, with the
 * revert reason, rather than offering a trade already shown to fail.
 */
export function effectiveOut(
  tx: TransactionPayload,
  sim: SimulationResult | null | undefined,
): bigint {
  if (sim) return sim.amountOut
  return BigInt(tx.amountOut ?? 0)
}

/**
 * Where a route's expected output actually came from.
 *
 * Recorded because the three rungs are not equally trustworthy and the number alone cannot say
 * which one it is. A `fill` measured against a simulation is a comparison with something that
 * WAS measured against live state; one measured against `quoted` compares a fill with the
 * aggregator's arithmetic about its own route, which nothing checked. Both render as the same
 * percentage, so without this a reader averaging fill quality is mixing two different claims.
 */
export type OutBasis = 'simulated' | 'built' | 'quoted'

/**
 * What a route is expected to return, and on whose word.
 *
 * The full ladder, in one place, because the open and close flows both walk it and both derive
 * their slippage floor from the result — reading it differently would let the two enforce
 * different floors on the same trade. {@link effectiveOut} is the ranking half of this and stays
 * separate: ranking compares candidates against each other and does not care whose word it is.
 */
export function expectedOutcome(
  tx: TransactionPayload,
  sim: SimulationResult | null | undefined,
  /** The quote's own figure, the last resort when the build returned no amount either. */
  quoted: bigint,
): { amount: bigint; basis: OutBasis } {
  if (sim) return { amount: sim.amountOut, basis: 'simulated' }
  const built = BigInt(tx.amountOut ?? 0)
  if (built > 0n) return { amount: built, basis: 'built' }
  return { amount: quoted, basis: 'quoted' }
}

/**
 * Build every candidate that clears the bars, measure what each would really return, and pick
 * the best of them.
 *
 * Both flows do this and must keep doing it identically: a candidate that fails to build, or
 * builds into calldata the contract cannot execute, has to be fallen through rather than
 * erroring out on the first pick — otherwise one flaky aggregator takes the whole quote down
 * while a perfectly good route sits behind it. Sharing the walk is what keeps the allowlist and
 * calldata checks from drifting apart between the open path and the close path, which is the
 * part that is security-relevant rather than merely tidy.
 *
 * Candidates arrive best-first by QUOTE, and that order only decides ties. A quote is the
 * aggregator's claim about its own route; the ranking here is on {@link effectiveOut}, which
 * prefers what a simulation measured. Letting the measurement reorder them is the entire point
 * — a quote that does not survive contact with live state should not win the trade.
 *
 * The bars are checked BEFORE anything is simulated, so a route rejected for gas or for the
 * allowlist never costs a simulation.
 *
 * `reject` is an optional extra bar for the caller's own invariant — the close flow needs each
 * candidate's guaranteed output to clear the debt, which is not something this can know.
 *
 * With no `simulate` the ranking falls back to the built figures, which is still better than
 * taking the first that builds: a build can come back worse than the quote it was based on.
 */
export async function selectBuildableRoute<C>(
  candidates: C[],
  opts: {
    build: (candidate: C) => Promise<TransactionPayload>
    isAllowlisted: (router: string) => boolean
    reject?: (candidate: C) => string | null
    label?: (candidate: C) => string
    /** The chain's per-transaction gas ceiling, forwarded to {@link validateSwapTx}. */
    txGasCap?: bigint
    /** Aborts the walk between candidates when the caller's request is superseded. */
    cancelled?: () => boolean
    /**
     * What this route would really return, measured against live state. Null when the question
     * could not be asked — see {@link effectiveOut} for why that is not the same as a failure.
     */
    simulate?: (candidate: C, tx: TransactionPayload) => Promise<SimulationResult | null>
  },
): Promise<{
  selected: { candidate: C; tx: TransactionPayload; sim: SimulationResult | null } | null
  /**
   * Every candidate that got as far as being measured, in the order they were given.
   *
   * Reported because the caller lists the whole field to the user. Showing quoted figures there
   * while the winner is picked on measured ones lets the row marked "best" be a route that lost.
   * Candidates rejected before the build are absent — nothing was measured for them.
   */
  measurements: { candidate: C; tx: TransactionPayload; sim: SimulationResult | null }[]
  rejected: string[]
}> {
  const rejected: string[] = []
  const name = (c: C) => (opts.label ? opts.label(c) : 'route')
  const viable: { candidate: C; tx: TransactionPayload }[] = []
  const nothing = { selected: null, measurements: [], rejected }

  // The caller's own bar first, and synchronously: it costs nothing and a candidate that fails
  // it should not cost a build.
  const passed: C[] = []
  for (const candidate of candidates) {
    const bar = opts.reject?.(candidate)
    if (bar) rejected.push(`${name(candidate)}: ${bar}`)
    else passed.push(candidate)
  }
  // Capped AFTER the caller's bar, so a candidate rejected for nothing does not use up a slot.
  // Candidates arrive best-quoted first, so this keeps the ones most likely to win.
  const toBuild = passed.slice(0, MAX_MEASURED_ROUTES)
  for (const dropped of passed.slice(MAX_MEASURED_ROUTES)) {
    rejected.push(`${name(dropped)}: outside the top ${MAX_MEASURED_ROUTES} by quote`)
  }
  if (opts.cancelled?.()) return nothing

  // Concurrently. This used to walk and stop at the first success, so building in sequence cost
  // nothing — it builds the WHOLE field now, and each build is a round-trip to a different
  // aggregator, so in sequence they add up on a preview that repeats every three seconds.
  // Failures are captured rather than thrown so one bad aggregator cannot take the batch down.
  const builds = await Promise.allSettled(toBuild.map((c) => opts.build(c)))
  if (opts.cancelled?.()) return nothing

  // Validated in candidate order, so what `rejected` reads back is the order the caller gave.
  builds.forEach((b, i) => {
    const candidate = toBuild[i]
    if (b.status === 'rejected') {
      rejected.push(`${name(candidate)}: build failed (${(b.reason as Error)?.message})`)
      return
    }
    const problem = validateSwapTx(b.value, opts.isAllowlisted(b.value.to), opts.txGasCap)
    if (problem) rejected.push(`${name(candidate)}: ${problem}`)
    else viable.push({ candidate, tx: b.value })
  })

  if (viable.length === 0) return nothing

  // Concurrently: these are independent reads of the same block, and the shared HTTP gate caps
  // the origin anyway, so serialising them would only add latency to a preview that refreshes.
  const sims = opts.simulate
    ? await Promise.all(viable.map((v) => opts.simulate!(v.candidate, v.tx)))
    : viable.map(() => null)
  if (opts.cancelled?.()) return nothing

  // A simulation that RAN and reverted is evidence, not an outage: this route fails against live
  // state. Offering it anyway on the aggregator's own figure is offering a trade already shown
  // to fail, so it is dropped here and the reason travels with it.
  const measurements = viable
    .map((v, i) => ({ ...v, sim: sims[i] }))
    .filter((m) => {
      if (!m.sim || m.sim.ok) return true
      rejected.push(`${name(m.candidate)}: ${m.sim.revertReason ?? 'reverts in simulation'}`)
      return false
    })
  if (measurements.length === 0) return nothing

  // Strictly-greater, so a tie keeps the earlier candidate — which is the better QUOTE, and the
  // one the caller sized against.
  const selected = measurements.reduce((b, m) =>
    effectiveOut(m.tx, m.sim) > effectiveOut(b.tx, b.sim) ? m : b,
  )
  return { selected, measurements, rejected }
}

/** The adapters whose routes the leverage contracts can execute on this chain. */
export function compatibleAdapters(chainId: number): Adapter[] {
  return getAdaptersForChain(getChainConfig(chainId)?.adapters ?? []).filter((a) =>
    (COMPATIBLE_ADAPTERS as readonly string[]).includes(a.name),
  )
}

export interface QuoteRoutesInput {
  adapters: Adapter[]
  fromAsset: Asset
  toAsset: Asset
  amountIn: bigint
  slippagePercent: number
  chainId: number
  /** The contract that will execute the route, and therefore who it must be quoted for. */
  caller: Address
  signal?: AbortSignal
  /** A `routeKey` the user pinned. Filters the field; never reorders it. */
  pinned?: string
}

export interface QuoteRoutesResult {
  /** The whole field, best quoted output first — losers included, so the picker has them. */
  ranked: QuoteResponse[]
  /** `ranked` after the pin, which is what sizing and selection work from. */
  usable: QuoteResponse[]
  /**
   * An aggregator refused to answer (429, 5xx), as opposed to answering with nothing. Changes
   * what an empty field means: "try again shortly" rather than "no liquidity here".
   */
  throttled: boolean
  /** The pair priced, but the pinned route was not among the answers. */
  pinnedOut: boolean
}

/**
 * Every route every adapter offers for this swap, quoted for the contract that executes it.
 *
 * Each adapter is asked for its whole field, not its best: Socket answers one request with a
 * route per underlying venue, and those differ from each other as much as two adapters do. An
 * adapter that throws is dropped rather than failing the field — one flaky aggregator must not
 * take the quote down — and a retryable failure is reported so the caller can say "throttled"
 * instead of "no route".
 */
export async function quoteRoutes(p: QuoteRoutesInput): Promise<QuoteRoutesResult> {
  let throttled = false
  const results = await Promise.all(
    p.adapters.map((a) =>
      quoteField(a, {
        fromAsset: p.fromAsset,
        toAsset: p.toAsset,
        amountIn: p.amountIn.toString(),
        slippage: p.slippagePercent,
        chainId: p.chainId,
        caller: p.caller,
        signal: p.signal,
      }).catch((e: unknown) => {
        if (e instanceof AggregatorHttpError && e.retryable) throttled = true
        return [] as QuoteResponse[]
      }),
    ),
  )
  // Ties return 0. A comparator that answers -1 for equal values is inconsistent, and sort is
  // entitled to do anything with one — harmless at two candidates, wrong the moment there are more.
  const ranked = results.flat().sort((x, y) => {
    const a = BigInt(x.amountOut)
    const b = BigInt(y.amountOut)
    return b > a ? 1 : b < a ? -1 : 0
  })
  const usable = applyPin(ranked, p.pinned, routeKey)
  return { ranked, usable, throttled, pinnedOut: usable.length === 0 && ranked.length > 0 }
}

export interface RouteSelection {
  router: Address | null
  swapData: `0x${string}` | null
  chosen: QuoteResponse | null
  /** The built payload, carrying the aggregator's authoritative amountOut and outputChange. */
  tx: TransactionPayload | null
  /**
   * What the chosen route was measured to return, or null when nothing measured it.
   *
   * Null is not a verdict on the route — see {@link effectiveOut}. It reaches the caller, where
   * the output `minOut` derives from is chosen, so the two must keep reading it the same way.
   */
  sim: SimulationResult | null
  /**
   * What each candidate that got as far as being measured actually returned, by `routeKey`.
   *
   * The picker lists the whole field. Listing quoted figures there while the winner is chosen on
   * measured ones lets the row marked "best" be a route that lost.
   */
  measuredOut: Record<string, bigint>
  /** Why each rejected candidate was unusable, for the error the user eventually sees. */
  rejected: string[]
}

/**
 * Build, validate, measure and pick from a quoted field.
 *
 * A router's address is only known after `buildTransaction`, so the on-chain allowlist cannot
 * filter candidates during sizing — it has to happen here. Every rejection caught at this point
 * is one the user would otherwise pay gas to discover.
 */
export async function selectRoute({
  candidates,
  adapters,
  strategies,
  allowedRouters,
  slippagePercent,
  chainId,
  debt,
  slipNum,
  tokenIn,
  tokenOut,
  simulate = simulateSwap,
  signal,
}: {
  candidates: QuoteResponse[]
  adapters: Adapter[]
  /** The contract the swap output must land on — it is also the `buildTransaction` recipient. */
  strategies: Address
  allowedRouters: Set<string>
  slippagePercent: number
  chainId: number
  /** Guaranteed output a candidate must clear before it is worth building. Zero to measure only. */
  debt: bigint
  slipNum: bigint
  /** Sold by the swap. Collateral on a close, the old long on a flip, the debt asset on an open. */
  tokenIn: string
  /** Bought by the swap. The debt asset on a close, the new long on a flip, collateral on an open. */
  tokenOut: string
  /** Overridable so the selection stays testable without a live simulator. */
  simulate?: (input: SimulationInput, signal?: AbortSignal) => Promise<SimulationResult | null>
  /** Aborts the walk between phases once the caller's request is superseded. */
  signal?: AbortSignal
}): Promise<RouteSelection> {
  // The walk itself is shared with every flow, so the allowlist and calldata checks stay
  // identical between them. What is specific here is the bar each candidate has to clear:
  // every quote has a different output, so its guarantee is re-derived rather than inherited
  // from whichever one sizing settled on.
  const { selected, measurements, rejected } = await selectBuildableRoute(candidates, {
    build: (c) => {
      const adapter = adapters.find((a) => a.name === c.aggregator)
      if (!adapter) throw new Error('no adapter for this quote')
      return adapter.buildTransaction(c, slippagePercent, strategies, chainId)
    },
    isAllowlisted: (router) => allowedRouters.has(router.toLowerCase()),
    reject: (c) =>
      (BigInt(c.amountOut) * slipNum) / 10000n < debt ? 'guaranteed output below the debt' : null,
    label: (c) => routeKey(c),
    txGasCap: getTxGasCap(chainId),
    cancelled: () => signal?.aborted ?? false,
    // Deliberately the swap's OWN sender, tokens and size rather than the user's wallet: the
    // swap happens inside the contract mid-flash-loan, and measuring it anywhere else answers
    // a question nobody asked while still returning a plausible-looking number.
    simulate: (c, tx) =>
      simulate(
        swapSimulationInput({ chainId, caller: strategies, tokenIn, tokenOut, amountIn: c.amountIn, tx }),
        signal,
      ),
  })

  const measuredOut: Record<string, bigint> = {}
  for (const m of measurements) measuredOut[routeKey(m.candidate)] = effectiveOut(m.tx, m.sim)

  if (selected) {
    return {
      measuredOut,
      router: selected.tx.to as Address,
      swapData: selected.tx.data as `0x${string}`,
      chosen: selected.candidate,
      tx: selected.tx,
      sim: selected.sim,
      rejected,
    }
  }

  return { router: null, swapData: null, chosen: null, tx: null, sim: null, measuredOut, rejected }
}
