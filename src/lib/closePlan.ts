import { maxUint256, type Address } from 'viem'
import type { Adapter, QuoteResponse, TransactionPayload } from '../adapters/types'
import { CloseError, selectBuildableRoute } from './deleverage'

// Moved to swapRoute.ts so the open flow can share them. Re-exported here so every existing
// consumer of closePlan keeps working against the same import path.
export {
  MAX_OUTPUT_DEGRADATION_PERCENT,
  PRICE_IMPACT_HIGH_PERCENT,
  PRICE_IMPACT_BLOCK_PERCENT,
  routeCostPercent,
  isSlippageShapedFailure,
  suggestWiderSlippage,
} from './swapRoute'

/**
 * Headroom the permit grants above the amount actually pulled (25%).
 *
 * The pull amount is a SEPARATE contract argument (`collateralToWithdraw`), and the permit is
 * revoked at nonce N+1 inside the same transaction, so a larger allowance can never mean a
 * larger withdrawal. Nor can it exceed the balance — `planWithdrawal` caps it. What it buys is
 * survival: sized exactly, a signature is invalidated by the first re-quote that drifts a
 * single wei upward.
 *
 * Why 25% and not the 5% this started at. Each press re-plans from scratch, and `sizeSwap` has
 * two paths that do NOT agree: an oracle seed (tight, +0.3%) and, when that seed falls short,
 * a probe-and-refine derived from the worst-price point, which deliberately overshoots. One
 * press taking the seed path and the next taking the probe path moves `requiredIn` by far more
 * than 5% — with a tight allowance the user is asked to re-sign for no reason they can see.
 * Collateral price falling during the review does the same thing, since the required size
 * scales inversely with it.
 *
 * The cost is authorising more than will be pulled for the life of the signature. That is
 * bounded by the balance, revoked in the same transaction, and never spent above the pull —
 * a worthwhile trade against re-prompting on ordinary market movement. A deliberate increase
 * in the amount still re-prompts, which is correct: that signature genuinely did not cover it.
 */
const PERMIT_HEADROOM_BPS = 2500n

/**
 * Ceiling on any permit: the live balance plus a rebase allowance (5 bps).
 *
 * aToken balances grow between the read and the block that lands, so a full drain has to be
 * authorised for slightly more than was observed. Nothing is ever authorised beyond this.
 */
const REBASE_HEADROOM_BPS = 5n

/** How much validity a held signature must still have to be worth reusing (seconds). */
export const MIN_SIGNATURE_REMAINING_S = 120n

export interface Withdrawal {
  /** `collateralToWithdraw` for the contract; `maxUint256` drains the live balance. */
  collateralToWithdraw: bigint
  /**
   * The concrete amount the contract will pull, with the drain sentinel resolved. This — not
   * `permitValue` — is what a held signature has to cover, because the headroom baked into
   * `permitValue` exists precisely to be eaten by drift between quotes.
   */
  pullAmount: bigint
  drainAll: boolean
  /** Allowance the permit grants — at or above what is pulled, never above the balance. */
  permitValue: bigint
}

/**
 * Turn a sized swap into the collateral-side numbers the contract call needs.
 *
 * Pure, so the permit-headroom rule that decides whether a signature survives a refresh is
 * testable without a wallet, a network or a clock.
 */
export function planWithdrawal({
  requiredIn,
  collAmount,
}: {
  requiredIn: bigint
  collAmount: bigint
}): Withdrawal {
  const drainAll = requiredIn >= collAmount
  const ceiling = collAmount + (collAmount * REBASE_HEADROOM_BPS) / 10000n
  const withHeadroom = requiredIn + (requiredIn * PERMIT_HEADROOM_BPS) / 10000n

  return {
    drainAll,
    collateralToWithdraw: drainAll ? maxUint256 : requiredIn,
    pullAmount: drainAll ? collAmount : requiredIn,
    permitValue: drainAll ? ceiling : (withHeadroom > ceiling ? ceiling : withHeadroom),
  }
}

/**
 * The contract's own output floor for the swap.
 *
 * Set to the router's guaranteed minimum — quoted output less the user's slippage — rather
 * than merely to the debt. The difference is what protects the SURPLUS: on an over-sized
 * close most of the output is not repaying anything, it is being forwarded to the user, and a
 * floor of `debt` lets a swap deliver far less than quoted and still succeed. Swapping 200
 * WETH quoted at 375k USDT against a 210k debt would accept 250k without complaint.
 *
 * The router enforces its own `minReturnAmount`, but that is not a substitute: under
 * `_PARTIAL_FILL` its check is pro-rata, so absolute output can fall below the figure while
 * still passing (see script/RouterSetup.s.sol). This is the backstop.
 *
 * Never below the debt, since anything less cannot repay the flash loan and would fail the
 * contract's other check with a less obvious error.
 */
export function computeMinOut({
  debt,
  quotedOut,
  slipNum,
}: {
  debt: bigint
  /** The chosen route's quoted output. */
  quotedOut: bigint
  /** 10000 − slippageBps. */
  slipNum: bigint
}): bigint {
  const routerFloor = (quotedOut * slipNum) / 10000n
  return routerFloor > debt ? routerFloor : debt
}

/** The signed halves handed to the contract. */
export interface PermitArgs {
  value: bigint
  deadline: bigint
  v: number
  r: `0x${string}`
  s: `0x${string}`
}

export interface RevokeArgs {
  deadline: bigint
  v: number
  r: `0x${string}`
  s: `0x${string}`
}

/**
 * A signed permit pair held between attempts.
 *
 * EIP-2612 signatures are single-use only ON CONSUMPTION — one that was never broadcast stays
 * valid until its deadline. Every field here is part of what the signature commits to, so a
 * change in any of them means the pair does not authorise the new plan.
 */
