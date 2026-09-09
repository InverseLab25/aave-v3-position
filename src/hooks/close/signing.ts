import { parseSignature, type Address } from 'viem'
import type { WalletClient } from 'viem'
import { CloseError, buildPermitTypedData } from '../../lib/deleverage'
import {
  reuseBlocker,
  MAX_OUTPUT_DEGRADATION_PERCENT,
  type HeldSignature,
  type PermitArgs,
  type RevokeArgs,
  type Withdrawal,
} from '../../lib/closePlan'
import { PERMIT_TTL_S } from './constants'
import type { ClosePlan, CloseStep } from './types'

/**
 * What the two signing steps need from the hook.
 *
 * `signatures` is the ref itself rather than its value: banking a signature is the whole point
 * of the first press, and a copy would be written to and thrown away.
 */
interface SigningContext {
  address: Address | undefined
  chainId: number
  walletClient: WalletClient | undefined
  signatures: { current: HeldSignature | null }
  log: (m: string) => void
  setStep: (s: CloseStep) => void
}

      /**
       * Reuse the held permits, or take fresh ones and stop.
       *
       * Stopping is the point: the first press banks an approval and hands the numbers back
       * for review, so the second press submits with no wallet dialog in between. That gap is
       * what used to let the router's output floor go stale and revert.
       *
       * Returns null when a signature was just taken and nothing should be submitted.
       */
export async function obtainPermits(
  p: ClosePlan,
  w: Withdrawal,
  ctx: SigningContext,
): Promise<{ permit: PermitArgs; revoke: RevokeArgs } | null> {
  const { address, chainId, walletClient, signatures, log, setStep } = ctx
        if (!address || !walletClient) throw new CloseError('wallet', 'Wallet not connected')

        const need = {
          chainId,
          owner: address,
          aToken: p.aToken,
          spender: p.strategies,
          nonce: p.nonce,
          // What is actually pulled, NOT the headroomed permit value — see canReuseSignature.
          value: w.pullAmount,
          nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
        }

        const held = signatures.current
        const blocker = reuseBlocker(held, need)
        if (blocker === null && held !== null) {
          log('Using the approval you already signed — no wallet prompt needed.')
          return { permit: held.permit, revoke: held.revoke }
        }
        if (held !== null) {
          // A held signature that cannot be reused is worth explaining: every reason is
          // individually plausible, and only the real one distinguishes drift from expiry
          // from a spent nonce.
          log(`Re-signing: ${blocker}.`)
          if (import.meta.env.DEV) console.warn('[close] signature not reusable:', blocker, { held, need })
        }

        const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_TTL_S)
        const domain = { aToken: p.aToken, aTokenName: p.aTokenName, chainId, owner: address, spender: p.strategies }

        setStep('permit')
        log('Requesting permit signature (1 of 2)…')
        const grant = parseSignature(
          await walletClient.signTypedData({
            account: address,
            ...buildPermitTypedData({ ...domain, value: w.permitValue, nonce: p.nonce, deadline }),
          }),
        )

        // The revoke, at the next nonce and over value 0. Sequential nonces mean it can only
        // ever apply after the grant, and it is signed here so the contract never has to trust
        // a value the user did not authorise. Same deadline: both are consumed in the same
        // transaction, so a separate expiry would only let one half outlive the other.
        setStep('revoke')
        log('Requesting revoke signature (2 of 2)…')
        const revoke = parseSignature(
          await walletClient.signTypedData({
            account: address,
            ...buildPermitTypedData({ ...domain, value: 0n, nonce: p.nonce + 1n, deadline }),
          }),
        )

        const vOf = (sig: ReturnType<typeof parseSignature>) =>
          sig.v !== undefined ? Number(sig.v) : sig.yParity + 27

        signatures.current = {
          chainId,
          owner: address,
          aToken: p.aToken,
          spender: p.strategies,
          nonce: p.nonce,
          value: w.permitValue,
          deadline,
          permit: { value: w.permitValue, deadline, v: vOf(grant), r: grant.r, s: grant.s },
          revoke: { deadline, v: vOf(revoke), r: revoke.r, s: revoke.s },
          // The number the user is about to be shown and asked to confirm. buildFreshRoute
          // measures the executing route against this, not against its own re-quote.
          reviewedOut: p.expectedOut,
        }
        return null
}

      /**
       * Build the calldata that will actually execute, from a quote taken right now.
       *
       * The router freezes `minReturnAmount = quotedOut × (1 − slippage)` into its calldata and
       * enforces it on execution ("Return amount is not enough"). Anything that separates this
       * build from submission — a wallet dialog, a plan carried over from the preview — ages
       * that floor until the price moves past it.
       */
interface RouteCheckContext {
  slippagePercent: number
  signatures: { current: HeldSignature | null }
  log: (m: string) => void
}

/**
 * The route the close sends, taken from the plan and checked, not re-quoted.
 *
 * This used to quote, build and simulate the field again "before submitting". The gap it was
 * written for — two wallet prompts between the reviewed route and the send — no longer exists:
 * a fresh signature returns the user to the panel, and the press that submits runs `buildPlan`
 * again first. So the plan's route is milliseconds old here, and a second round was a second
 * round of aggregator calls and simulations spent inside the minute a maker-signed route lives.
 *
 * What the refresh guaranteed is kept, on the plan's own measurement: the route must still cover
 * the debt at this slippage, and it must not have degraded past the bound against the output the
 * user reviewed when they signed.
 */
export function routeFromPlan(p: ClosePlan, ctx: RouteCheckContext) {
  const { slippagePercent, signatures, log } = ctx
  const builtOut = p.expectedOut

  if (!p.deriveRepay && (builtOut * p.slipNum) / 10000n < p.needed) {
    throw new CloseError(
      'pair',
      `The price moved and the route no longer guarantees repaying the debt at ${slippagePercent}% slippage. Nothing was submitted — try again, or raise the slippage.`,
    )
  }

  const baseline = signatures.current?.reviewedOut ?? builtOut
  const degradation = baseline > 0n ? (Number(builtOut - baseline) / Number(baseline)) * 100 : 0
  if (degradation < MAX_OUTPUT_DEGRADATION_PERCENT) {
    throw new CloseError(
      'pair',
      `The route got ${Math.abs(degradation).toFixed(2)}% worse than the quote you reviewed, so nothing was submitted. The numbers have been refreshed — press again to accept the new ones.`,
    )
  }
  log(`Sending via ${p.best.aggregator}.`)
  return {
    router: p.router,
    swapData: p.swapData,
    chosen: p.best,
    builtOut,
    quotedOut: BigInt(p.best.amountOut),
    outputChangePercent: p.tx.outputChangePercent,
  }
}
