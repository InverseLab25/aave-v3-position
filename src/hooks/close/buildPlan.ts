import { erc20Abi, formatUnits, parseUnits, type Address, type PublicClient } from 'viem'
import { getChainConfig, getStrategiesAddress } from '../../config/chains'
import { getAdaptersForChain } from '../../adapters'
import { AggregatorHttpError } from '../../adapters/http'
import { isNativeAddress, NATIVE_ZERO_ADDRESS } from '../../adapters/native'
import { COMPATIBLE_ADAPTERS, CloseError, rankRoutes } from '../../lib/deleverage'
import { deriveDebtRepay } from '../../lib/closePlan'
import { aaveV3StrategiesAbi, FULL_CLOSE } from '../../lib/strategies-sdk'
import { sizeSwap, oracleSeed } from '../../lib/sizing'
import { getPoolDataProvider, getReserveTokens, getATokenName } from '../../lib/aaveStatics'
import { ACCRUAL_BUFFER_BPS, NONCES_ABI, PRICE_SCALE_DECIMALS, SIZING_ROUNDS } from './constants'
import type { ClosePlan, CloseInput } from './types'


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
                           BUILD PLAN
//////////////////////////////////////////////////////////////*/

/** What this needs from the hook. Passed in rather than closed over, so it can be tested alone. */
interface BuildPlanContext {
  address: Address | undefined
  chainId: number
  publicClient: PublicClient | undefined
  /** Progress line for the UI log. Defaults to a sink, so a caller that does not care can omit it. */
  log?: (m: string) => void
}

/**
 * Reads the position, quotes it, and sizes the swap — everything `preview()` and `close()` both
 * need before either can act. Throws {@link CloseError} rather than returning a partial plan,
 * because every failure here has a different remedy.
 */
export async function buildPlan(
  { collateral, debtAsset, slippagePercent, collateralIn, debtIn, signal }: CloseInput,
  ctx: BuildPlanContext,
): Promise<ClosePlan> {
  const { address, chainId, publicClient } = ctx
  const logFn = ctx.log ?? (() => {})

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

      // A repay above the live debt is a typo, not a MAX — `'all'` is how you ask for the lot.
      // Left unchecked the contract silently caps it, so the user is shown a swap sized for
      // more debt than exists and the surplus quietly lands in their wallet instead.
      if (typeof debtIn === 'bigint') {
        if (debtIn <= 0n) throw new CloseError('pair', 'Enter how much debt to repay')
        if (debtIn > debt) {
          throw new CloseError(
            'pair',
            `You owe ${formatUnits(debt, debtAsset.decimals)} ${debtAsset.symbol}`,
          )
        }
      }
      const explicitRepay = typeof debtIn === 'bigint' ? debtIn : null
      /**
       * The collateral amount decides the repay, and the aggregator's answer is what decides
       * it. Nothing to aim sizing at yet — the quote produces the target rather than consuming
       * one — so it aims at the whole debt and the answer is read back off the result.
       */
      const deriveRepay = collateralIn !== undefined && explicitRepay === null
      const targetRepay = explicitRepay ?? debt
      const targetNeeded =
        targetRepay < debt ? targetRepay : (targetRepay * (10000n + ACCRUAL_BUFFER_BPS)) / 10000n

      // 3. Quote and size.
      logFn(`Fetching swap routes (${COMPATIBLE_ADAPTERS.join(', ')})…`)
      const adapters = getAdaptersForChain(chainConfig.adapters).filter((a) =>
        (COMPATIBLE_ADAPTERS as readonly string[]).includes(a.name),
      )
      const quoteAt = async (amountIn: bigint) => {
        // An aggregator that refused to answer is not evidence about the pair. Tracked per call
        // rather than per plan, because the sizing loop quotes several times and only the round
        // that came back empty needs explaining.
        let throttled = false
        const ranked = rankRoutes(
          await Promise.all(
            adapters.map((a) =>
              a
                .getQuote(collateral, debtAsset, amountIn.toString(), slippagePercent, chainId, signal)
                .catch((e: unknown) => {
                  if (e instanceof AggregatorHttpError && e.retryable) throttled = true
                  return null
                }),
            ),
          ),
        )
        // Only when NOTHING priced: one throttled adapter alongside one that answered is a
        // complete answer, and `sizeSwap` should get on with it.
        if (ranked.length === 0 && throttled) {
          throw new CloseError(
            'aggregator',
            'The price aggregator is rate-limiting us or is down — wait a moment and try again',
          )
        }
        return ranked
      }

      const sized = await sizeSwap({
        collAmount,
        debt: targetRepay,
        needed: targetNeeded,
        slipNum,
        rounds: SIZING_ROUNDS,
        quoteAt,
        fixedIn: collateralIn === 'all' ? collAmount : collateralIn,
        // Aave's own oracle prices ride along on both assets, so the first guess is free.
        // Without it every refresh pays for a full-collateral probe just to learn the rate.
        seedIn: oracleSeed({
          needed: targetNeeded,
          slipNum,
          collateralDecimals: collateral.decimals,
          debtDecimals: debtAsset.decimals,
          collateralPrice: toPriceScaled(collateral.priceInUsd),
          debtPrice: toPriceScaled(debtAsset.priceInUsd),
        }),
      })

      // In derived mode the repay comes off the quote that was just taken; otherwise it is
      // whatever the caller asked for, already checked against the live debt above.
      const debtRepaid = deriveRepay
        ? deriveDebtRepay({ guaranteedOut: sized.minDebtOut, debt })
        : targetRepay
      if (debtRepaid <= 0n) {
        throw new CloseError(
          'pair',
          `That much ${collateral.symbol} does not buy enough ${debtAsset.symbol} to repay anything — swap more`,
        )
      }
      const partial = debtRepaid < debt
      // The buffer covers interest accruing between this read and the block that lands, which
      // only matters when the flash is sized on chain from a balance that has grown. A partial
      // flashes the fixed `debtRepaid`, so there is nothing to buffer against.
      const needed = partial ? debtRepaid : (debtRepaid * (10000n + ACCRUAL_BUFFER_BPS)) / 10000n
      /**
       * A derived partial funds itself BY CONSTRUCTION: the repay is the router's own
       * guarantee, so the swap cannot come up short of it, and there is no whole debt left to
       * be short of either. `sizeSwap` judged this quote against the full debt and said no,
       * which is the right answer to a different question.
       *
       * Not once the cap bites and this is a full close again — the flash is then read on
       * chain and can have grown, which is exactly what the ordinary checks are for.
       */
      const selfFunding = deriveRepay && partial

      return {
        strategies,
        collateralAddr,
        debtAddr,
        aToken,
        aTokenName,
        nonce,
        collAmount,
        slipNum,
        adapters,
        allowedRouters,
        quoteAt,
        ...sized,
        // After the spread: these are the plan's answers, not the sizing pass's.
        debt: debtRepaid,
        liveDebt: debt,
        deriveRepay,
        debtRepay: partial ? debtRepaid : FULL_CLOSE,
        debtRemaining: debt - debtRepaid,
        needed,
        covered: selfFunding || sized.covered,
        guaranteed: selfFunding || sized.guaranteed,
      }
}
