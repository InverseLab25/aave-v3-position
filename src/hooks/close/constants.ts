import { MIN_SIGNATURE_REMAINING_S } from '../../lib/closePlan'
import { RECEIPT_TIMEOUT_MS } from '../../lib/settle'


/*//////////////////////////////////////////////////////////////
                            TUNING
//////////////////////////////////////////////////////////////*/

/**
 * Headroom over the debt for interest accruing between the quote and execution (0.5%).
 *
 * Covers accrual ONLY. Slippage is handled separately, by sizing against the router's
 * guaranteed output, because the two compose multiplicatively: a fixed 0.5% margin is entirely
 * consumed by 0.5% slippage, leaving the swap short of the debt.
 */
export const ACCRUAL_BUFFER_BPS = 50n

/** Verification re-quotes allowed while converging on the collateral actually required. */
export const SIZING_ROUNDS = 3

/**
 * How long to wait for a submitted close to be mined before giving up on it (ms).
 *
 * There has to be a bound. On the public mempool a failing transaction still gets mined as a
 * reverted one, so the wait always ends — but an MEV-protected RPC (which KyberSwap offers,
 * and users are encouraged onto) only includes transactions that would SUCCEED. A close that
 * would revert is then simply never included, no receipt ever arrives, and an unbounded wait
 * leaves the UI claiming to be processing forever. A dropped or replaced transaction does the
 * same thing on any RPC.
 */

/**
 * How long a permit signature stays valid (seconds).
 *
 * What actually decides whether a permit is spent is the aToken NONCE, and a transaction that
 * never landed did not spend it — so a retry after an unresolved close should reuse the
 * signature rather than ask for a new one. The deadline cannot be dropped in favour of that
 * check, though: it is signed into the EIP-712 payload and `permit()` reverts once
 * `block.timestamp` passes it, so a permit that outlives its deadline burns gas on-chain
 * instead of failing here. The deadline is therefore sized to make the nonce the decider in
 * practice, by outlasting the longest wait this flow can impose on itself.
 *
 * 30 minutes, matching the leverage-open and flip signatures so a user who signs on one screen
 * gets the same window everywhere.
 *
 * It also has to clear a floor, and every term of that floor is important:
 *   - 300 s   the review window between the two presses, which is the point of banking a
 *             signature at all;
 *   - the receipt timeout, so a close that is submitted and never mined still leaves a
 *             reusable permit behind. Without this term the permit was ALWAYS dead by the time
 *             the timeout fired — the window is measured from signing and the timeout from the
 *             later submission — so every unresolved close re-prompted needlessly;
 *   - MIN_SIGNATURE_REMAINING_S, the margin before expiry that has to outlast the re-quote,
 *             the simulation and block inclusion. A signature stops being reusable that far
 *             out, so the deadline is the margin PLUS the window we want, not the window.
 *
 * Taking the larger of the two keeps 30 minutes from silently becoming too short if the receipt
 * timeout is ever raised.
 *
 * The cost of a longer deadline is a longer window in which a leaked signature is live. It is
 * bounded: the grant only ever sets an allowance for this contract, which acts solely on
 * `msg.sender`'s behalf, and spending the nonce early only invalidates our own transaction.
 */
const PERMIT_TTL_FLOOR_S = 300 + RECEIPT_TIMEOUT_MS / 1000 + Number(MIN_SIGNATURE_REMAINING_S)
export const PERMIT_TTL_S = Math.max(1800, PERMIT_TTL_FLOOR_S)

/** Integer precision the oracle seed carries prices at. Only the ratio matters. */
export const PRICE_SCALE_DECIMALS = 8

export const NONCES_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const
