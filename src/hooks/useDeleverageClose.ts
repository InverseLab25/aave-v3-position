import { useCallback, useRef, useState } from 'react'
import { useConnection, useChainId, usePublicClient, useWalletClient, useConfig } from 'wagmi'
import { estimateFeesPerGas, simulateContract } from 'wagmi/actions'
import {
  erc20Abi, formatUnits, parseSignature, parseUnits,
  WaitForTransactionReceiptTimeoutError, type Address,
} from 'viem'
import { calculateAdjustedFees, bufferedGasLimit } from '../utils/gas'
import { getChainConfig, getStrategiesAddress } from '../config/chains'
import { getAdaptersForChain } from '../adapters'
import { clearQuoteCache } from '../adapters/http'
import { isNativeAddress, NATIVE_ZERO_ADDRESS } from '../adapters/native'
import type { Adapter, Asset, QuoteResponse } from '../adapters/types'
import {
  COMPATIBLE_ADAPTERS,
  CloseError,
  toCloseError,
  type CloseErrorKind,
  rankRoutes,
  quoteRate,
  buildPermitTypedData,
} from '../lib/deleverage'
import {
  assertExecutable,
  computeMinOut,
  MIN_SIGNATURE_REMAINING_S,
  reuseBlocker,
  isSlippageShapedFailure,
  MAX_OUTPUT_DEGRADATION_PERCENT,
  PRICE_IMPACT_BLOCK_PERCENT,
  planWithdrawal,
  routeCostPercent,
  selectRoute,
  type HeldSignature,
  type PermitArgs,
  type RevokeArgs,
  type Withdrawal,
} from '../lib/closePlan'
import { aaveV3StrategiesAbi, planClose } from '../lib/strategies-sdk'
import { sizeSwap, oracleSeed } from '../lib/sizing'
import { getPoolDataProvider, getReserveTokens, getATokenName } from '../lib/aaveStatics'

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
const ACCRUAL_BUFFER_BPS = 50n

/** Verification re-quotes allowed while converging on the collateral actually required. */
const SIZING_ROUNDS = 3

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
const RECEIPT_TIMEOUT_MS = 5 * 60 * 1000

/**
 * How long a permit signature stays valid (seconds).
 *
 * Sized so the USABLE window is the 5 minutes it appears to be. A signature stops being
 * reusable `MIN_SIGNATURE_REMAINING_S` before it expires — that margin has to outlast the
 * re-quote, the simulation and block inclusion — so a 300 s deadline gave only 180 s of
 * actual life, and a user who spent three minutes reviewing was asked to sign again. The
 * deadline is the margin plus the window we want, not the window itself.
 */
const PERMIT_TTL_S = 300 + Number(MIN_SIGNATURE_REMAINING_S)

/** Integer precision the oracle seed carries prices at. Only the ratio matters. */
const PRICE_SCALE_DECIMALS = 8

const NONCES_ABI = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

/*//////////////////////////////////////////////////////////////
                             TYPES
//////////////////////////////////////////////////////////////*/

export interface CloseInput {
  collateral: Asset
  debtAsset: Asset
  slippagePercent: number
  /**
   * How much collateral to swap, overriding the automatic sizing. Omit to swap only what the
   * debt requires. `'all'` resolves to the live aToken balance, so a MAX choice is exact
   * rather than a formatted number round-tripped through the UI.
   *
   * Swapping more than the debt needs is a deliberate use: the contract forwards the surplus
   * debt token to the user, converting collateral to the debt asset in the same transaction.
   */
  collateralIn?: bigint | 'all'
  /** Aborts the quotes behind this plan once its result stops mattering. */
  signal?: AbortSignal
}

