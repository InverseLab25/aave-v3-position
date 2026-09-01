import type { Address, Hex, PublicClient } from 'viem'
import {
  getDelegationAllowance,
  getPauseState,
  getPermitContext,
  planOpen,
  buildCreditDelegation,
  toStrategiesSig,
  ZERO_STRATEGIES_SIG,
  aaveV3StrategiesAbi,
} from '../../lib/strategies-sdk'
import { resolveOpenMode } from '../../lib/leverage'
import { resolveMode } from '../../lib/strategies-sdk'
import {
  browserStorage,
  canReuseDelegation,
  saveDelegation,
  type HeldDelegation,
} from '../../lib/delegationCache'
import type { TxOutcome } from '../../lib/txOutcome'
import { RECEIPT_TIMEOUT_MS, settleTransaction } from '../../lib/settle'
import { getChainConfig } from '../../config/chains'
import { adjustedFees, pinnedGasLimit } from '../../utils/gas'
import { getPoolDataProvider, getReserveTokens } from '../../lib/aaveStatics'
import { decodeStrategiesError } from '../../lib/strategiesErrors'
import type { StrategiesRemedy } from '../../lib/strategiesErrors'
import { extractRevertMessage } from '../../utils/errors'
import {
  ERC20_ABI,
  SIGNATURE_TTL_S,
  type LeverageOpenInput,
  type OpenDeps,
  type OpenPreview,
  type OpenStep,
  type PreparedOpen,
} from '../open/types'

/**
 * What the two acting steps need from the hook.
 *
 * Wide, and honestly so: `prepare` and `submit` between them touch every piece of state this
 * flow owns. Naming each one here is the point — as closures over the component body the same
 * dependencies were invisible, and the deps arrays were the only record of them.
 *
 * The refs come in as refs. Both steps write through them, and a copy would be written to and
 * thrown away.
 */
interface BaseContext {
  input: LeverageOpenInput | null
  /** The preview on screen, or null when it has gone stale. Guarded inside, not out. */
  effectivePreview: OpenPreview | null
  client: PublicClient | undefined
  owner: Address | undefined
  chainId: number
  deps: () => OpenDeps
  refresh: () => void
  prepared: { current: PreparedOpen | null }
  /** Set while a signature is live, so the preview run cannot move the plan underneath it. */
  frozen: { current: boolean }
  setStep: (v: OpenStep) => void
  setExecError: (v: string | null) => void
  setExecRemedy: (v: StrategiesRemedy | null) => void
  setSettleNote: (v: string | null) => void
}

/**
 * Split rather than shared, and deliberately so. `prepare` never touches `forget` and `submit`
 * never touches `held`; one context carrying both would make each callback close over a value it
 * does not use, which is exactly the dependency the hook's memoisation is trying not to have.
 */
interface PrepareContext extends BaseContext {
  held: HeldDelegation | null
  setStorageTick: (f: (t: number) => number) => void
}

export interface SubmitContext extends BaseContext {
  forget: () => void
  /** The hash this attempt sent, so a late receipt can tell its own send from a newer one. */
  currentSend: { current: Hex | null }
  setTxHash: (v: Hex | undefined) => void
  setOutcome: (v: TxOutcome | null) => void
}

/**
 * The token the margin is paid in, from the form alone.
 *
 * Must agree with `planOpen` and with the preview's `marginAsset`, which routes everything but
 * "debt" through the collateral entry point — a disagreement approves the wrong token.
 */
function marginTokenOf(input: LeverageOpenInput): Address {
  const mode = resolveOpenMode(input.direction, input.marginAsset)
  const { collateral, debtAsset } = resolveMode({ mode, volatile: input.subject, stable: input.quote })
  return (input.marginAsset === 'debt' ? debtAsset : collateral) as Address
}

/**
 * Approve the margin, if the allowance does not already cover it.
 *
 * Split off `prepareOpen` because it needs no route: the token and the amount both come from the
 * form, so the panel can do this before a single quote has been asked for. The delegation is the
 * half that genuinely needs a solved borrow — it signs ONE exact figure the contract matches
 * exactly (AaveV3Strategies.sol:287,343), so signing the oracle seed on the panel would revert.
 *
 * Returns whether the margin is now approved, because the caller opens the confirmation on the
 * strength of it and `step` is state an awaiting caller cannot read back in time. False means the
 * wallet refused, and the user stays on the form where the error renders under the button.
 */
