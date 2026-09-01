import type { Address } from 'viem'
import type { StatedRate } from '../../lib/swapRoute'
import type { Adapter, Asset, QuoteResponse } from '../../adapters/types'
import { CloseError, type CloseErrorKind } from '../../lib/deleverage'

/*//////////////////////////////////////////////////////////////
                             TYPES
//////////////////////////////////////////////////////////////*/

export interface CloseInput {
  collateral: Asset
  debtAsset: Asset
  slippagePercent: number
  /**
   * How much collateral to swap, overriding the automatic sizing. Omit to swap only what the
   * debt requires. `'all'` resolves to the live aToken balance, so a MAX choice is exact
   * rather than a formatted number round-tripped through the UI.
   *
   * Swapping more than the debt needs is a deliberate use: the contract forwards the surplus
   * debt token to the user, converting collateral to the debt asset in the same transaction.
   */
  collateralIn?: bigint | 'all'
  /**
   * How much debt to repay. Omit — or pass `'all'` — for a full close; anything smaller is a
   * PARTIAL close, which repays that much and leaves the position open at lower leverage.
   *
   * The contract has always taken this as its own argument; a partial flash-loans exactly this
   * amount rather than the balance it reads, so nothing can grow underneath it. Aave still
   * enforces the resulting health factor inside the aToken's `finalizeTransfer`, which is why
   * the caller has to project it before asking for a signature.
   */
  debtIn?: bigint | 'all'
  /** Aborts the quotes behind this plan once its result stops mattering. */
  signal?: AbortSignal
  /**
   * Aggregator the user pinned in the route list, overriding the ranking. Undefined lets the
   * best route win.
   *
   * Applied where the quotes are taken, so the sizing pass, the preview and the re-quote at
   * signing time all judge the SAME route. A pin that cannot serve the swap fails the plan
   * rather than falling back to the route the user pinned past.
   */
  preferredAggregator?: string
}

/** The sized, quoted swap plan shared by preview() and close(). All amounts are wei. */
export interface ClosePlan {
  /** AaveV3Strategies — the contract the close executes against. */
  strategies: Address
  collateralAddr: Address
  debtAddr: Address
  aToken: Address
  /** aToken ERC-20 name, for the permit's EIP-712 domain. */
  aTokenName: string
  /** Permit nonce for the owner, read alongside the balances. */
  nonce: bigint
  /** What this close repays — the whole live debt, or the partial the caller asked for. */
  debt: bigint
  /**
   * The `debtRepay` argument itself. {@link FULL_CLOSE} on a full close so the contract repays
   * whatever is live when the block lands, rather than the balance read while planning — which
   * would leave the interest accrued in between still owing on a position reported as closed.
   */
  debtRepay: bigint
  /** Debt still owed once this lands. Zero on a full close. */
  debtRemaining: bigint
  /** The whole variable debt as read on chain — what `debt` is a repay out of. */
  liveDebt: bigint
  /**
   * The repay follows the route rather than the other way round, so it has to be re-derived
   * in `close()` from the calldata actually being submitted. That is a different quote from
   * the one planning saw, and the flash loan is the repay amount.
   */
  deriveRepay: boolean
  /**
   * What each candidate that reached the simulator actually returned, by aggregator name.
   *
   * Absent for a route rejected before the build — nothing was measured for it, and its quoted
   * figure is all that can honestly be shown.
   */
  measuredOut: Record<string, bigint>
  collAmount: bigint
  /** Collateral fed to the swap. Always equal to `best.amountIn`. */
  requiredIn: bigint
  expectedOut: bigint
  /** Debt token the router guarantees: expectedOut × (1 − slippage). */
  minDebtOut: bigint
  /** Debt plus the accrual buffer — what the swap must actually clear. */
  needed: bigint
  /** Collateral can repay the debt at all (not underwater). */
  covered: boolean
  /** Guaranteed output clears `needed` → the close cannot revert on swap output. */
  guaranteed: boolean
  best: QuoteResponse
  /** Every compatible quote at `requiredIn`, best-first. Narrowed to the pin when one is held. */
  ranked: QuoteResponse[]
  /**
   * The same round BEFORE the pin was applied — every aggregator that answered.
   *
   * Kept apart from `ranked` because the two answer different questions: `ranked` is what this
   * plan may execute, `offers` is what the user may pin instead. Collapsing them would leave the
   * picker listing only the route already pinned.
   */
  offers: QuoteResponse[]
  adapters: Adapter[]
  /** 10000 − slippageBps, for re-deriving a candidate's guaranteed output. */
  slipNum: bigint
  /** Re-quote at a given size, so close() can rebuild calldata from a CURRENT quote. */
  quoteAt: (amountIn: bigint) => Promise<QuoteResponse[]>
  /** Lowercased router allowlist, read once per plan. */
  allowedRouters: Set<string>
}