/** The sized, quoted swap plan shared by preview() and close(). All amounts are wei. */
interface ClosePlan {
  /** AaveV3Strategies — the contract the close executes against. */
  strategies: Address
  collateralAddr: Address
  debtAddr: Address
  aToken: Address
  /** aToken ERC-20 name, for the permit's EIP-712 domain. */
  aTokenName: string
  /** Permit nonce for the owner, read alongside the balances. */
  nonce: bigint
  debt: bigint
  collAmount: bigint
  /** Collateral fed to the swap. Always equal to `best.amountIn`. */
  requiredIn: bigint
  expectedOut: bigint
  /** Debt token the router guarantees: expectedOut × (1 − slippage). */
  minDebtOut: bigint
  /** Debt plus the accrual buffer — what the swap must actually clear. */
  needed: bigint
  /** Collateral can repay the debt at all (not underwater). */
  covered: boolean
  /** Guaranteed output clears `needed` → the close cannot revert on swap output. */
  guaranteed: boolean
  best: QuoteResponse
  /** Every compatible quote at `requiredIn`, best-first. */
  ranked: QuoteResponse[]
  adapters: Adapter[]
  /** 10000 − slippageBps, for re-deriving a candidate's guaranteed output. */
  slipNum: bigint
  /** Re-quote at a given size, so close() can rebuild calldata from a CURRENT quote. */
  quoteAt: (amountIn: bigint) => Promise<QuoteResponse[]>
  /** Lowercased router allowlist, read once per plan. */
  allowedRouters: Set<string>
}

/** Router numbers surfaced to the UI so the user can review the swap before signing. */
export interface ClosePreview {
  covered: boolean
  guaranteed: boolean
  aggregator: string
  collateralSymbol: string
  debtSymbol: string
  debtRepaid: string
  collateralSwapped: string
  collateralKeptSupplied: string
  minDebtOut: string
  expectedDebtOut: string
  collateralKeptSuppliedUsd: number | null
  /**
   * What the swap has to clear: the debt plus headroom for interest accruing before the
   * transaction lands. This, not `debtRepaid`, is what `guaranteed` is judged against.
   */
  debtRequired: string
  /**
   * Debt token the contract will forward to the user's wallet — swap output beyond what the
   * flash loan takes back. Zero on an ordinary close; the point of an over-sized one.
   */
  debtReturned: string
  /**
   * Debt token per 1 collateral token on this route. Derived from the quote, not from oracle
   * prices, so it carries the route's price impact at the size being swapped.
   */
  rate: string | null
  /**
   * The price implied by the router's guaranteed floor — `minDebtOut / requiredIn`. The
   * worst rate the swap can fill at without reverting, which is the number a floor actually
   * means to someone reading it.
   */
  guaranteedRate: string | null
  /**
   * What the route gives up, in percent of value in — price impact, DEX fees and spread
   * together, from the aggregator's own USD figures for both sides. Null when unpriced.
   */
  routeCostPercent: number | null
  /** Gas the aggregator estimates for the swap leg alone, in gas units. */
  swapGasEstimate: string | null
}

/**
 * preview() outcome. A result object rather than a bare null, because the reasons a preview
 * fails are not interchangeable: "this pair has no route" is actionable, whereas "the contract
 * is paused" is not, and showing the former for the latter sends users in circles.
 */
export interface PreviewResult {
  preview: ClosePreview | null
  error: { kind: CloseErrorKind; message: string } | null
}

export interface CloseResult {
  hash: string | null
  /**
   * `signed` means the permits were captured and nothing was submitted — the user gets the
   * numbers back to review, and the next press executes without a wallet prompt.
   */
  status: 'success' | 'reverted' | 'error' | 'signed'
  /** Unix seconds the held signature is good until, when one was just taken. */
  signatureExpiresAt?: number
  /**
   * Set when the failure was the aggregator refusing on output — the caller can offer a
   * wider tolerance instead of presenting a dead end.
   */
  slippageTooTight?: boolean
}

export type CloseStep = 'idle' | 'running' | 'done' | 'error'

/**
 * The aggregator refused on output. Distinguished from a generic failure because the remedy
 * is specific and offerable: widen the tolerance and try the same close again.
 */
class SlippageTooTightError extends CloseError {
  constructor(message: string) {
    super('pair', message)
    this.name = 'SlippageTooTightError'
  }
}