export async function approveMargin(ctx: {
  input: LeverageOpenInput | null
  client: PublicClient | undefined
  owner: Address | undefined
  chainId: number
  deps: () => OpenDeps
  setStep: (v: OpenStep) => void
  setExecError: (v: string | null) => void
  setExecRemedy: (v: StrategiesRemedy | null) => void
}): Promise<boolean> {
  const { input, client, owner, chainId, deps, setStep, setExecError, setExecRemedy } = ctx
  if (!input || !client || !owner) return false

  setExecError(null)
  setExecRemedy(null)
  try {
    // Checked before the wallet is asked for anything. An approve into a paused contract is a
    // real transaction the user pays for and cannot use, and the panel no longer prices — so
    // `previewError === 'PAUSED'`, which used to carry this, never arrives before the modal.
    const { paused } = await getPauseState(client, input.contract)
    if (paused) {
      setExecError('Leverage is paused.')
      setStep('error')
      return false
    }

    const marginAsset = marginTokenOf(input)
    setStep('approving')
    const allowance = (await client.readContract({
      address: marginAsset, abi: ERC20_ABI, functionName: 'allowance',
      args: [owner, input.contract],
    })) as bigint
    if (allowance >= input.marginAmount) {
      // Nothing to prompt for. A wallet popping up here on a second open reads as a fault.
      setStep('idle')
      return true
    }

    const approveGas = await pinnedGasLimit(
      () =>
        client.estimateContractGas({
          address: marginAsset, abi: ERC20_ABI, functionName: 'approve',
          args: [input.contract, input.marginAmount], account: owner,
        }),
      { chainId, label: 'approve' },
    )
    await deps().writeContract({
      address: marginAsset, abi: ERC20_ABI, functionName: 'approve',
      args: [input.contract, input.marginAmount], gas: approveGas,
      ...(await adjustedFees(client)),
    })
    setStep('idle')
    return true
  } catch (err) {
    const decoded = decodeStrategiesError(err)
    setExecError(decoded?.message ?? extractRevertMessage(err))
    setExecRemedy(decoded?.remedy ?? null)
    setStep('error')
    return false
  }
}

/**
 * Take the delegation, and bank it.
 *
 * The approval is no longer part of this — see {@link approveMargin}, which the panel runs before
 * the modal opens. What is left needs a priced route, so it runs from the modal.
 *
 * Returns false when nothing was authorised — the caller keeps the modal open rather than
 * moving on to a send that would revert on the delegation check.
 */
