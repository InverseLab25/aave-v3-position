import { parseSignature, type Address } from 'viem'
import type { WalletClient } from 'viem'
import { clearQuoteCache } from '../../adapters/http'
import { CloseError, buildPermitTypedData } from '../../lib/deleverage'
import {
  reuseBlocker,
  selectRoute,
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
interface FreshRouteContext {
  chainId: number
  /** The tolerance the user is executing at — the same one the plan was sized against. */
  slippagePercent: number
  signatures: { current: HeldSignature | null }
  log: (m: string) => void
}

export async function buildFreshRoute(p: ClosePlan, ctx: FreshRouteContext) {
  const { chainId, signatures, log } = ctx
  const input = { slippagePercent: ctx.slippagePercent }
        log('Refreshing the swap route before submitting…')
        clearQuoteCache() // the reuse window outlasts a fast signing; force the network
        const candidates = await p.quoteAt(p.requiredIn)
        const { router, swapData, chosen, tx, rejected } = await selectRoute({
          candidates,
          adapters: p.adapters,
          strategies: p.strategies,
          allowedRouters: p.allowedRouters,
          slippagePercent: input.slippagePercent,
          chainId,
          // No floor in derived mode: a route that returns less does not fail, it repays less.
          debt: p.deriveRepay ? 0n : p.debt,
          slipNum: p.slipNum,
        })

        if (!router || !swapData || !chosen || !tx) {
          throw new CloseError(
            'pair',
            `No usable swap route for the close. Tried: ${rejected.join('; ') || 'none'}`,
          )
        }
        // A new quote at a new price has to re-clear what sizing cleared.
        if (BigInt(chosen.amountIn) !== p.requiredIn) {
          throw new CloseError('pair', 'Re-quote returned a different swap size — try again')
        }
        // The build endpoint re-simulates and returns its OWN amountOut, which is what the
        // router's minReturnAmount is derived from. Prefer it over the quote's wherever a
        // floor or a comparison is being made.
        const builtOut = tx.amountOut ? BigInt(tx.amountOut) : BigInt(chosen.amountOut)

        // Skipped in derived mode, which has no fixed target to fall short of — a lighter
        // route simply repays less. The degradation check below is what stops one that moved
        // far enough to matter against the numbers the user actually reviewed.
        if (!p.deriveRepay && (builtOut * p.slipNum) / 10000n < p.needed) {
          throw new CloseError(
            'pair',
            `The price moved and the route no longer guarantees repaying the debt at ${input.slippagePercent}% slippage. Nothing was submitted — try again, or raise the slippage.`,
          )
        }

        // Clearing the debt is not the same as being worth executing. On a well-covered
        // position a route that degraded several percent still clears it, and the surplus —
        // which is the user's — silently shrinks. Compare against what they actually reviewed
        // and stop, rather than submit numbers they never saw.
        //
        // The baseline is the output quoted when the SIGNATURE was taken, carried on the held
        // signature. Neither obvious alternative works: `p.expectedOut` is re-quoted by this
        // press's own `buildPlan`, and the router's `outputChangePercent` measures its build
        // against the re-quote it was handed seconds earlier. Both span milliseconds, so both
        // are blind to exactly the window this guard exists to cover — the one where the user
        // was reading the numbers.
        const baseline = signatures.current?.reviewedOut ?? p.expectedOut
        const degradation =
          baseline > 0n ? (Number(builtOut - baseline) / Number(baseline)) * 100 : 0
        if (degradation < MAX_OUTPUT_DEGRADATION_PERCENT) {
          throw new CloseError(
            'pair',
            `The route got ${Math.abs(degradation).toFixed(2)}% worse than the quote you reviewed, so nothing was submitted. The numbers have been refreshed — press again to accept the new ones.`,
          )
        }
        if (chosen.aggregator !== p.best.aggregator) {
          log(`${p.best.aggregator} unusable — falling back to ${chosen.aggregator}.`)
        }
        return { router, swapData, chosen, builtOut, quotedOut: BigInt(chosen.amountOut), outputChangePercent: tx.outputChangePercent }
}
