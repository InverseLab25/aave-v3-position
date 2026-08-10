import { formatUnits, type Address } from 'viem'
import type { QuoteResponse, TransactionPayload } from '../adapters/types'

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
export type CloseErrorKind = 'wallet' | 'deployment' | 'pair'

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
 * Decimal places the quoted rate is carried at before formatting. Display-only precision —
 * a rate smaller than 1e-6 rounds to zero here, which only bites on pairs where one
 * collateral token is worth less than a millionth of a debt token.
 */
const RATE_DECIMALS = 6n

/**
 * Debt token per 1 collateral token on a quote, as a decimal string.
 *
 * The two sides have different decimals, so the ratio has to be rescaled:
 *   rate = (expectedOut / 10^debtDec) / (requiredIn / 10^collDec)
 * Evaluated in bigint by folding both scales and RATE_DECIMALS into the numerator before
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
  const numerator = expectedOut * 10n ** BigInt(collateralDecimals) * 10n ** RATE_DECIMALS
  const denominator = requiredIn * 10n ** BigInt(debtDecimals)
  return formatUnits(numerator / denominator, Number(RATE_DECIMALS))
}

/**
 * Aggregators the deleverager can actually route through.
 *
 * Two conditions have to hold, and only the first is a property of the aggregator:
 *
 *  1. Its ERC20 approval-spender equals its call target, it needs no per-swap signature,
 *     and it can direct output to an arbitrary recipient — AaveV3Deleverager approves
 *     `router`, calls `router`, and expects the output on itself. This rules out ParaSwap
 *     (separate TokenTransferProxy), CowSwap (off-chain intent), and any Permit2-signature
 *     flow (1inch/0x) a contract can't sign. OpenOcean and Odos both satisfy it.
 *
 *  2. Its router is on the deleverager's on-chain allowlist. Only KyberSwap's mainnet
 *     router is — see script/RouterSetup.s.sol — so it is the only entry here.
 *
 * A router's address is only known after `buildTransaction`, i.e. after a quote has been
 * paid for, so condition 2 cannot be checked during sizing. Listing an aggregator whose
 * router isn't allowlisted therefore doesn't just waste quota: it can win the ranking and
 * be previewed to the user, and `close()` then silently falls back to a different route
 * that repays at a different rate than the one shown.
 *
 * To widen this: allowlist the router on-chain FIRST (RouterSetup.s.sol, owner-signed),
 * then add the name here. Never the other way round.
 */
export const COMPATIBLE_ADAPTERS = ['KyberSwap'] as const

/**
 * Minimal ABI: the entry point, the read-only preflight getters, and every custom error
 * the contract can raise (so viem decodes reverts into names instead of raw selectors).
 * Keep the error list in sync with AaveV3Deleverager.sol — a missing entry degrades a
 * clear failure into an undecodable hex selector.
 */