export async function prepareOpen(ctx: PrepareContext): Promise<boolean> {
  const {
    input, effectivePreview, client, owner, chainId, deps, refresh, held,
    prepared, frozen, setStep, setExecError, setExecRemedy, setSettleNote, setStorageTick,
  } = ctx

    if (!input || !effectivePreview || !client || !owner) return false

    // The delegation signs an exact borrowAmount, so the plan must not move once we start.
    frozen.current = true
    setExecError(null)
    setExecRemedy(null)
    setSettleNote(null)
    try {
      const chainConfig = getChainConfig(chainId)
      if (!chainConfig) throw new Error('Unsupported chain')
      const dataProvider = await getPoolDataProvider(client, chainId, chainConfig.aave.poolAddressesProvider)
      const { vDebt: variableDebtToken } = await getReserveTokens(
        client, chainId, dataProvider, effectivePreview.debtAsset,
      )

      // Delegate credit, unless a standing delegation already covers this borrow. The margin
      // approval happened on the panel, before any of this was priced.
      setStep('signing')
      const standing = await getDelegationAllowance(client, variableDebtToken, owner, input.contract)
      let delegation = ZERO_STRATEGIES_SIG
      if (standing < effectivePreview.borrowAmount) {
        // Read either way: the nonce is what proves a held signature was never spent, so it is
        // needed to decide on reuse just as much as it is needed to take a fresh signature.
        const ctx = await getPermitContext(client, variableDebtToken, owner)
        const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
        const need = {
          chainId, owner,
          debtAsset: effectivePreview.debtAsset,
          debtToken: variableDebtToken,
          delegatee: input.contract,
          nonce: ctx.nonce,
          value: effectivePreview.borrowAmount,
          nowSeconds,
        }

        if (held && canReuseDelegation(held, need)) {
          // Nothing to prompt for. This is the retry after a revert or a stale route: the
          // signature was never consumed, so the same one authorises this attempt.
          delegation = toStrategiesSig(held.signature, held.deadline)
        } else {
          const deadline = nowSeconds + SIGNATURE_TTL_S
          const signature = await deps().signTypedData(
            buildCreditDelegation({
              chainId, debtToken: variableDebtToken, debtTokenName: ctx.name,
              delegatee: input.contract, value: effectivePreview.borrowAmount,
              nonce: ctx.nonce, deadline,
            }),
          )
          // Banked BEFORE the send, which is the only ordering that helps: what has to survive is
          // precisely the attempt that fails after this point.
          const fresh: HeldDelegation = {
            chainId, owner,
            debtAsset: need.debtAsset,
            debtToken: need.debtToken,
            delegatee: need.delegatee,
            nonce: need.nonce,
            value: need.value,
            deadline,
            signature,
            // The tolerance this was signed under, so a later edit to it is judged against the
            // seed it was adopted at rather than against one the edit itself moved.
            slippageBps: input.slippageBps,
          }
          saveDelegation(browserStorage(), fresh)
          setStorageTick((t) => t + 1)
          delegation = toStrategiesSig(signature, deadline)
        }
      }

      // Authorised, not opened. What the borrow was authorised FOR is recorded alongside it,
      // because the modal keeps re-pricing from here and `submit` has to know whether the route
      // it ends up sending still falls inside this grant.
      prepared.current = {
        delegation,
        signedValue: standing < effectivePreview.borrowAmount ? effectivePreview.borrowAmount : null,
        standingAllowance: standing,
      }
      setStep('ready')
      return true
    } catch (err) {
      const decoded = decodeStrategiesError(err)
      setExecError(decoded?.message ?? extractRevertMessage(err))
      setExecRemedy(decoded?.remedy ?? null)
      setStep('error')
      return false
    } finally {
      frozen.current = false
      // Re-arm the preview effect now the freeze is lifting. `frozen` is a ref, so clearing it
      // alone does not re-render — a preview left over from before signing could otherwise go
      // stale forever with no input change to prompt a refresh.
      refresh()
    }
}

  /**
   * The send, against whatever route is on screen at the moment it is pressed.
   *
   * The route is deliberately the CURRENT one rather than the one `prepare` saw: the modal
   * re-prices while it is open precisely so the calldata is seconds old, and holding the older
   * route would give that back. The borrow is the part that may not move, so it is checked.
   */
