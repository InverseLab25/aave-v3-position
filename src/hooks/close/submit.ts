import { formatUnits, type Address, type PublicClient, type WalletClient } from 'viem'
import type { Config } from 'wagmi'
import { estimateFeesPerGas } from 'wagmi/actions'
import { calculateAdjustedFees, pinnedGasLimit, GasEstimateError } from '../../utils/gas'
import { clearQuoteCache } from '../../adapters/http'
import { CloseError, quoteRate } from '../../lib/deleverage'
import { computeMinOut, deriveDebtRepay, isSlippageShapedFailure, planWithdrawal } from '../../lib/closePlan'
import { aaveV3StrategiesAbi, FULL_CLOSE, planClose } from '../../lib/strategies-sdk'
import type { PermitArgs, RevokeArgs } from '../../lib/closePlan'
import { SlippageTooTightError, type ClosePlan, type CloseInput, type CloseStep } from './types'
import type { buildFreshRoute } from './signing'

/** What the send path needs from the hook. */
export interface SubmitContext {
  address: Address
  chainId: number
  config: Config
  publicClient: PublicClient
  walletClient: WalletClient
  /** The caller's own input — the debug log reports both assets, not just the tolerance. */
  input: CloseInput
  log: (m: string) => void
  setStep: (s: CloseStep) => void
}

/**
 * Turns a plan, a fresh route and a signed permit pair into a submitted transaction.
 *
 * Everything here commits: the repay is re-derived from the calldata about to execute, the
 * floors come from that same calldata, and the simulation is the last chance to find out the
 * route went stale before the user pays for it.
 *
 * Returns the hash alongside the two numbers the settlement is judged against, so the caller
 * does not have to re-derive from a quote that is no longer the one that executed.
 */
