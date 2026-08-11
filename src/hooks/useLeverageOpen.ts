/**
 * Orchestrates opening a leveraged position: preview here, execute in the same hook.
 *
 * The preview is solve → build → validate. `solveBorrow` works out what has to be borrowed for
 * the swap to repay the flash, the winning route is built, and the built figures — not the
 * quote's — are what the projection and `minOut` are taken from.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useChainId, useConnection, usePublicClient, useSignTypedData, useWriteContract } from 'wagmi'
import { parseAbi, type Address, type Hex } from 'viem'
import {
  getAllowedRouters,
  getDelegationAllowance,
  getPauseState,
  getPermitContext,
  resolveMode,
  planOpen,
  buildCreditDelegation,
  toStrategiesSig,
  ZERO_STRATEGIES_SIG,
  aaveV3StrategiesAbi,
  BPS,
} from '../lib/strategies-sdk'
import {
  deriveOpen,
  projectOpen,
  resolveOpenMode,
  validateSizing,
  type CollateralEnablement,
  type Direction,
  type LeverageError,
  type MarginLocation,
  type OpenProjection,
} from '../lib/leverage'
import { solveBorrow } from '../lib/solveBorrow'
import { routeCostPercent } from '../lib/swapRoute'
import { getAdaptersForChain } from '../adapters'
import type { Adapter, QuoteResponse } from '../adapters/types'
import { getChainConfig } from '../config/chains'
import { getPoolDataProvider, getReserveTokens } from '../lib/aaveStatics'
import { COMPATIBLE_ADAPTERS, selectBuildableRoute } from '../lib/deleverage'
import { decodeStrategiesError } from '../lib/strategiesErrors'
import type { StrategiesRemedy } from '../lib/strategiesErrors'
import { extractRevertMessage } from '../utils/errors'

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
}

export interface OpenPreview {
  collateral: Address
  debtAsset: Address
  marginAsset: Address
  flashAmount: bigint
  borrowAmount: bigint
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

const DEBOUNCE_MS = 400

/** Solve, then at most one correction. Pricing is non-linear; a third round buys nothing. */
const MAX_REFINE_ROUNDS = 2

export type OpenStep = 'idle' | 'approving' | 'signing' | 'sending' | 'done' | 'error'

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const)

/** How long a delegation signature stays valid. Long enough to survive a build and inclusion. */
const SIGNATURE_TTL_S = 1800n

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
function inputKey(i: LeverageOpenInput): string {
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
  ].join('|')
}

export interface OpenDeps {
  writeContract: (args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }) => Promise<Hex>
  signTypedData: (payload: unknown) => Promise<Hex>
}

/**
 * `injected` is a PARTIAL override, not an all-or-nothing swap: a caller stubbing only
 * `signTypedData` still gets the real `writeContract` wired to wagmi underneath. That is also why
 * the wagmi hooks below are called unconditionally — rules of hooks, and the merge needs both.
 */
