import { useCallback, useRef, useState } from 'react'
import { useConnection, useChainId, usePublicClient, useWalletClient, useConfig } from 'wagmi'
import { estimateFeesPerGas, simulateContract } from 'wagmi/actions'
import { formatUnits, type Address } from 'viem'
import { calculateAdjustedFees, pinnedGasLimit } from '../utils/gas'
import { getChainConfig } from '../config/chains'
import { clearQuoteCache } from '../adapters/http'
import { CloseError, toCloseError, quoteRate } from '../lib/deleverage'
import {
  assertExecutable,
  computeMinOut,
  deriveDebtRepay,
  isSlippageShapedFailure,
  PRICE_IMPACT_BLOCK_PERCENT,
  planWithdrawal,
  routeCostPercent,
  selectRoute,
  type HeldSignature,
} from '../lib/closePlan'
import { aaveV3StrategiesAbi, FULL_CLOSE, planClose } from '../lib/strategies-sdk'
import type { TxOutcome } from '../lib/txOutcome'
import { RECEIPT_TIMEOUT_MS, settleTransaction } from '../lib/settle'
import { getPoolDataProvider, getReserveTokens, getATokenName } from '../lib/aaveStatics'
import { buildPlan as buildPlanStep } from './close/buildPlan'
import { buildFreshRoute, obtainPermits } from './close/signing'
export { RECEIPT_TIMEOUT_MS } from '../lib/settle'

/*//////////////////////////////////////////////////////////////
                     TUNING, TYPES, CONSTANTS
//////////////////////////////////////////////////////////////*/

import {
  SlippageTooTightError,
  type CloseInput,
  type CloseResult,
  type CloseStep,
  type ClosePreview,
  type PreviewResult,
} from './close/types'

// Re-exported so consumers keep importing the flow's vocabulary from the hook itself.
export type { CloseInput, ClosePreview, CloseResult, CloseStep, PreviewResult }

/*//////////////////////////////////////////////////////////////
                              HOOK
//////////////////////////////////////////////////////////////*/