export async function submitClose(
  p: ClosePlan,
  route: Awaited<ReturnType<typeof buildFreshRoute>>,
  permits: { permit: PermitArgs; revoke: RevokeArgs },
  ctx: SubmitContext,
): Promise<{ hash: `0x${string}`; builtOut: bigint; minOut: bigint }> {
  const { address, chainId, config, publicClient, walletClient, input, log, setStep } = ctx
  const withdrawal = planWithdrawal(p)
        const { router, swapData, builtOut, quotedOut, outputChangePercent } = route
        // Derived from the route that is actually about to execute, so the contract enforces
        // the user's slippage on the whole output rather than only on the part repaying the
        // flash loan. See computeMinOut.
        // Re-derived from the calldata about to be submitted, not from the planning quote:
        // those are two different quotes and the flash loan is exactly this number.
        const repay = p.deriveRepay
          ? deriveDebtRepay({ guaranteedOut: (builtOut * p.slipNum) / 10000n, debt: p.liveDebt })
          : p.debt
        if (repay <= 0n) {
          throw new CloseError('pair', 'The route no longer buys enough to repay anything')
        }
        // Max sentinel on a full close so no dust debt survives; see ClosePlan.debtRepay.
        const debtRepay = repay < p.liveDebt ? repay : FULL_CLOSE
        // Floored at what the flash will actually take. On a full close that is `needed`, since
        // the contract reads the balance at execution and it will have grown; on a partial it is
        // the fixed repay itself.
        const minOut = computeMinOut({
          debt: repay < p.liveDebt ? repay : p.needed,
          quotedOut: builtOut,
          slipNum: p.slipNum,
        })
        // Built by the SDK rather than by hand: AaveV3Strategies orders these differently from
        // the AaveV3Deleverager this replaced (swapData moved last, `debtRepay` is new), and the
        // permit structs differ in both field names and field order — `value`/`{v,r,s}` there
        // against `amount`/`{r,s,v}` here. Positional args assembled locally would encode
        // silently wrong.
        const { args } = planClose({
          collateral: p.collateralAddr,
          debtAsset: p.debtAddr,
          collateralToWithdraw: withdrawal.collateralToWithdraw,
          debtRepay,
          minOut,
          router,
          permit: {
            amount: permits.permit.value,
            deadline: permits.permit.deadline,
            r: permits.permit.r,
            s: permits.permit.s,
            v: permits.permit.v,
          },
          revokePermit: {
            deadline: permits.revoke.deadline,
            r: permits.revoke.r,
            s: permits.revoke.s,
            v: permits.revoke.v,
          },
          swapData,
        })

        // Everything the transaction commits to, decoded, before it is simulated.
        //
        // The chain of numbers that decides a "Return amount is not enough" revert is:
        //   /routes amountOut  →  /route/build amountOut (re-simulated, authoritative)
        //   →  router minReturnAmount = floor(built × (1 − slippage))   [inside the calldata]
        //   →  contract minOut       = max(debt, router floor)          [our own argument]
        // Each is printed with the price it implies, because a floor is only meaningful next
        // to the rate it corresponds to.
        if (import.meta.env.DEV) {
          const cDec = input.collateral.decimals
          const dDec = input.debtAsset.decimals
          const slipBps = BigInt(10000 - Math.round(input.slippagePercent * 100))
          const routerMinReturn = (builtOut * slipBps) / 10000n
          const priceOf = (out: bigint) => quoteRate(out, p.requiredIn, cDec, dDec) ?? '—'
          const fmt = (v: bigint) => `${formatUnits(v, dDec)} ${input.debtAsset.symbol}`
          const rate = (v: bigint) =>
            `1 ${input.collateral.symbol} = ${priceOf(v)} ${input.debtAsset.symbol}`

          console.groupCollapsed(
            `%c[close] ${formatUnits(p.requiredIn, cDec)} ${input.collateral.symbol} → ${input.debtAsset.symbol}`,
            'color:#2563eb;font-weight:bold',
          )

          console.log('%c1. what the aggregator returned', 'font-weight:bold')
          console.table({
            '/routes amountOut': { amount: fmt(quotedOut), price: rate(quotedOut) },
            '/route/build amountOut': { amount: fmt(builtOut), price: rate(builtOut) },
            'outputChange (build vs quote)':
              outputChangePercent !== undefined
                ? { amount: `${outputChangePercent > 0 ? '+' : ''}${outputChangePercent}%`, price: '' }
                : { amount: 'not reported', price: '' },
          })

          console.log(
            `%c2. minOut = max(debt, built × (1 − ${input.slippagePercent}%))`,
            'font-weight:bold',
          )
          console.table({
            'debt (live, floor A)': { amount: fmt(p.debt), price: rate(p.debt) },
            'router floor (floor B)': { amount: fmt(routerMinReturn), price: rate(routerMinReturn) },
            '→ minOut sent to contract': {
              amount: `${fmt(minOut)}   [${minOut === p.debt ? 'debt wins' : 'router floor wins'}]`,
              price: rate(minOut),
            },
            'debt + accrual buffer': { amount: fmt(p.needed), price: rate(p.needed) },
          })

          console.log('%c3. the rest of the call', 'font-weight:bold')
          console.table({
            'collateral swapped': `${formatUnits(p.requiredIn, cDec)} ${input.collateral.symbol}`,
            'collateral withdrawn': withdrawal.drainAll
              ? 'MAX (drain)'
              : `${formatUnits(withdrawal.collateralToWithdraw, cDec)} ${input.collateral.symbol}`,
            'collateral balance': `${formatUnits(p.collAmount, cDec)} ${input.collateral.symbol}`,
            slippage: `${input.slippagePercent}%`,
            router,
            'swapData bytes': (swapData.length - 2) / 2,
            'permit value': `${formatUnits(permits.permit.value, cDec)} ${input.collateral.symbol}`,
            'permit nonce': p.nonce.toString(),
            'permit deadline': new Date(Number(permits.permit.deadline) * 1000).toISOString(),
          })

          console.log('raw args', {
            collateral: p.collateralAddr,
            debtAsset: p.debtAddr,
            collateralToWithdraw: withdrawal.collateralToWithdraw.toString(),
            minOut: minOut.toString(),
            router,
            swapData,
            permit: permits.permit,
            revokePermit: permits.revoke,
          })
          console.groupEnd()
        }

        const { maxFeePerGas, maxPriorityFeePerGas, gasPrice } = await estimateFeesPerGas(config)
        const { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas, adjustedGasPrice } =
          calculateAdjustedFees(maxFeePerGas, maxPriorityFeePerGas, 10n, gasPrice)

        // One execution, not two. `estimateContractGas` runs the transaction on the node, so a
        // route that went stale reverts HERE — an eth_call on top of it would be asking the same
        // question again. And there is no gap between the two to worry about: `pinnedGasLimit`
        // buffers upward and clamps only down to the chain's cap, never below the estimate, so
        // the limit sent is always one the transaction has already been shown to run in.
        //
        // Matches the open, which has always worked this way.
        log('Sizing the close…')
        let gas: bigint
        try {
          gas = await pinnedGasLimit(
            () =>
              publicClient.estimateContractGas({
                address: p.strategies,
                abi: aaveV3StrategiesAbi,
                functionName: 'closePositionWithPermit',
                args,
                account: address,
              }),
            { chainId, label: 'close' },
          )
        } catch (e) {
          // Over the chain's per-transaction cap is not a stale route and not retryable: the
          // route has to change. Refreshing the quote and inviting another press would send the
          // user round a loop that cannot end.
          if (e instanceof GasEstimateError && e.overCap) throw new CloseError('pair', e.message)

          // Almost always the route: the price moved past the floor frozen into the calldata.
          // Drop the quote cache so the panel repopulates from the network rather than from a
          // response just proven stale.
          //
          // Deliberately NOT retried. Re-submitting automatically would spend gas against
          // numbers the user has not seen. The refreshed preview goes back in front of them,
          // and the held signature survives, so their next press costs no wallet prompt.
          clearQuoteCache()
          // `pinnedGasLimit` wraps the node's error; the revert reason is on the cause.
          const src = e instanceof GasEstimateError ? (e.cause ?? e) : e
          const detail = (src as { shortMessage?: string }).shortMessage ?? (src as Error).message
          // The aggregator refusing on output is a tolerance problem, not a dead end — say so,
          // and let the caller offer a wider one. Anything else is reported as-is.
          if (isSlippageShapedFailure(detail)) {
            throw new SlippageTooTightError(
              `The swap could not be filled within ${input.slippagePercent}% slippage, so nothing was submitted. A wider tolerance should let it through.`,
            )
          }
          throw new CloseError(
            'pair',
            `The close would have reverted, so nothing was submitted (${detail}). The quote has been refreshed — check the new numbers and press again.`,
          )
        }

        log('Submitting close transaction…')
        setStep('sending')
        const hash = await walletClient.writeContract({
          address: p.strategies,
          abi: aaveV3StrategiesAbi,
          functionName: 'closePositionWithPermit',
          args,
          account: address,
          chain: null,
          gas,
          // viem's fee parameters are a union: EIP-1559 OR legacy, never both. Passing all
          // three falls outside every member of it.
          ...(adjustedMaxFeePerGas
            ? { maxFeePerGas: adjustedMaxFeePerGas, maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas }
            : { gasPrice: adjustedGasPrice }),
        })
  return { hash, builtOut, minOut }
}