export function useLeverageOpen(input: LeverageOpenInput | null, injected?: Partial<OpenDeps>) {
  const client = usePublicClient()
  const chainId = useChainId()
  const { address: owner } = useConnection()

  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()

  const [preview, setPreview] = useState<OpenPreview | null>(null)
  const [previewError, setPreviewError] = useState<LeverageError | null>(null)
  // The `inputKey` the two states above were computed for. A mismatch marks them stale — see
  // `stale` below. Deriving staleness this way (rather than an effect clearing them via
  // setState) keeps the effect from calling setState in its own body, while still invalidating
  // the instant `input` changes — no debounce-length window where a stale preview is still live.
  const [previewFor, setPreviewFor] = useState<string | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)
  const [tick, setTick] = useState(0)
  const [step, setStep] = useState<OpenStep>('idle')
  const [txHash, setTxHash] = useState<Hex | undefined>()
  const [execError, setExecError] = useState<string | null>(null)
  const [execRemedy, setExecRemedy] = useState<StrategiesRemedy | null>(null)

  /** Set while a signature is held, to stop the preview moving underneath it. */
  const frozen = useRef(false)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    // Frozen: a held signature commits to an exact borrowAmount, so the plan must not move
    // underneath it. Nothing goes stale — `previewFor` still matches `input`, which has not
    // changed either.
    if (!input || frozen.current) return

    let cancelled = false
    const forInput = inputKey(input)

    const timer = setTimeout(async () => {
      setIsQuoting(true)
      setPreviewError(null)
      try {
        if (!client) {
          setPreviewError('NO_CLIENT')
          return
        }

        const mode = resolveOpenMode(input.direction, input.marginAsset)
        const { collateral, debtAsset } = resolveMode({
          mode, volatile: input.subject, stable: input.quote,
        })
        const coll = input.reserves.collateral
        const debt = input.reserves.debt

        // Cheap checks before spending a quote. Both denominations share the ceiling check by
        // measuring `maxSupply` in whatever unit `sizedBy` names.
        const typedAmount = input.sizedBy === 'borrow' ? input.borrowAmount : input.supplyAmount
        const sizingError = validateSizing({
          marginAsset: input.marginAsset,
          marginAmount: input.marginAmount,
          supplyAmount: typedAmount,
          marginBalance: input.marginBalance,
          maxSupply: input.maxSupply,
          collateral: input.collateralEnablement,
        })
        if (sizingError) {
          setPreviewError(sizingError)
          return
        }

        const [{ paused }, routers] = await Promise.all([
          getPauseState(client, input.contract),
          getAllowedRouters(client, input.contract),
        ])
        if (cancelled) return
        if (paused) {
          setPreviewError('PAUSED')
          return
        }

        const allowed = new Set(routers.map((r) => r.toLowerCase()))
        // Same filter the close flow uses, and for the same reason: `supportsExecution` only
        // says the adapter returns a transaction, not that this contract can execute it. See
        // COMPATIBLE_ADAPTERS — quoting the rest gets them ranked and sized against, then
        // rejected at build, which surfaces as a "rate moved" the user cannot act on.
        const adapters = getAdaptersForChain(getChainConfig(chainId)?.adapters ?? [])
          .filter((a) => (COMPATIBLE_ADAPTERS as readonly string[]).includes(a.name))

        const fromAsset = { underlyingAsset: debtAsset, symbol: '', decimals: debt.decimals }
        const toAsset = { underlyingAsset: collateral, symbol: '', decimals: coll.decimals }
        const slippagePercent = Number(input.slippageBps) / 100

        type Candidate = { a: Adapter; q: QuoteResponse }

        /** Every adapter's quote for a given debt-asset input, best output first. */
        const quoteAll = async (swapIn: bigint): Promise<Candidate[]> => {
          const results = await Promise.all(
            adapters.map(async (a) => {
              try {
                const q = await a.getQuote(
                  fromAsset, toAsset, swapIn.toString(), slippagePercent, chainId,
                )
                return q ? { a, q } : null
              } catch {
                return null
              }
            }),
          )
          return results
            .filter((r): r is Candidate => r !== null)
            .sort((x, y) => (BigInt(y.q.amountOut) > BigInt(x.q.amountOut) ? 1 : -1))
        }

        // Kept as a list so route selection can fall through a candidate that fails to build or
        // fails `validateSwapTx`, instead of erroring out on the first pick.
        let candidates: Candidate[] = []
        let borrowAmount: bigint
        let debtMargin = 0n
        // Provisional on the borrow path: the real flash is read off the BUILT route below,
        // because only the built output is what the swap actually guarantees.
        let flashAmount = 0n

        if (input.sizedBy === 'borrow') {
          // The user named the borrow, so there is nothing to solve — quote it directly. The
          // flash is derived from the route afterwards.
          borrowAmount = input.borrowAmount
          candidates = await quoteAll(borrowAmount)
          if (cancelled) return
          if (candidates.length === 0) {
            setPreviewError('NO_ROUTE')
            return
          }
        } else {
          const derived = deriveOpen({
            marginAsset: input.marginAsset,
            marginAmount: input.marginAmount,
            supplyAmount: input.supplyAmount,
          })
          flashAmount = derived.flashAmount
          debtMargin = derived.debtMargin

          const solution = await solveBorrow({
            flashAmount,
            debtMargin,
            slipNum: BPS - input.slippageBps,
            rounds: MAX_REFINE_ROUNDS,
            collateralPriceUsd: coll.priceUsd,
            debtPriceUsd: debt.priceUsd,
            collateralDecimals: coll.decimals,
            debtDecimals: debt.decimals,
            quoteAt: async (swapIn) => {
              candidates = await quoteAll(swapIn)
              return candidates.map((c) => c.q)
            },
          })
          if (cancelled) return
          if (!solution.ok) {
            setPreviewError(solution.error === 'NO_ROUTE' ? 'NO_ROUTE' : 'QUOTE_FAILED')
            return
          }
          borrowAmount = solution.solved.borrowAmount
        }

        // Build FIRST, then validate what was actually built. The list is best-output-first, so
        // a fallback prices strictly worse than the route the borrow was solved against. The
        // walk is shared with the close flow so the allowlist and calldata checks cannot drift.
        const { selected } = await selectBuildableRoute(candidates, {
          build: (c) => c.a.buildTransaction(c.q, slippagePercent, input.contract, chainId),
          isAllowlisted: (router) => allowed.has(router.toLowerCase()),
          label: (c) => c.a.name,
          cancelled: () => cancelled,
        })
        // A null here can also mean "cancelled mid-build" — check `cancelled` first, or a
        // superseded attempt writes a no-route error that a reverted input would make current.
        if (cancelled) return
        if (!selected) {
          setPreviewError('NO_ROUTE')
          return
        }
        const build = { quote: selected.candidate.q, adapter: selected.candidate.a, built: selected.tx }

        // The BUILT route's output, not the quote's: `buildTransaction`'s amountOut is
        // re-simulated and documented as authoritative, and it is what `minOut` derives from.
        const builtOut = BigInt(build.built.amountOut ?? build.quote.amountOut)
        // What this route contractually guarantees to deliver.
        const guaranteedOut = (builtOut * (BPS - input.slippageBps)) / BPS

        if (input.sizedBy === 'borrow') {
          // Flash exactly what the swap is guaranteed to return. The contract needs
          // `received >= flashAmount` (:501) and `received >= minOut` (:499), and both are this
          // same floor — so the repayment cannot come up short however the route lands, and
          // whatever it beats the floor by is supplied as surplus (:506-513).
          flashAmount = guaranteedOut
          if (flashAmount <= 0n) {
            setPreviewError('QUOTE_FAILED')
            return
          }
        } else if (guaranteedOut < flashAmount) {
          // The borrow was solved against the quote; the build can come back worse. That is a
          // moving market rather than anything the user got wrong — re-solving here would race
          // the same drift, so ask for a refresh instead. Nothing unsafe reaches the chain
          // either way: `minOut` floors at `flashAmount` below.
          setPreviewError('QUOTE_MOVED')
          return
        }

        if (borrowAmount <= 0n) {
          setPreviewError('ZERO_BORROW')
          return
        }

        // The swap input the contract will actually make: borrow PLUS the margin on the debt
        // path — AaveV3Strategies.sol:491. Scaled off the built route's realized rate.
        const swapIn = borrowAmount + debtMargin
        const quotedIn = BigInt(build.quote.amountIn)
        const expectedSwapOut = quotedIn > 0n ? (swapIn * builtOut) / quotedIn : 0n

        const projection = projectOpen({
          marginAsset: input.marginAsset,
          marginAmount: input.marginAmount,
          borrowAmount,
          expectedSwapOut,
          collateralPriceUsd: coll.priceUsd,
          debtPriceUsd: debt.priceUsd,
          collateralDecimals: coll.decimals,
          debtDecimals: debt.decimals,
          ltvBps: coll.ltvBps,
          liquidationThresholdBps: coll.liquidationThresholdBps,
          existingCollateralUsd: input.existingCollateralUsd,
          existingDebtUsd: input.existingDebtUsd,
          existingLtvBps: input.existingLtvBps,
          existingLiquidationThresholdBps: input.existingLiquidationThresholdBps,
        })

        // Aave's `borrow` reverts at the LTV wall, so land strictly below it. The wall is the
        // account's BLENDED LTV, which is what `validateBorrow` actually compares against — and
        // not generally the reserve's own, which is what `maxSupply` was computed from.
        if (projection.impliedLtvBps >= projection.avgLtvBps) {
          setPreviewError('LTV_EXCEEDED')
          return
        }

        // Never below `flashAmount`: the contract enforces both floors, and an output short of
        // the flash repayment reverts the whole transaction rather than merely disappointing.
        setPreview({
          collateral,
          debtAsset,
          // Must agree with planOpen, which routes everything but "debt" through the collateral
          // entry point. This drives which ERC-20 allowance `execute` checks, so a disagreement
          // approves the wrong token.
          marginAsset: input.marginAsset === 'debt' ? debtAsset : collateral,
          flashAmount,
          borrowAmount,
          minOut: guaranteedOut > flashAmount ? guaranteedOut : flashAmount,
          projection,
          router: build.built.to as Address,
          swapData: build.built.data as Hex,
          aggregator: build.adapter.name,
          priceImpactPercent: routeCostPercent(build.quote.rawAmountInUsd, build.quote.rawAmountOutUsd),
        })
      } catch {
        if (!cancelled) setPreviewError('QUOTE_FAILED')
      } finally {
        if (!cancelled) {
          setIsQuoting(false)
          setPreviewFor(forInput)
        }
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [input, client, chainId, owner, tick])

  // Masks preview/previewError the instant `input` no longer matches what they were computed
  // for. `execute` and the return value both use these, never the raw state, so nothing
  // downstream can observe a preview belonging to a different input than the one live.
  const stale = (input ? inputKey(input) : null) !== previewFor
  const effectivePreview = stale ? null : preview
  const effectivePreviewError = stale ? null : previewError
  const effectiveIsQuoting = stale || isQuoting

  const execute = useCallback(async () => {
    if (!input || !effectivePreview || !client || !owner) return

    // The delegation signs an exact borrowAmount, so the plan must not move once we start.
    frozen.current = true
    setExecError(null)
    setExecRemedy(null)
    try {
      const deps: OpenDeps = {
        writeContract:
          injected?.writeContract ??
          ((args) => writeContractAsync(args as Parameters<typeof writeContractAsync>[0])),
        signTypedData:
          injected?.signTypedData ??
          ((payload) => signTypedDataAsync(payload as Parameters<typeof signTypedDataAsync>[0])),
      }

      const chainConfig = getChainConfig(chainId)
      if (!chainConfig) throw new Error('Unsupported chain')
      const dataProvider = await getPoolDataProvider(client, chainId, chainConfig.aave.poolAddressesProvider)
      const { vDebt: variableDebtToken } = await getReserveTokens(
        client, chainId, dataProvider, effectivePreview.debtAsset,
      )

      // 1. Approve the margin, unless the allowance already covers it.
      setStep('approving')
      const allowance = (await client.readContract({
        address: effectivePreview.marginAsset, abi: ERC20_ABI, functionName: 'allowance',
        args: [owner, input.contract],
      })) as bigint
      if (allowance < input.marginAmount) {
        await deps.writeContract({
          address: effectivePreview.marginAsset, abi: ERC20_ABI, functionName: 'approve',
          args: [input.contract, input.marginAmount],
        })
      }

      // 2. Delegate credit, unless a standing delegation already covers this borrow.
      setStep('signing')
      const standing = await getDelegationAllowance(client, variableDebtToken, owner, input.contract)
      let delegation = ZERO_STRATEGIES_SIG
      if (standing < effectivePreview.borrowAmount) {
        const ctx = await getPermitContext(client, variableDebtToken, owner)
        const deadline = BigInt(Math.floor(Date.now() / 1000)) + SIGNATURE_TTL_S
        const signature = await deps.signTypedData(
          buildCreditDelegation({
            chainId, debtToken: variableDebtToken, debtTokenName: ctx.name,
            delegatee: input.contract, value: effectivePreview.borrowAmount,
            nonce: ctx.nonce, deadline,
          }),
        )
        delegation = toStrategiesSig(signature, deadline)
      }

      // 3. Send.
      setStep('sending')
      const plan = planOpen({
        mode: resolveOpenMode(input.direction, input.marginAsset),
        volatile: input.subject, stable: input.quote,
        flashAmount: effectivePreview.flashAmount, borrowAmount: effectivePreview.borrowAmount,
        marginAmount: input.marginAmount, minOut: effectivePreview.minOut,
        router: effectivePreview.router, swapData: effectivePreview.swapData, delegation,
      })
      const hash = await deps.writeContract({
        address: input.contract, abi: aaveV3StrategiesAbi,
        functionName: plan.functionName, args: plan.args,
      })
      setTxHash(hash)
      setStep('done')
    } catch (err) {
      const decoded = decodeStrategiesError(err)
      setExecError(decoded?.message ?? extractRevertMessage(err))
      setExecRemedy(decoded?.remedy ?? null)
      setStep('error')
    } finally {
      frozen.current = false
      // Re-arm the preview effect now the freeze is lifting. `frozen` is a ref, so clearing it
      // alone does not re-render — a preview left over from before signing could otherwise go
      // stale forever with no input change to prompt a refresh.
      refresh()
    }
  }, [input, effectivePreview, client, owner, chainId, injected, writeContractAsync, signTypedDataAsync, refresh])

  return {
    preview: effectivePreview,
    previewError: effectivePreviewError,
    isQuoting: effectiveIsQuoting,
    refresh, step, txHash, execError, execRemedy, execute,
  }
}