export interface HeldSignature {
  chainId: number
  owner: Address
  aToken: Address
  spender: Address
  nonce: bigint
  value: bigint
  deadline: bigint
  permit: PermitArgs
  revoke: RevokeArgs
}

export interface SignatureNeed {
  chainId: number
  owner: Address
  aToken: Address
  spender: Address
  nonce: bigint
  /**
   * The amount this attempt will actually pull — `Withdrawal.pullAmount`, NOT the headroomed
   * `permitValue`. Comparing against the latter inflates both sides of the check by the same
   * factor and leaves no drift tolerance at all, which is the whole point of the headroom.
   */
  value: bigint
  nowSeconds: bigint
}

/**
 * Whether a held signature authorises this attempt.
 *
 * The nonce comparison is what proves it was never spent: consuming a permit advances the
 * aToken's nonce, so a match means the grant is still live on chain.
 *
 * The remaining-validity margin exists because the signature still has to survive a re-quote,
 * a simulation and block inclusion after it is picked up — reusing one that lapses in the
 * meantime spends gas on a transaction that reverts inside `permit`.
 */
export function canReuseSignature(held: HeldSignature | null, need: SignatureNeed): boolean {
  return reuseBlocker(held, need) === null
}

/**
 * Which requirement a held signature fails, or null if it satisfies all of them.
 *
 * Separated from the boolean so a re-prompt is explicable. "It asked me to sign again" is
 * otherwise unfalsifiable — every predicate here is individually plausible, and only the
 * actual failing one tells you whether the cause is drift, expiry, or a spent nonce.
 */
export function reuseBlocker(
  held: HeldSignature | null,
  need: SignatureNeed,
): string | null {
  if (held === null) return 'nothing held'
  if (held.chainId !== need.chainId) return `chain ${held.chainId} → ${need.chainId}`
  if (held.owner.toLowerCase() !== need.owner.toLowerCase()) return 'owner changed'
  if (held.aToken.toLowerCase() !== need.aToken.toLowerCase()) return 'collateral changed'
  if (held.spender.toLowerCase() !== need.spender.toLowerCase()) return 'deleverager changed'
  if (held.nonce !== need.nonce) return `nonce ${held.nonce} → ${need.nonce} (already spent)`
  if (held.value < need.value) {
    const overBy = Number(((need.value - held.value) * 10000n) / held.value) / 100
    return `pull grew past the signed allowance by ${overBy.toFixed(3)}% (signed ${held.value}, needs ${need.value})`
  }
  const remaining = held.deadline - need.nowSeconds
  if (remaining <= MIN_SIGNATURE_REMAINING_S) {
    return `only ${remaining}s validity left, needs more than ${MIN_SIGNATURE_REMAINING_S}s`
  }
  return null
}

export interface RouteSelection {
  router: Address | null
  swapData: `0x${string}` | null
  chosen: QuoteResponse | null
  /** The built payload, carrying the aggregator's authoritative amountOut and outputChange. */
  tx: TransactionPayload | null
  /** Why each rejected candidate was unusable, for the error the user eventually sees. */
  rejected: string[]
}

/**
 * Pick the first quote the deleverager will actually accept.
 *
 * A router's address is only known after `buildTransaction`, so the on-chain allowlist cannot
 * filter candidates during sizing — it has to happen here. Every rejection caught at this
 * point is one the user would otherwise pay gas to discover.
 */
export async function selectRoute({
  candidates,
  adapters,
  deleverager,
  allowedRouters,
  slippagePercent,
  chainId,
  debt,
  slipNum,
}: {
  candidates: QuoteResponse[]
  adapters: Adapter[]
  deleverager: Address
  allowedRouters: Set<string>
  slippagePercent: number
  chainId: number
  debt: bigint
  slipNum: bigint
}): Promise<RouteSelection> {
  // The walk itself is shared with the open flow, so the allowlist and calldata checks stay
  // identical between them. What is specific here is the bar each candidate has to clear:
  // every quote has a different output, so its guarantee is re-derived rather than inherited
  // from whichever one sizing settled on.
  const { selected, rejected } = await selectBuildableRoute(candidates, {
    build: (c) => {
      const adapter = adapters.find((a) => a.name === c.aggregator)
      if (!adapter) throw new Error('no adapter for this quote')
      return adapter.buildTransaction(c, slippagePercent, deleverager, chainId)
    },
    isAllowlisted: (router) => allowedRouters.has(router.toLowerCase()),
    reject: (c) =>
      (BigInt(c.amountOut) * slipNum) / 10000n < debt ? 'guaranteed output below the debt' : null,
    label: (c) => c.aggregator,
  })

  if (selected) {
    return {
      router: selected.tx.to as Address,
      swapData: selected.tx.data as `0x${string}`,
      chosen: selected.candidate,
      tx: selected.tx,
      rejected,
    }
  }

  return { router: null, swapData: null, chosen: null, tx: null, rejected }
}

/** Throws unless the sized plan is worth asking the user to sign for. */
export function assertExecutable(
  plan: { covered: boolean; guaranteed: boolean },
  slippagePercent: number,
): void {
  if (!plan.covered) {
    throw new CloseError('pair', 'Collateral will not cover the debt (position underwater)')
  }
  // Sizing targets a guaranteed output above the debt, but the verifying re-quote can still
  // come back short — thin liquidity, a route change, the price moving between quotes.
  // Refusing here rather than taking a signature matters: `minOut` is the full debt, so the
  // close would revert on-chain after burning gas, leaving the signature live for the rest of
  // its deadline.
  if (!plan.guaranteed) {
    throw new CloseError(
      'pair',
      `No route guarantees repaying the debt at ${slippagePercent}% slippage. Lower the slippage and try again.`,
    )
  }
}