/*//////////////////////////////////////////////////////////////
                            HELPERS
//////////////////////////////////////////////////////////////*/

/**
 * A `priceInUsd` string to a scaled bigint. Returns 0 for anything unusable, which the oracle
 * seed reads as "no seed" and falls back to measuring the price with a quote.
 */
const toPriceScaled = (price: string | undefined): bigint => {
  if (!price) return 0n
  try {
    return parseUnits(price, PRICE_SCALE_DECIMALS)
  } catch {
    return 0n
  }
}

/** Reject native-ETH sentinels, which are not Aave reserves and would resolve to zero tokens. */
const assertErc20Reserve = (address: Address, label: string): void => {
  if (isNativeAddress(address) || address.toLowerCase() === NATIVE_ZERO_ADDRESS) {
    throw new CloseError(
      'pair',
      `Native ETH is not an Aave reserve — use the wrapped ${label} token (e.g. WETH)`,
    )
  }
}

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
  const log = useCallback((m: string) => setLogs((prev) => [...prev, m]), [])

  /**
   * Permits signed but not yet spent. Scoped to the hook, i.e. to the modal that mounts it;
   * `clearSignatures` exists so closing the modal drops them rather than leaving a live grant
   * in memory for the rest of its deadline.
   */
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
    async (
      { collateral, debtAsset, slippagePercent, collateralIn, signal }: CloseInput,
      logFn: (m: string) => void = () => {},
    ): Promise<ClosePlan> => {
      if (!address || !publicClient) throw new CloseError('wallet', 'Wallet not connected')

      // AaveV3Strategies, which carries `closePositionWithPermit` alongside the open entry
      // points. The separate AaveV3Deleverager it replaced was a strict subset of this contract.
      const strategies = getStrategiesAddress(chainId)
      if (!strategies) {
        throw new CloseError('deployment', 'One-click close is not available on this network')
      }
      const chainConfig = getChainConfig(chainId)
      if (!chainConfig) throw new CloseError('deployment', 'Unsupported chain')

      const collateralAddr = collateral.underlyingAsset as Address
      const debtAddr = debtAsset.underlyingAsset as Address
      assertErc20Reserve(collateralAddr, 'collateral')
      assertErc20Reserve(debtAddr, 'debt')

      const slippageBps = Math.round(slippagePercent * 100)
      // `Number.isFinite` first: NaN fails BOTH comparisons below, so without it a NaN slippage
      // sails past this guard and dies in `BigInt()` with a RangeError instead of this message.
      if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps >= 10000) {
        throw new CloseError('pair', 'Slippage must be between 0% and 100%')
      }
      const slipNum = BigInt(10000 - slippageBps)

      // 1. Immutable wiring. Memoised, so warm this costs nothing and cold it is the only
      //    waterfall — resolving it first is what lets everything live share one batch.
      logFn('Reading contract state and Aave reserve addresses…')
      const dataProvider = await getPoolDataProvider(
        publicClient,
        chainId,
        chainConfig.aave.poolAddressesProvider as Address,
      )
      const [collTokens, debtTokens] = await Promise.all([
        getReserveTokens(publicClient, chainId, dataProvider, collateralAddr),
        getReserveTokens(publicClient, chainId, dataProvider, debtAddr),
      ])
      const { aToken } = collTokens
      const { vDebt } = debtTokens
      const aTokenName = await getATokenName(publicClient, chainId, aToken)

      // 2. Everything live, in a single batch. None of these depends on the others, and the
      //    nonce riding along here is what leaves close() with nothing to read before it can
      //    open the wallet prompt.
      const [isPaused, allowedRouterList, debt, collAmount, nonce] = await Promise.all([
        publicClient.readContract({ address: strategies, abi: aaveV3StrategiesAbi, functionName: 'paused' }),
        // The whole allowlist in one read: the contract stores it in an enumerable set
        // precisely so integrators can filter routes up front rather than probing per route.
        publicClient.readContract({ address: strategies, abi: aaveV3StrategiesAbi, functionName: 'getAllowedRouters' }),
        publicClient.readContract({ address: vDebt, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
        publicClient.readContract({ address: aToken, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
        publicClient.readContract({ address: aToken, abi: NONCES_ABI, functionName: 'nonces', args: [address] }),
      ])

      if (isPaused !== 0n) {
        throw new CloseError('deployment', 'One-click close is paused on this deployment')
      }
      const allowedRouters = new Set(allowedRouterList.map((r) => r.toLowerCase()))
      if (allowedRouters.size === 0) {
        throw new CloseError('deployment', 'No swap routers are allowlisted on this contract yet')
      }
      if (debt === 0n) throw new CloseError('pair', 'No debt to close')
      if (collAmount === 0n) throw new CloseError('pair', 'No collateral to withdraw')
      // An explicit amount above the balance is a typo, not a MAX — `'all'` is how you ask for
      // everything. Left unchecked it sizes a swap larger than the withdrawal that funds it, and
      // surfaces first as a negative "kept supplied" in the preview.
      if (typeof collateralIn === 'bigint' && collateralIn > collAmount) {
        throw new CloseError(
          'pair',
          `You have ${formatUnits(collAmount, collateral.decimals)} ${collateral.symbol} supplied`,
        )
      }

      // 3. Quote and size.
      logFn(`Fetching swap routes (${COMPATIBLE_ADAPTERS.join(', ')})…`)
      const adapters = getAdaptersForChain(chainConfig.adapters).filter((a) =>
        (COMPATIBLE_ADAPTERS as readonly string[]).includes(a.name),
      )
      const quoteAt = async (amountIn: bigint) =>
        rankRoutes(
          await Promise.all(
            adapters.map((a) =>
              a
                .getQuote(collateral, debtAsset, amountIn.toString(), slippagePercent, chainId, signal)
                .catch(() => null),
            ),
          ),
        )

      const needed = (debt * (10000n + ACCRUAL_BUFFER_BPS)) / 10000n
      const sized = await sizeSwap({
        collAmount,
        debt,
        needed,
        slipNum,
        rounds: SIZING_ROUNDS,
        quoteAt,
        fixedIn: collateralIn === 'all' ? collAmount : collateralIn,
        // Aave's own oracle prices ride along on both assets, so the first guess is free.
        // Without it every refresh pays for a full-collateral probe just to learn the rate.
        seedIn: oracleSeed({
          needed,
          slipNum,
          collateralDecimals: collateral.decimals,
          debtDecimals: debtAsset.decimals,
          collateralPrice: toPriceScaled(collateral.priceInUsd),
          debtPrice: toPriceScaled(debtAsset.priceInUsd),
        }),
      })

      return {
        strategies,
        collateralAddr,
        debtAddr,
        aToken,
        aTokenName,
        nonce,
        debt,
        collAmount,
        needed,
        slipNum,
        adapters,
        allowedRouters,
        quoteAt,
        ...sized,
      }
    },
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
      setStep('running')

      /**
       * Reuse the held permits, or take fresh ones and stop.
       *
       * Stopping is the point: the first press banks an approval and hands the numbers back
       * for review, so the second press submits with no wallet dialog in between. That gap is
       * what used to let the router's output floor go stale and revert.
       *
       * Returns null when a signature was just taken and nothing should be submitted.
       */
      const obtainPermits = async (
        p: ClosePlan,
        w: Withdrawal,
      ): Promise<{ permit: PermitArgs; revoke: RevokeArgs } | null> => {
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
      const buildFreshRoute = async (p: ClosePlan) => {
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
          debt: p.debt,
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

        if ((builtOut * p.slipNum) / 10000n < p.needed) {
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
          debt: p.debt,
          slipNum: p.slipNum,
        })
        if (!preflight.router) {
          throw new CloseError(
            'pair',
            `No usable swap route for the close. Tried: ${preflight.rejected.join('; ') || 'none'}`,
          )
        }

        const permits = await obtainPermits(p, withdrawal)
        if (!permits) {
          log('Approval signed. Review the numbers, then press again to submit.')
          setStep('idle')
          return {
            hash: null,
            status: 'signed',
            signatureExpiresAt: Number(signatures.current?.deadline ?? 0n),
          }
        }

        const route = await buildFreshRoute(p)
        const { router, swapData, builtOut, quotedOut, outputChangePercent } = route
        // Derived from the route that is actually about to execute, so the contract enforces
        // the user's slippage on the whole output rather than only on the part repaying the
        // flash loan. See computeMinOut.
        const minOut = computeMinOut({ debt: p.debt, quotedOut: builtOut, slipNum: p.slipNum })
        // Built by the SDK rather than by hand: AaveV3Strategies orders these differently from
        // the AaveV3Deleverager this replaced (swapData moved last, `debtRepay` is new), and the
        // permit structs differ in both field names and field order — `value`/`{v,r,s}` there
        // against `amount`/`{r,s,v}` here. Positional args assembled locally would encode
        // silently wrong.
        const { args } = planClose({
          collateral: p.collateralAddr,
          debtAsset: p.debtAddr,
          collateralToWithdraw: withdrawal.collateralToWithdraw,
          // What this close repays. `p.debt` is already capped to the live debt for a partial
          // close, and the contract caps it again against the balance it reads.
          debtRepay: p.debt,
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
        // Aave action, and an unpinned limit leaves it to the wallet's estimate.
        let gas: bigint | undefined
        try {
          gas = bufferedGasLimit(
            await publicClient.estimateContractGas({
              address: p.strategies,
              abi: aaveV3StrategiesAbi,
              functionName: 'closePositionWithPermit',
              args,
              account: address,
            }),
          )
        } catch {
          gas = undefined
        }

        log('Submitting close transaction…')
        const hash = await walletClient.writeContract(gas ? { ...request, gas } : request)
        log(`Tx submitted: ${hash}`)

        let receipt
        try {
          receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
        } catch (e) {
          // Two different situations, and naming the wrong one sends the user to the wrong place.
          //
          // Either way the transaction IS submitted, so the hash comes back rather than the null
          // the generic failure path returns — it is the only way to find out what became of it.
          //
          // Re-pressing is safe even if it eventually lands. Both attempts spend the same aToken
          // permit nonce, so whichever arrives second reverts inside `permit` rather than closing
          // the position twice.
          if (e instanceof WaitForTransactionReceiptTimeoutError) {
            // Timed out, not failed: it may still land later, or may never have been included at
            // all — an MEV-protected RPC includes only transactions that would succeed, so one
            // that would revert simply never appears. Calling that a revert would be a guess.
            log(`No receipt after ${RECEIPT_TIMEOUT_MS / 60000} minutes. It may still land — check the explorer before retrying.`)
          } else {
            // The receipt READ failed — an RPC error, a dropped connection. That says nothing
            // about the transaction, and quoting the timeout here would send the user off to
            // watch an explorer over something that was never the problem.
            const detail =
              (e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)
            log(`Could not read the receipt: ${detail}. The transaction was submitted — check the explorer before retrying.`)
          }
          setStep('error')
          return { hash, status: 'error' }
        }

        if (receipt.status === 'success') {
          log('Position closed ✓')
          // Consumed: the nonce has advanced, so these can never authorise anything again.
          signatures.current = null
          setStep('done')
        } else {
          log('Transaction reverted')
          setStep('error')
        }
        return { hash, status: receipt.status }
      } catch (e: unknown) {
        const err = e as { shortMessage?: string; message?: string }
        log(`Error: ${err.shortMessage || err.message || String(e)}`)
        setStep('error')
        return { hash: null, status: 'error', slippageTooTight: e instanceof SlippageTooTightError }
      }
    },
    [address, chainId, publicClient, walletClient, log, config, buildPlan],
  )

  return { preview, close, logs, step, clearSignatures, warmup }
}