export function useDeleverageClose() {
  const { address } = useConnection()
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const config = useConfig()

  const [logs, setLogs] = useState<string[]>([])
  const [step, setStep] = useState<CloseStep>('idle')
  /** What the last close actually did, read off its receipt. Null until one lands. */
  const [outcome, setOutcome] = useState<TxOutcome | null>(null)
  /**
   * Why the last attempt failed, as one sentence — not a log line.
   *
   * The modal used to render the log array, which meant a user read "Requesting permit signature
   * (1 of 2)…" and "Tx submitted: 0x…" as though those were things they had to act on. The open
   * has always kept a decoded failure separate from its progress, and this is that channel.
   */
  const [execError, setExecError] = useState<string | null>(null)
  /**
   * A submitted close whose receipt never arrived, or could not be read. NOT a failure — the
   * transaction is on chain either way, and reporting it as failed would send a user to repay a
   * debt that may already be repaid.
   */
  const [settleNote, setSettleNote] = useState<string | null>(null)
  const log = useCallback((m: string) => setLogs((prev) => [...prev, m]), [])

  /**
   * Permits signed but not yet spent. Scoped to the hook, i.e. to the modal that mounts it;
   * `clearSignatures` exists so closing the modal drops them rather than leaving a live grant
   * in memory for the rest of its deadline.
   */
  /**
   * Forgets what the last close settled at.
   *
   * The modal outlives a close: the user can pick a different collateral and start another. The
   * settled panel describes the pair it was produced for, and nothing about it is true of the
   * next one — including which of its rows are position tokens rather than wallet balances.
   */
  const clearOutcome = useCallback(() => setOutcome(null), [])

  const signatures = useRef<HeldSignature | null>(null)
  const clearSignatures = useCallback(() => {
    signatures.current = null
  }, [])

  /*────────────────────────── warm-up ──────────────────────────*/

  /**
   * Resolve Aave's immutable wiring ahead of time.
   *
   * Cold, these are a three-deep waterfall — data provider, then the reserve tokens that need
   * it, then everything that needs those. Warming them when the modal opens makes the first
   * preview a single batch; every later refresh already was.
   *
   * Fire-and-forget: a failure here is not worth surfacing, because the next preview hits the
   * same call and reports it properly.
   */
  const warmup = useCallback(
    async ({ collateral, debtAsset }: Pick<CloseInput, 'collateral' | 'debtAsset'>) => {
      const chainConfig = getChainConfig(chainId)
      if (!publicClient || !chainConfig?.aave?.poolAddressesProvider) return
      try {
        const dataProvider = await getPoolDataProvider(
          publicClient,
          chainId,
          chainConfig.aave.poolAddressesProvider as Address,
        )
        const [collTokens] = await Promise.all([
          getReserveTokens(publicClient, chainId, dataProvider, collateral.underlyingAsset as Address),
          getReserveTokens(publicClient, chainId, dataProvider, debtAsset.underlyingAsset as Address),
        ])
        await getATokenName(publicClient, chainId, collTokens.aToken)
      } catch {
        // Deliberately silent — see above.
      }
    },
    [chainId, publicClient],
  )

  /*────────────────────────── planning ──────────────────────────*/

  /**
   * Resolve reserves, read live state, size the swap and quote it. No signing — shared by
   * preview() (display) and close() (execution) so both describe the same transaction.
   */
  const buildPlan = useCallback(
    (input: CloseInput, logFn: (m: string) => void = () => {}) =>
      buildPlanStep(input, { address, chainId, publicClient, log: logFn }),
    [address, chainId, publicClient],
  )


  /*────────────────────────── preview ──────────────────────────*/

  const preview = useCallback(
    async (input: CloseInput): Promise<PreviewResult> => {
      try {
        const p = await buildPlan(input)
        const cDec = input.collateral.decimals
        const dDec = input.debtAsset.decimals

        // Collateral the swap does not consume is never withdrawn — it stays supplied in Aave.
        const keptSupplied = p.collAmount - p.requiredIn
        const collateralPrice = Number(input.collateral.priceInUsd ?? 0)

        return {
          error: null,
          preview: {
            covered: p.covered,
            guaranteed: p.guaranteed,
            aggregator: p.best.aggregator,
            collateralSymbol: input.collateral.symbol,
            debtSymbol: input.debtAsset.symbol,
            debtRepaid: formatUnits(p.debt, dDec),
            debtRemaining: formatUnits(p.debtRemaining, dDec),
            debtRequired: formatUnits(p.needed, dDec),
            debtReturned: formatUnits(p.expectedOut > p.debt ? p.expectedOut - p.debt : 0n, dDec),
            collateralSwapped: formatUnits(p.requiredIn, cDec),
            collateralKeptSupplied: formatUnits(keptSupplied, cDec),
            collateralKeptSuppliedUsd:
              collateralPrice > 0 ? Number(formatUnits(keptSupplied, cDec)) * collateralPrice : null,
            minDebtOut: formatUnits(p.minDebtOut, dDec),
            expectedDebtOut: formatUnits(p.expectedOut, dDec),
            rate: quoteRate(p.expectedOut, p.requiredIn, cDec, dDec),
            guaranteedRate: quoteRate(p.minDebtOut, p.requiredIn, cDec, dDec),
            routeCostPercent: routeCostPercent(p.best.rawAmountInUsd, p.best.rawAmountOutUsd),
            swapGasEstimate: p.best.gasEstimate ?? null,
          },
        }
      } catch (e) {
        return { preview: null, error: toCloseError(e) }
      }
    },
    [buildPlan],
  )

  /*────────────────────────── execution ──────────────────────────*/

  const close = useCallback(
    async (input: CloseInput): Promise<CloseResult> => {
      setLogs([])
      setStep('permit')
      // Belongs to the previous attempt. Leaving any of it up would caption this one with it.
      setOutcome(null)
      setExecError(null)
      setSettleNote(null)

      try {
        if (!address || !publicClient || !walletClient) {
          throw new CloseError('wallet', 'Wallet not connected')
        }

        const p = await buildPlan(input, log)
        assertExecutable(p, input.slippagePercent)

        // A route can satisfy every output floor and still be a bad trade: the floors are
        // relative to the quote, and the quote itself may already be giving up a large share
        // of the position to price impact.
        const cost = routeCostPercent(p.best.rawAmountInUsd, p.best.rawAmountOutUsd)
        if (cost !== null && cost > PRICE_IMPACT_BLOCK_PERCENT) {
          throw new CloseError(
            'pair',
            `This route would give up ${cost.toFixed(2)}% of the position to price impact. That is too much to submit — close a smaller amount, or wait for deeper liquidity.`,
          )
        }
        log(
          `Best route: ${p.best.aggregator}. Swapping ~${formatUnits(p.requiredIn, input.collateral.decimals)} ${input.collateral.symbol}; the rest stays supplied in Aave.`,
        )

        const withdrawal = planWithdrawal(p)

        // Prove an allowlisted, buildable route exists BEFORE asking for signatures. This
        // calldata is discarded — failing here costs nothing, failing after the prompts costs
        // two signatures that stay live for the rest of their deadline.
        const preflight = await selectRoute({
          candidates: p.ranked,
          adapters: p.adapters,
          strategies: p.strategies,
          allowedRouters: p.allowedRouters,
          slippagePercent: input.slippagePercent,
          chainId,
          // No floor in derived mode: a route that returns less does not fail, it repays less.
          debt: p.deriveRepay ? 0n : p.debt,
          slipNum: p.slipNum,
        })
        if (!preflight.router) {
          throw new CloseError(
            'pair',
            `No usable swap route for the close. Tried: ${preflight.rejected.join('; ') || 'none'}`,
          )
        }

        const permits = await obtainPermits(p, withdrawal, {
          address, chainId, walletClient, signatures, log, setStep,
        })
        if (!permits) {
          log('Approval signed. Review the numbers, then press again to submit.')
          setStep('idle')
          return {
            hash: null,
            status: 'signed',
            signatureExpiresAt: Number(signatures.current?.deadline ?? 0n),
          }
        }

        const route = await buildFreshRoute(p, {
          chainId, slippagePercent: input.slippagePercent, signatures, log,
        })
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

        log('Simulating close transaction…')
        let request
        try {
          ;({ request } = await simulateContract(config, {
            address: p.strategies,
            abi: aaveV3StrategiesAbi,
            functionName: 'closePositionWithPermit',
            args,
            account: address,
            // viem's fee parameters are a union: EIP-1559 OR legacy, never both. Passing all
            // three falls outside every member of it.
            ...(adjustedMaxFeePerGas
              ? { maxFeePerGas: adjustedMaxFeePerGas, maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas }
              : { gasPrice: adjustedGasPrice }),
          }))
        } catch (e) {
          // Almost always the route: the price moved past the floor frozen into the calldata.
          // Drop the quote cache so the panel repopulates from the network rather than from a
          // response just proven stale.
          //
          // Deliberately NOT retried. Re-submitting automatically would spend gas against
          // numbers the user has not seen. The refreshed preview goes back in front of them,
          // and the held signature survives, so their next press costs no wallet prompt.
          clearQuoteCache()
          const detail = (e as { shortMessage?: string }).shortMessage ?? (e as Error).message
          // The aggregator refusing on output is a tolerance problem, not a dead end — say so,
          // and let the caller offer a wider one. Anything else is reported as-is.
          if (isSlippageShapedFailure(detail)) {
            throw new SlippageTooTightError(
              `The swap could not be filled within ${input.slippagePercent}% slippage, so nothing was submitted. A wider tolerance should let it through.`,
            )
          }
          throw new CloseError(
            'pair',
            `Simulation failed, so nothing was submitted (${detail}). The quote has been refreshed — check the new numbers and press again.`,
          )
        }

        // Pin a buffered gas limit: a flash-loan close touches far more state than a plain
        // Aave action, and an unpinned limit leaves it to the wallet's estimate. A failed
        // estimate stops the send — the held permit survives, so a retry costs no new prompt.
        const gas = await pinnedGasLimit(
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

        log('Submitting close transaction…')
        setStep('sending')
        const hash = await walletClient.writeContract({ ...request, gas })
        log(`Tx submitted: ${hash}`)

        // The four things an awaited receipt can turn out to be are classified in `lib/settle`,
        // which is this flow's own reading extracted so the open could stop guessing at it. What
        // stays here is the wording, which differs per flow for good reasons.
        const settlement = await settleTransaction({
          client: publicClient,
          hash,
          wallet: address,
          pair: { srcToken: p.collateralAddr, dstToken: p.debtAddr },
          expectedOut: builtOut,
          minOut,
        })

        if (settlement.kind === 'timeout') {
          // Timed out, not failed: it may still land later, or may never have been included at
          // all — an MEV-protected RPC includes only transactions that would succeed, so one that
          // would revert simply never appears. Calling that a revert would be a guess.
          //
          // Either way the transaction IS submitted, so the hash comes back rather than the null
          // the generic failure path returns — it is the only way to find out what became of it.
          //
          // Re-pressing is safe even if it eventually lands. Both attempts spend the same aToken
          // permit nonce, so whichever arrives second reverts inside `permit` rather than closing
          // the position twice.
          const timedOut = `No receipt after ${RECEIPT_TIMEOUT_MS / 60000} minutes. It may still land — check the explorer before retrying.`
          log(timedOut)
          setSettleNote(timedOut)
          setStep('error')
          return { hash, status: 'error' }
        }

        if (settlement.kind === 'unreadable') {
          // The receipt READ failed — an RPC error, a dropped connection. That says nothing about
          // the transaction, and quoting the timeout here would send the user off to watch an
          // explorer over something that was never the problem.
          const unreadable = `Could not read the receipt: ${settlement.detail}. The transaction was submitted — check the explorer before retrying.`
          log(unreadable)
          setSettleNote(unreadable)
          setStep('error')
          return { hash, status: 'error' }
        }

        if (settlement.kind === 'settled') {
          // Everything shown until now was a forecast. The receipt is what happened, and the fill
          // is measured against `builtOut`, the figure `minOut` was derived from — so the
          // comparison is against the route that actually executed.
          setOutcome(settlement.outcome)
          // Consumed: the nonce has advanced, so these can never authorise anything again.
          signatures.current = null
          setStep('done')
          return { hash, status: 'success' }
        }

        log('Transaction reverted')
        setExecError('The close reverted on chain, so the debt was not repaid. Nothing was spent but gas.')
        setStep('error')
        // `reverted`, not `error`: the caller distinguishes a transaction the chain rejected from
        // one that never got sent, and a test pins that distinction.
        return { hash, status: 'reverted' }
      } catch (e: unknown) {
        const err = e as { shortMessage?: string; message?: string }
        const message = err.shortMessage || err.message || String(e)
        log(`Error: ${message}`)
        setExecError(message)
        setStep('error')
        return { hash: null, status: 'error', slippageTooTight: e instanceof SlippageTooTightError }
      }
    },
    [address, chainId, publicClient, walletClient, log, config, buildPlan],
  )

  return { preview, close, logs, step, outcome, execError, settleNote, clearOutcome, clearSignatures, warmup }
}
