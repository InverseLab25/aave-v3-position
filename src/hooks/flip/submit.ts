import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from 'viem'
import { getFlipperAddress } from '../../config/chains'
import { adjustedFees, pinnedGasLimit } from '../../utils/gas'
import { canReuseSignature, reuseBlocker, type HeldSignature } from '../../lib/closePlan'
import {
  aaveV3FlipperAbi,
  buildATokenPermit,
  buildCreditDelegation,
  buildRevokePermit,
  planFlip,
  toStrategiesSig,
} from '../../lib/strategies-sdk'
import { PERMIT_HEADROOM_BPS, SIGNATURE_TTL_S } from '../flip/constants'
import { FlipError, type FlipInput, type FlipPreview, type FlipStep, type Position } from './types'

/**
 * What the send needs from the hook.
 *
 * `signatures` is the ref itself: an unspent EIP-2612 signature stays valid until its deadline,
 * so banking it is what lets a second press skip the wallet entirely.
 */
interface FlipSubmitContext {
  address: Address | undefined
  chainId: number
  publicClient: PublicClient | undefined
  /**
   * Bound to a concrete account: `signTypedData` on a client whose account is optional demands
   * one per call, and this flow always has the connected wallet or it has not started.
   */
  walletClient: WalletClient<Transport, Chain, Account> | undefined
  signatures: { current: HeldSignature | null }
  preview: (input: FlipInput) => Promise<FlipPreview>
  readPosition: (input: FlipInput) => Promise<Position>
  log: (m: string) => void
  setStep: (s: FlipStep) => void
  setExecError: (m: string | null) => void
}

/**
 * Takes the three signatures, pins the gas and the fees, and sends.
 *
 * The permit pair is banked and reused; the delegation is not, because it commits to an exact
 * borrow amount that changes with every re-quote. Both are only cleared on a receipt, so a
 * failure anywhere below leaves them spendable and a retry costs no new prompt.
 */
/** How long to wait for a submitted flip to be mined before giving up on it (ms). */
const RECEIPT_TIMEOUT_MS = 90_000

export async function submitFlip(
  input: FlipInput,
  ctx: FlipSubmitContext,
): Promise<{ hash: `0x${string}`; receipt: unknown }> {
  const {
    address, chainId, publicClient, walletClient, signatures,
    preview, readPosition, log, setStep, setExecError,
  } = ctx

      setExecError(null)
      try {
        if (!walletClient) throw new FlipError('Connect a wallet first')
        if (!publicClient) throw new FlipError('No RPC client for this chain')
        if (!address) throw new FlipError('Connect a wallet first')

        const flipper = getFlipperAddress(chainId)
        if (!flipper) throw new FlipError('Position flips are not deployed on this chain')

        const plan = await preview(input)
        const pos = await readPosition(input)
        const now = BigInt(Math.floor(Date.now() / 1000))
        const deadline = now + SIGNATURE_TTL_S

        const permitValue =
          plan.collateralAmount + (plan.collateralAmount * PERMIT_HEADROOM_BPS) / 10000n

        // The pull, not the headroomed grant. Comparing against the grant inflates both sides by
        // the same factor and leaves no drift tolerance at all, which is the point of the headroom.
        const need = {
          chainId,
          owner: address,
          aToken: pos.aFrom,
          spender: flipper,
          nonce: pos.aTokenNonce,
          value: plan.collateralAmount,
          nowSeconds: now,
        }

        let held = signatures.current
        if (!canReuseSignature(held, need)) {
          if (held) log(`re-signing: ${reuseBlocker(held, need)}`)

          setStep('permit')
          const permitSig = await walletClient.signTypedData(
            buildATokenPermit({
              chainId,
              token: pos.aFrom,
              tokenName: pos.aFromName,
              owner: address,
              spender: flipper,
              value: permitValue,
              nonce: pos.aTokenNonce,
              deadline,
            }),
          )

          setStep('revoke')
          const revokeSig = await walletClient.signTypedData(
            // Default nonceOffset of 1: the grant above consumes nonce N inside the transaction,
            // so the revoke has to sit at N+1. Wrong offset reverts with InvalidExpiration().
            buildRevokePermit({
              chainId,
              token: pos.aFrom,
              tokenName: pos.aFromName,
              owner: address,
              spender: flipper,
              nonce: pos.aTokenNonce,
              deadline,
            }),
          )

          held = {
            ...need,
            value: permitValue,
            deadline,
            permit: {
              value: permitValue,
              deadline,
              ...splitSig(toStrategiesSig(permitSig, deadline)),
            },
            revoke: { deadline, ...splitSig(toStrategiesSig(revokeSig, deadline)) },
            reviewedOut: plan.quotedOut,
          }
          signatures.current = held
        }
        if (!held) throw new FlipError('Lost the permit pair between signing and sending')

        // Built AFTER sizing and never held: the contract borrows the full signed value, so a
        // figure from an earlier round either reverts or leaves borrowing power granted away.
        setStep('delegation')
        const delegationSig = await walletClient.signTypedData(
          buildCreditDelegation({
            chainId,
            debtToken: pos.vDebtFrom,
            debtTokenName: pos.vDebtFromName,
            delegatee: flipper,
            value: plan.borrowAmount,
            nonce: pos.delegationNonce,
            deadline,
          }),
        )

        const { functionName, args } = planFlip({
          fromAsset: input.fromAsset.underlyingAsset as Address,
          toAsset: input.toAsset.underlyingAsset as Address,
          flashAmount: plan.flashAmount,
          borrowAmount: plan.borrowAmount,
          minOut: plan.minOut,
          router: plan.router,
          permit: {
            amount: held.permit.value,
            deadline: held.permit.deadline,
            r: held.permit.r,
            s: held.permit.s,
            v: held.permit.v,
          },
          revokePermit: held.revoke,
          delegation: toStrategiesSig(delegationSig, deadline),
          swapData: plan.swapData,
        })

        // Estimated here, never left to the wallet. A flip touches a flash loan, a swap, a
        // repay, a supply, a withdraw and a borrow in one transaction, and an unbuffered guess
        // made against pre-swap state runs out of gas partway through. A failed estimate throws
        // before the write, and `signatures.current` is only cleared on a receipt — so the
        // permit pair survives and a retry costs no new wallet prompt.
        const gas = await pinnedGasLimit(
          () =>
            publicClient.estimateContractGas({
              address: flipper,
              abi: aaveV3FlipperAbi,
              functionName,
              args,
              account: address,
            }),
          { chainId, label: 'flip' },
        )

        const fees = await adjustedFees(publicClient)

        setStep('sending')
        const hash = await walletClient.writeContract({
          address: flipper,
          abi: aaveV3FlipperAbi,
          functionName,
          args,
          gas,
          ...fees,
        })

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: RECEIPT_TIMEOUT_MS,
        })
        // Spent on inclusion, so it can never be reused whatever the receipt says.
        signatures.current = null
        setStep(receipt.status === 'success' ? 'done' : 'error')
        return { hash, receipt }
      } catch (e) {
        setStep('error')
        setExecError(e instanceof Error ? e.message : String(e))
        throw e
      }
}

/** viem's `parseSignature` yields a `yParity`; the contract's `Sig` struct wants r, s, v. */
function splitSig(sig: ReturnType<typeof toStrategiesSig>) {
  return { v: sig.v, r: sig.r, s: sig.s }
}