export async function submitOpen(ctx: SubmitContext): Promise<void> {
  const {
    input, effectivePreview, client, owner, chainId, deps, refresh, forget,
    prepared, frozen, currentSend, setStep, setTxHash, setOutcome, setExecError, setExecRemedy,
    setSettleNote,
  } = ctx

    const authorisation = prepared.current
    // Nothing has been authorised, so a send would revert on the delegation check and cost the
    // gas to find out. The caller is expected to have run `prepare` first.
    if (!authorisation) return
    if (!input || !effectivePreview || !client || !owner) return

    // A delegation signature authorises ONE exact figure (AaveV3Strategies.sol:287,343); a
    // standing allowance authorises anything up to its ceiling. Either way, a borrow outside what
    // was granted reverts — and the pin only holds the figure still while the signature lives, so
    // one timing out mid-modal lands exactly here.
    const covered =
      authorisation.signedValue !== null
        ? effectivePreview.borrowAmount === authorisation.signedValue
        : effectivePreview.borrowAmount <= authorisation.standingAllowance
    if (!covered) {
      setExecError(
        'The route re-priced past the borrow you authorised. Nothing was submitted — re-sign at the new size to continue.',
      )
      setExecRemedy(null)
      setStep('error')
      return
    }

    frozen.current = true
    setExecError(null)
    setExecRemedy(null)
    setSettleNote(null)
    /** The hash, once there is one — read outside the block so the receipt can be waited on. */
    let sent: Hex | undefined
    try {
      setStep('sending')
      const plan = planOpen({
        mode: resolveOpenMode(input.direction, input.marginAsset),
        volatile: input.subject, stable: input.quote,
        flashAmount: effectivePreview.flashAmount, borrowAmount: effectivePreview.borrowAmount,
        marginAmount: input.marginAmount, minOut: effectivePreview.minOut,
        router: effectivePreview.router, swapData: effectivePreview.swapData,
        delegation: authorisation.delegation,
      })
      // Estimated here, never left to the wallet: an unpinned limit on a flash-loan open is an
      // out-of-gas revert with the margin already approved and the delegation already spent.
      // A failed estimate throws before the write, and `prepared.current` is only cleared after
      // a successful send — so the signature survives and a retry costs no new prompt.
      const openGas = await pinnedGasLimit(
        () =>
          client.estimateContractGas({
            address: input.contract, abi: aaveV3StrategiesAbi,
            functionName: plan.functionName, args: plan.args, account: owner,
          } as Parameters<typeof client.estimateContractGas>[0]),
        { chainId, label: 'open' },
      )
      const hash = await deps().writeContract({
        address: input.contract, abi: aaveV3StrategiesAbi,
        functionName: plan.functionName, args: plan.args, gas: openGas,
        ...(await adjustedFees(client)),
      })
      sent = hash
      currentSend.current = hash
      setTxHash(hash)
      setStep('done')
      // Submitted, so this signature has done its job. Holding it past that would leave a live
      // grant in storage for a flow that has nothing left to retry, and would let a second
      // transaction be built against a nonce the first one is already spending.
      prepared.current = null
      forget()
    } catch (err) {
      console.log(err)
      const decoded = decodeStrategiesError(err)
      setExecError(decoded?.message ?? extractRevertMessage(err))
      setExecRemedy(decoded?.remedy ?? null)
      // The authorisation SURVIVES a failed send: the nonce is unspent, so the retry is what the
      // banked signature exists for. Clearing it here would re-prompt for nothing.
      setStep('error')
    } finally {
      frozen.current = false
      refresh()
    }

    // Read AFTER the block above, not inside it: `step` is already 'done' and the preview already
    // unfrozen, so a receipt that takes a block — or never comes — holds nothing else up. A
    // failure here is not a failed open, so it never reaches `execError`.
    if (!sent || !client || !owner) return
    const settlement = await settleTransaction({
      client,
      hash: sent,
      wallet: owner,
      // The swap funds the collateral leg: borrowed debt in, collateral out.
      pair: { srcToken: effectivePreview.debtAsset, dstToken: effectivePreview.collateral },
      expectedOut: effectivePreview.expectedOut,
      minOut: effectivePreview.minOut,
      // Abandoned while this was in flight. Whatever it says belongs to a screen that is gone.
      isCurrent: () => currentSend.current === sent,
    })

    switch (settlement.kind) {
      case 'settled':
        setOutcome(settlement.outcome)
        return
      // `step` went to 'done' on submission, which is all that was known then. The receipt knows
      // better: an included-and-reverted open holds no position, and leaving "done" on screen
      // tells the user the opposite of what the chain says.
      case 'reverted':
        setExecError('The open reverted on chain, so no position was opened. Nothing was spent but gas.')
        setStep('error')
        return
      // The two below are NOT errors, and must not be shown as ones: the transaction is submitted
      // either way, and calling it a failure would send the user to re-open a position they may
      // hold. But saying nothing was worse — this flow used to catch both in one empty block, so a
      // user whose receipt never arrived got no explanation of any kind. They are reported as
      // notes, and `step` stays where it was.
      case 'timeout':
        setSettleNote(
          `No receipt after ${RECEIPT_TIMEOUT_MS / 60000} minutes. It may still land — check the explorer before retrying.`,
        )
        return
      case 'unreadable':
        setSettleNote(
          `Could not read the receipt: ${settlement.detail}. The open was submitted — check the explorer before retrying.`,
        )
        return
      case 'abandoned':
        return
    }
}
