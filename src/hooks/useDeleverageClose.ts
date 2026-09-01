import { useCallback, useRef, useState } from 'react'
import { useConnection, useChainId, usePublicClient, useWalletClient, useConfig } from 'wagmi'
import { formatUnits, type Address } from 'viem'
import { getChainConfig } from '../config/chains'
import { CloseError, toCloseError } from '../lib/deleverage'
import { statedRate } from '../lib/swapRoute'
import {
  assertExecutable,
  PRICE_IMPACT_BLOCK_PERCENT,
  planWithdrawal,
  routeCostPercent,
  selectRoute,
  type HeldSignature,
} from '../lib/closePlan'
import type { TxOutcome } from '../lib/txOutcome'
import { RECEIPT_TIMEOUT_MS, settleTransaction } from '../lib/settle'
import { getPoolDataProvider, getReserveTokens, getATokenName } from '../lib/aaveStatics'
import { buildPlan as buildPlanStep } from './close/buildPlan'
import { buildFreshRoute, obtainPermits } from './close/signing'
import { submitClose } from './close/submit'
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
            // Pre-formatted here rather than in the modal: the plan is the only place that knows
            // the debt asset's decimals without the UI having to look them up again.
            routes: p.offers.map((q) => ({
              aggregator: q.aggregator,
              amountOut: formatUnits(BigInt(q.amountOut), dDec),
            })),
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
            // Both stated in ONE direction, decided by the pair rather than by the way the swap
            // runs. A close selling USDC for WETH read as "1 USDC = 0.000409 WETH", which is
            // arithmetically fine and unreadable. Same symbols on both calls, so the expected
            // fill and the floor under it stay comparable.
            rate: statedRate({
              srcSymbol: input.collateral.symbol, dstSymbol: input.debtAsset.symbol,
              srcDecimals: cDec, dstDecimals: dDec,
              spentAmount: p.requiredIn, returnAmount: p.expectedOut,
            }),
            guaranteedRate: statedRate({
              srcSymbol: input.collateral.symbol, dstSymbol: input.debtAsset.symbol,
              srcDecimals: cDec, dstDecimals: dDec,
              spentAmount: p.requiredIn, returnAmount: p.minDebtOut,
            }),
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
          tokenIn: p.collateralAddr,
          tokenOut: p.debtAddr,
          // No `simulate` on purpose. This proves a buildable route EXISTS before asking for
          // signatures and then throws the calldata away; `buildFreshRoute` re-selects and
          // measures the route that is actually submitted. Measuring here would spend a call
          // on a result nothing reads.
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
        const { hash, builtOut, minOut } = await submitClose(p, route, permits, {
          address, chainId, config, publicClient, walletClient, input, log, setStep,
        })
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