/** Router numbers surfaced to the UI so the user can review the swap before signing. */
export interface ClosePreview {
  covered: boolean
  guaranteed: boolean
  aggregator: string
  /**
   * Every aggregator that priced this swap, best-first, with its output pre-formatted in DEBT
   * units. The list the user pins from; the winner is `aggregator`.
   */
  routes: { aggregator: string; amountOut: string }[]
  collateralSymbol: string
  debtSymbol: string
  debtRepaid: string
  /**
   * Debt still owed once this lands — "0" on a full close. What tells the caller this is a
   * partial, and therefore that it has a health factor left to project.
   */
  debtRemaining: string
  collateralSwapped: string
  collateralKeptSupplied: string
  minDebtOut: string
  expectedDebtOut: string
  collateralKeptSuppliedUsd: number | null
  /**
   * What the swap has to clear: the debt plus headroom for interest accruing before the
   * transaction lands. This, not `debtRepaid`, is what `guaranteed` is judged against.
   */
  debtRequired: string
  /**
   * Debt token the contract will forward to the user's wallet — swap output beyond what the
   * flash loan takes back. Zero on an ordinary close; the point of an over-sized one.
   */
  debtReturned: string
  /**
   * Debt token per 1 collateral token on this route. Derived from the quote, not from oracle
   * prices, so it carries the route's price impact at the size being swapped.
   */
  rate: StatedRate | null
  /**
   * The price implied by the router's guaranteed floor — `minDebtOut / requiredIn`. The
   * worst rate the swap can fill at without reverting, which is the number a floor actually
   * means to someone reading it.
   */
  guaranteedRate: StatedRate | null
  /**
   * What the route gives up, in percent of value in — price impact, DEX fees and spread
   * together, from the aggregator's own USD figures for both sides. Null when unpriced.
   */
  routeCostPercent: number | null
  /** Gas the aggregator estimates for the swap leg alone, in gas units. */
  swapGasEstimate: string | null
}

/**
 * preview() outcome. A result object rather than a bare null, because the reasons a preview
 * fails are not interchangeable: "this pair has no route" is actionable, whereas "the contract
 * is paused" is not, and showing the former for the latter sends users in circles.
 */
export interface PreviewResult {
  preview: ClosePreview | null
  error: { kind: CloseErrorKind; message: string } | null
}

export interface CloseResult {
  hash: string | null
  /**
   * `signed` means the permits were captured and nothing was submitted — the user gets the
   * numbers back to review, and the next press executes without a wallet prompt.
   */
  status: 'success' | 'reverted' | 'error' | 'signed'
  /** Unix seconds the held signature is good until, when one was just taken. */
  signatureExpiresAt?: number
  /**
   * Set when the failure was the aggregator refusing on output — the caller can offer a
   * wider tolerance instead of presenting a dead end.
   */
  slippageTooTight?: boolean
}

/**
 * Where a close has got to.
 *
 * `running` used to cover all of it, which meant the modal could say only "Processing…" for three
 * distinct waits — two wallet prompts and an on-chain send. A user with a wallet that had not
 * surfaced its second prompt had no way to tell that from a transaction in flight.
 *
 * Named after what the user is being asked for: a withdrawal permit, then the revoke that follows
 * it at the next nonce, then the transaction itself.
 */
export type CloseStep = 'idle' | 'permit' | 'revoke' | 'sending' | 'done' | 'error'

/**
 * The aggregator refused on output. Distinguished from a generic failure because the remedy
 * is specific and offerable: widen the tolerance and try the same close again.
 */
export class SlippageTooTightError extends CloseError {
  constructor(message: string) {
    super('pair', message)
    this.name = 'SlippageTooTightError'
  }
}