export const DELEVERAGER_ABI = [
  {
    type: 'function',
    name: 'closePositionWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateral', type: 'address' },
      { name: 'debtAsset', type: 'address' },
      { name: 'collateralToWithdraw', type: 'uint256' },
      { name: 'minOut', type: 'uint256' },
      { name: 'router', type: 'address' },
      { name: 'swapData', type: 'bytes' },
      {
        name: 'permit',
        type: 'tuple',
        components: [
          { name: 'value', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
      // Second signature, over value 0 at nonce N+1. Consumed right after the aTokens are
      // pulled so no residual allowance outlives the call. It carries no `value` — the
      // contract always passes a literal 0, so this signature can only ever clear.
      {
        name: 'revokePermit',
        type: 'tuple',
        components: [
          { name: 'deadline', type: 'uint256' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
  },
  // The contract only calls routers the owner has allowlisted; an unlisted `router`
  // reverts with RouterNotAllowed() after the user has already signed a permit.
  {
    type: 'function',
    name: 'allowedRouters',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  // The whole allowlist in one read. Preferred over probing allowedRouters(x) per route:
  // the contract stores it in an enumerable set so integrators can filter routes up front.
  {
    type: 'function',
    name: 'getAllowedRouters',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'error', name: 'Reentrancy', inputs: [] },
  { type: 'error', name: 'ExpectedState', inputs: [] },
  { type: 'error', name: 'NotMorpho', inputs: [] },
  { type: 'error', name: 'UnexpectedCallback', inputs: [] },
  { type: 'error', name: 'NoDebt', inputs: [] },
  { type: 'error', name: 'SameAsset', inputs: [] },
  { type: 'error', name: 'Paused', inputs: [] },
  { type: 'error', name: 'RouterNotAllowed', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientOutput',
    inputs: [
      { name: 'have', type: 'uint256' },
      { name: 'need', type: 'uint256' },
    ],
  },
] as const

/** Compatible quotes, best net USD return first. Empty when none are usable. */
export function rankRoutes(quotes: (QuoteResponse | null)[]): QuoteResponse[] {
  return quotes
    .filter(
      (q): q is QuoteResponse =>
        q != null && (COMPATIBLE_ADAPTERS as readonly string[]).includes(q.aggregator),
    )
    .sort((a, b) => b.netReturnUsd - a.netReturnUsd)
}

/**
 * Reasons a built router transaction cannot be handed to the deleverager. The contract
 * approves `router`, then calls `router` with zero value, so anything that violates
 * those assumptions must be caught before the user signs a permit — a revert this
 * late costs gas and leaves the signature live for the rest of its deadline.
 */
export function validateSwapTx(
  tx: { to: string; data: string; value: string; spender: string },
  isRouterAllowlisted: boolean,
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
  return null
}

/**
 * Walk ranked candidates and return the first that BUILDS and passes {@link validateSwapTx}.
 *
 * Both flows do this and must keep doing it identically: a candidate that fails to build, or
 * builds into calldata the contract cannot execute, has to be fallen through rather than
 * erroring out on the first pick — otherwise one flaky aggregator takes the whole quote down
 * while a perfectly good route sits behind it. Sharing the walk is what keeps the allowlist and
 * calldata checks from drifting apart between the open path and the close path, which is the
 * part that is security-relevant rather than merely tidy.
 *
 * Candidates must arrive best-first: the first acceptable one wins, so any fallback prices
 * strictly worse than the route the caller sized against.
 *
 * `reject` is an optional extra bar for the caller's own invariant — the close flow needs each
 * candidate's guaranteed output to clear the debt, which is not something this can know.
 */
export async function selectBuildableRoute<C>(
  candidates: C[],
  opts: {
    build: (candidate: C) => Promise<TransactionPayload>
    isAllowlisted: (router: string) => boolean
    reject?: (candidate: C) => string | null
    label?: (candidate: C) => string
    /** Aborts the walk between candidates when the caller's request is superseded. */
    cancelled?: () => boolean
  },
): Promise<{ selected: { candidate: C; tx: TransactionPayload } | null; rejected: string[] }> {
  const rejected: string[] = []
  const name = (c: C) => (opts.label ? opts.label(c) : 'route')

  for (const candidate of candidates) {
    if (opts.cancelled?.()) return { selected: null, rejected }

    const bar = opts.reject?.(candidate)
    if (bar) {
      rejected.push(`${name(candidate)}: ${bar}`)
      continue
    }

    let tx: TransactionPayload
    try {
      tx = await opts.build(candidate)
    } catch (e) {
      rejected.push(`${name(candidate)}: build failed (${(e as Error).message})`)
      continue
    }
    if (opts.cancelled?.()) return { selected: null, rejected }

    const problem = validateSwapTx(tx, opts.isAllowlisted(tx.to))
    if (problem) {
      rejected.push(`${name(candidate)}: ${problem}`)
      continue
    }

    return { selected: { candidate, tx }, rejected }
  }

  return { selected: null, rejected }
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
