import { parseAbi, type Address, type Hex } from 'viem'
import type { StrategiesSig } from '../../lib/strategies-sdk'
import type { OutBasis } from '../../lib/deleverage'
import {
  type CollateralEnablement,
  type Direction,
  type MarginLocation,
  type OpenProjection,
} from '../../lib/leverage'

export interface ReserveInfo {
  address: Address
  symbol: string
  decimals: number
  /** Aave market-reference price, 8 decimals. */
  priceUsd: bigint
  ltvBps: bigint
  liquidationThresholdBps: bigint
}

export interface LeverageOpenInput {
  contract: Address
  direction: Direction
  marginAsset: MarginLocation
  /** The asset being longed or shorted, and the asset quoted against it. */
  subject: Address
  quote: Address
  marginAmount: bigint
  /**
   * How the position is sized.
   *
   * `supply` is the normal path: the user names what lands in the pool and the borrow is SOLVED
   * from the flash it has to repay. `borrow` is the boost path's alternative denomination: the
   * user names the borrow, and the flash is set to the swap's GUARANTEED output — so the
   * repayment is covered by construction there too, and any surplus is supplied
   * (AaveV3Strategies.sol:506-513).
   */
  sizedBy: 'supply' | 'borrow'
  /** What lands in the pool, in COLLATERAL wei. Zero when `sizedBy` is `borrow`. */
  supplyAmount: bigint
  /** What to borrow, in DEBT wei. Zero when `sizedBy` is `supply`. */
  borrowAmount: bigint
  /** From `maxSupplyAmount`/`maxBorrowAmount`, in whichever unit `sizedBy` names. */
  maxSupply: bigint
  slippageBps: bigint
  reserves: { collateral: ReserveInfo; debt: ReserveInfo }
  /** Wallet balance of the margin asset. */
  marginBalance: bigint
  /** `getUserAccountData` totals, 8dp USD — folded in so the health factor is account-wide. */
  existingCollateralUsd: bigint
  existingDebtUsd: bigint
  /** That account's collateral-weighted LTV and threshold, bps, eMode included. */
  existingLtvBps: bigint
  existingLiquidationThresholdBps: bigint
  /**
   * Whether Aave will actually count the incoming supply toward borrow power — see
   * `collateralEnablement`. Null when the caller has not resolved the reserve config, which
   * skips the check rather than blocking every open on a missing read.
   */
  collateralEnablement?: CollateralEnablement | null
  /**
   * Aggregator the user pinned in the route list, overriding the ranking. Undefined lets the
   * best route win.
   *
   * A pin is honoured even when it prices worse — that is the whole point of offering one — but
   * never silently: a pinned aggregator that cannot build reports `ROUTE_UNAVAILABLE` rather
   * than falling back to the route the user just rejected.
   */
  preferredAggregator?: string
}

export interface OpenPreview {
  collateral: Address
  debtAsset: Address
  marginAsset: Address
  flashAmount: bigint
  borrowAmount: bigint
  /**
   * What the router is actually handed: `borrowAmount` PLUS the margin when that margin is posted
   * in the debt asset, which goes into the same swap (AaveV3Strategies.sol:491). Distinct from
   * `borrowAmount` on purpose — quoting a rate against the borrow alone understates the input by
   * the whole margin, which reads as a rate far better than the market's.
   */
  swapIn: bigint
  /**
   * What the built route says it will return, BEFORE the slippage floor is applied — the
   * aggregator's own `amountOut`. `minOut` is this times `(1 - slippage)`, so the pair of them is
   * "what we expect" against "what the transaction will still accept".
   */
  expectedOut: bigint
  /** Whose word {@link expectedOut} is on — see `expectedOutcome`. */
  expectedBasis: OutBasis
  /**
   * What the aggregator QUOTED for this route, before anything measured it.
   *
   * Kept next to {@link expectedOut} rather than replaced by it so the two can be shown side by
   * side: the gap between them is how far the aggregator's arithmetic sits from what the route
   * actually does against live state, and it is the only number here that says anything about
   * whether that aggregator's figures can be taken at face value.
   */
  quotedOut: bigint
  /**
   * Gas the simulator measured for the SWAP alone, or null when nothing simulated it.
   *
   * The transaction's limit is built from this plus `STRATEGY_OVERHEAD_GAS` rather than from a
   * fresh `eth_estimateGas` — the simulation already executed this exact calldata against this
   * exact state, so estimating would run it a second time to learn the same thing.
   */
  swapGasUsed: bigint | null
  minOut: bigint
  /** What the account becomes, verified against the built route rather than the oracle. */
  projection: OpenProjection
  router: Address
  swapData: Hex
  /** Aggregator name, for display. */
  aggregator: string
  /**
   * What the route costs as a percentage of value put in — the aggregator's own USD figures for
   * both sides, so it folds in price impact, DEX fees and spread. Null when the aggregator did
   * not price both sides. Judge against `PRICE_IMPACT_*` in `swapRoute.ts`.
   */
  priceImpactPercent: number | null
}

