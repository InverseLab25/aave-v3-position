import { formatUnits, type Address } from 'viem'
import type { QuoteResponse, TransactionPayload } from '../adapters/types'
import type { SimulationResult } from '../adapters/simulate'

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
 */
export const COMPATIBLE_ADAPTERS = ['Nordstern', 'Socket'] as const

/**
 * How many routes are built and measured, best-quoted first.
 *
 * Six, not three. The cut is made on quotes because measuring is the expensive part and nothing
 * is measured yet — but a quote is the least reliable number in this flow, and a rank cut makes
 * the decision on the smallest differences in it. One Base field had the third and fourth quotes
 * 0.0001 apart while the third measured 0.05% under its own quote: cutting at three dropped the
 * fourth, unmeasured, on a margin far smaller than the error being measured away. Widening the
 * field is the fix, because the cut cannot be made on anything better.
 *
 * Affordable now in a way it was not when this was three. Both adapters return prebuilt
 * transactions from `getQuotes`, so building a candidate costs no HTTP at all — an extra one is
 * one more `eth_simulateV1` and nothing else, and those run concurrently, so the cost is quota
 * rather than wall clock. Simulation has no public fallback (see `simulationRpc`), so the quota
 * spent is the user's own.
 *
 * Six rather than unbounded because Socket answers with a route per underlying aggregator, and
 * a whole field plus Nordstern lands about there — past it the tail is genuinely hopeless.
 */
export const MAX_MEASURED_ROUTES = 6


/**
 * Compatible quotes, best OUTPUT first. Empty when none are usable.
 *
 * Ranked on `amountOut` rather than `netReturnUsd` because every candidate is selling the same
 * input for the same token, so the raw output is the one figure that means the same thing for
 * all of them. `netReturnUsd` does not: each aggregator fills it from its own pricing, and one
 * that reports no USD at all (Nordstern) carries `gasUsd: '0'`, so it would be ranked on a gross
 * figure against Kyber's net one and win trades it had lost. This also puts the close path on
 * the same key the open path already sorts by, so the two cannot pick different winners from
 * the same quotes.
 */
export function rankRoutes(quotes: (QuoteResponse | null)[]): QuoteResponse[] {
  return quotes
    .filter(
      (q): q is QuoteResponse =>
        q != null && (COMPATIBLE_ADAPTERS as readonly string[]).includes(q.aggregator),
    )
    // Ties return 0. Answering -1 for equal values is an inconsistent comparator, which sort is
    // entitled to do anything with — it happens to be harmless at two or three candidates, and
    // this list decides which route a close executes.
    .sort((a, b) => {
      const x = BigInt(a.amountOut)
      const y = BigInt(b.amountOut)
      return y > x ? 1 : y < x ? -1 : 0
    })
}

/**
 * The candidates a run may use once the user has pinned an aggregator in the route list.
 *
 * A pin overrides the ranking, so it is a filter and not a reorder: the point of pinning is to
 * refuse the route that won, and moving the pick to the front would quietly hand the trade back
 * to that route the moment the pinned one failed to build. An empty result against a non-empty
 * input is what each flow turns into "that route cannot serve this trade".
 */
/**
 * What identifies one row: the venue where the adapter named one, the adapter otherwise.
 *
 * The single place this fallback lives. Keying measurements or pins on `aggregator` alone
 * collapses every Socket route onto one entry, so they all report the winner's measurement and
 * pinning any of them pins all of them.
 */
export function routeKey(q: { aggregator: string; routeId?: string }): string {
  return q.routeId ?? q.aggregator
}

export function applyPin<T>(
  routes: T[],
  pinned: string | undefined,
  nameOf: (r: T) => string,
): T[] {
  return pinned ? routes.filter((r) => nameOf(r) === pinned) : routes
}

/**
 * Reasons a built router transaction cannot be handed to the deleverager. The contract
 * approves `router`, then calls `router` with zero value, so anything that violates
 * those assumptions must be caught before the user signs a permit — a revert this
 * late costs gas and leaves the signature live for the rest of its deadline.
 */
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
 * Largest calldata a route may carry, in bytes.
 *
 * 20KB. Only KyberSwap has ever exceeded it in any sample taken here — 22 to 25KB on Base at
 * 1M USDC — and those routes measured over the chain's per-transaction gas cap.
 */
export const MAX_CALLDATA_BYTES = 20 * 1024

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
  if (txGasCap !== undefined && tx.gasEstimate) {
    let gas: bigint
    try {
      gas = BigInt(tx.gasEstimate)
    } catch {
      return null
    }
    if (gas > txGasCap) {
      return `route needs ${gas} gas; this chain caps a transaction at ${txGasCap}`
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
  const builds = await Promise.all(
    toBuild.map((candidate) =>
      opts
        .build(candidate)
        .then((tx) => ({ candidate, tx, error: null as Error | null }))
        .catch((e: Error) => ({ candidate, tx: null, error: e })),
    ),
  )
  if (opts.cancelled?.()) return nothing

  // Validated in candidate order, so what `rejected` reads back is the order the caller gave.
  for (const { candidate, tx, error } of builds) {
    if (!tx) {
      rejected.push(`${name(candidate)}: build failed (${error?.message})`)
      continue
    }
    const problem = validateSwapTx(tx, opts.isAllowlisted(tx.to), opts.txGasCap)
    if (problem) {
      rejected.push(`${name(candidate)}: ${problem}`)
      continue
    }
    viable.push({ candidate, tx })
  }

  if (viable.length === 0) return { selected: null, measurements: [], rejected }

  // Concurrently: these are independent reads of the same block, and the shared HTTP gate caps
  // the origin anyway, so serialising them would only add latency to a preview that refreshes.
  const sims = opts.simulate
    ? await Promise.all(viable.map((v) => opts.simulate!(v.candidate, v.tx)))
    : viable.map(() => null)
  if (opts.cancelled?.()) return nothing

  // A simulation that RAN and reverted is evidence, not an outage: this route fails against live
  // state. Offering it anyway on the aggregator's own figure is offering a trade already shown
  // to fail, so it is dropped here and the reason travels with it.
  const measurements: { candidate: C; tx: TransactionPayload; sim: SimulationResult | null }[] = []
  viable.forEach((v, i) => {
    const sim = sims[i]
    if (sim && !sim.ok) {
      rejected.push(`${name(v.candidate)}: ${sim.revertReason ?? 'reverts in simulation'}`)
      return
    }
    measurements.push({ ...v, sim })
  })
  if (measurements.length === 0) return { selected: null, measurements: [], rejected }

  // Strictly-greater, so a tie keeps the earlier candidate — which is the better QUOTE, and the
  // one the caller sized against.
  let best = 0
  for (let i = 1; i < measurements.length; i++) {
    const m = measurements[i]
    if (effectiveOut(m.tx, m.sim) > effectiveOut(measurements[best].tx, measurements[best].sim)) {
      best = i
    }
  }

  return { selected: measurements[best], measurements, rejected }
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