export const DEBOUNCE_MS = 400

/**
 * How long to wait for the open's receipt before giving up on reporting what it settled at.
 *
 * The same five minutes the close flow waits, for the same reason — but with none of the same
 * consequences: nothing here is retried or re-signed on the strength of it, so a wait that runs
 * out costs only the settled figures, and the hash is already on screen.
 */

/** Solve, then at most one correction. Pricing is non-linear; a third round buys nothing. */
export const MAX_REFINE_ROUNDS = 2

/**
 * `ready` is the gate: approved and delegated, nothing sent. The user is looking at the position
 * with the wallet work already behind them, and the send waits on a second press.
 */
export type OpenStep = 'idle' | 'approving' | 'signing' | 'ready' | 'sending' | 'done' | 'error'

/** What the wallet has already granted, carried from `prepare` to `submit`. */
export interface PreparedOpen {
  delegation: StrategiesSig
  /** The exact borrow a fresh or reused SIGNATURE covers. Null when a standing allowance did. */
  signedValue: bigint | null
  /** The on-chain delegation allowance read at prepare time — the ceiling in the null case. */
  standingAllowance: bigint
}

export const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const)

/** How long a delegation signature stays valid. Long enough to survive a build and inclusion. */
export const SIGNATURE_TTL_S = 1800n

/**
 * A value key for an input, so staleness is judged by VALUE rather than object identity.
 *
 * `input` is not guaranteed to be referentially stable — it is whatever the caller passes — so
 * comparing references would treat a caller re-creating an equal object every render as a change
 * on every render, permanently masking a settled preview.
 */
function reserveKey(r: ReserveInfo): string {
  return `${r.address}|${r.decimals}|${r.priceUsd}|${r.ltvBps}|${r.liquidationThresholdBps}`
}
export function inputKey(i: LeverageOpenInput): string {
  return [
    i.contract, i.direction, i.marginAsset, i.subject, i.quote,
    i.marginAmount, i.sizedBy, i.supplyAmount, i.borrowAmount, i.maxSupply,
    i.slippageBps, i.marginBalance,
    i.existingCollateralUsd, i.existingDebtUsd, i.existingLtvBps, i.existingLiquidationThresholdBps,
    reserveKey(i.reserves.collateral), reserveKey(i.reserves.debt),
    // Folded in because it changes both the sizing verdict and the projection's LTV inputs, so a
    // preview computed before the reserve config resolved must not survive it arriving.
    i.collateralEnablement === null || i.collateralEnablement === undefined
      ? '-'
      : `${i.collateralEnablement.willCount}:${i.collateralEnablement.reason ?? ''}`,
    // A pin decides which route the preview is built from, so changing it has to invalidate the
    // preview exactly like an amount edit does.
    i.preferredAggregator ?? '-',
  ].join('|')
}

export interface OpenDeps {
  writeContract: (args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
    /**
     * The chain this transaction was PREPARED for, so wagmi refuses to send it anywhere else.
     *
     * `useChainId` follows the connection and the preview re-quotes when it changes, but a
     * network switched in the wallet mid-confirm leaves a window between the two. Without this
     * what goes out is one chain's calldata addressed to another chain's contract.
     */
    chainId?: number
    /** Always ours, never the wallet's — see `pinnedGasLimit`. */
    gas?: bigint
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
    gasPrice?: bigint
  }) => Promise<Hex>
  signTypedData: (payload: unknown) => Promise<Hex>
}
