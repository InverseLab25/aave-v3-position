import { type Address, type PublicClient } from 'viem'
import { getChainConfig, getFlipperAddress } from '../../config/chains'
import { getAdaptersForChain, quoteField } from '../../adapters'
import type { QuoteResponse } from '../../adapters/types'
import { selectRoute } from '../../lib/closePlan'
import { simulateSwap } from '../../adapters/simulate'
import { aaveV3FlipperAbi, sizeFlip, WAD, type FlipSize } from '../../lib/strategies-sdk'
import { QUOTE_ROUNDS, RATE_BUFFER_BPS } from '../flip/constants'
import { FlipError, type FlipInput, type FlipPreview, type Position } from '../flip/types'

/** What sizing needs from the hook. */
interface PreviewContext {
  chainId: number
  publicClient: PublicClient | undefined
  readPosition: (input: FlipInput) => Promise<Position>
  log: (m: string) => void
}

/**
 * Sizes the flip and picks the route it will execute through.
 *
 * Two quote rounds: the first seeds off the Aave oracle, which costs no network call and only
 * has to be close enough to ask the aggregator a sensible question; the second resizes against
 * what a router actually offered for that size. A third is not worth another round trip to every
 * aggregator, because a mis-sized flash costs a fraction of a percent of leverage, not a revert.
 */
export async function previewFlip(
  input: FlipInput,
  ctx: PreviewContext,
): Promise<FlipPreview> {
  const { chainId, publicClient, readPosition, log } = ctx

      const fromAddr = input.fromAsset.underlyingAsset as Address
      const toAddr = input.toAsset.underlyingAsset as Address
      if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
        throw new FlipError('Same asset on both sides — that is not a flip')
      }

      const flipper = getFlipperAddress(chainId)
      if (!flipper) throw new FlipError('Position flips are not deployed on this chain')

      const cfg = getChainConfig(chainId)
      if (!cfg) throw new FlipError('Unsupported chain')

      const pos = await readPosition(input)
      if (pos.collateralAmount === 0n) throw new FlipError('No collateral to flip')

      const slipNum = BigInt(Math.round((100 - input.slippagePercent) * 100))
      const adapters = getAdaptersForChain(cfg.adapters ?? [])

      // Which routers the contract will accept. A quote through anything else is wasted work,
      // and the rejection is only visible after `buildTransaction` names the router.
      const allowedRouters = new Set(
        (
          (await publicClient!.readContract({
            address: flipper,
            abi: aaveV3FlipperAbi,
            functionName: 'getAllowedRouters',
          })) as readonly Address[]
        ).map((r) => r.toLowerCase()),
      )

      const fromUnit = 10n ** BigInt(pos.fromDecimals)
      const toUnit = 10n ** BigInt(pos.toDecimals)

      // Round one seeds off the oracle: no network call, and it only has to be close enough to
      // ask the aggregator a sensible question.
      let rateWad = (pos.fromPriceUsd * toUnit * WAD) / (pos.toPriceUsd * fromUnit)
      let size = unwrapSize(sizeFlip({ ...sizingInput(input, pos), rateWad }))
      let route: Awaited<ReturnType<typeof selectRoute>> | null = null

      for (let round = 0; round < QUOTE_ROUNDS; round++) {
        route = await quoteAndSelect({
          input, chainId, adapters, allowedRouters, flipper,
          flashAmount: size.flashAmount, debt: pos.debtAmount, slipNum,
        })
        if (!route?.chosen) {
          throw new FlipError(
            `No route for this flip${route?.rejected.length ? `: ${route.rejected.join('; ')}` : ''}`,
          )
        }
        // Re-derive the rate from what the aggregator actually offered for THIS input, then
        // resize. Round two lands on a size a router has really quoted.
        rateWad = (BigInt(route.chosen.amountOut) * WAD) / size.flashAmount
        size = unwrapSize(sizeFlip({ ...sizingInput(input, pos), rateWad }))
      }

      if (!route?.router || !route.swapData || !route.chosen) {
        throw new FlipError('No route for this flip')
      }

      log(`flip sized: flash ${size.flashAmount}, borrow ${size.borrowAmount}`)

      return {
        ...size,
        collateralAmount: pos.collateralAmount,
        debtAmount: pos.debtAmount,
        router: route.router,
        swapData: route.swapData,
        quotedOut: BigInt(route.chosen.amountOut),
        position: pos,
      }
}

/**
 * One quote round: ask every adapter at `flashAmount`, take the first that builds into calldata
 * the contract will accept. Also run once more after the signatures — a maker-settled route's
 * signed orders expire about a minute after the build, and three wallet prompts outlast that.
 */
export async function quoteAndSelect(p: {
  input: FlipInput
  chainId: number
  adapters: ReturnType<typeof getAdaptersForChain>
  allowedRouters: Set<string>
  flipper: Address
  flashAmount: bigint
  debt: bigint
  slipNum: bigint
}) {
  return selectRoute({
    candidates: await quoteAll(p.adapters, p.input, p.flashAmount, p.chainId, p.flipper),
    adapters: p.adapters,
    strategies: p.flipper,
    allowedRouters: p.allowedRouters,
    slippagePercent: p.input.slippagePercent,
    chainId: p.chainId,
    // The sale has to clear the debt it is retiring, or the leg reverts before it can supply
    // anything. Below that bar a route is not usable at any leverage.
    debt: p.debt,
    slipNum: p.slipNum,
    tokenIn: p.input.fromAsset.underlyingAsset,
    tokenOut: p.input.toAsset.underlyingAsset,
    simulate: simulateSwap,
  })
}

function sizingInput(input: FlipInput, pos: Position) {
  return {
    collateralAmount: pos.collateralAmount,
    debtAmount: pos.debtAmount,
    leverageBps: input.leverageBps,
    fromPriceUsd: pos.fromPriceUsd,
    toPriceUsd: pos.toPriceUsd,
    fromDecimals: pos.fromDecimals,
    toDecimals: pos.toDecimals,
    ltvBps: pos.ltvBps,
    liquidationThresholdBps: pos.liquidationThresholdBps,
    rateBufferBps: RATE_BUFFER_BPS,
    slippageBps: BigInt(Math.round(input.slippagePercent * 100)),
  }
}

/** Surfaces `sizeFlip`'s error union as a throw, so callers have one failure channel. */
function unwrapSize(r: ReturnType<typeof sizeFlip>): FlipSize {
  if (!r.ok) throw new FlipError(r.error)
  return r.size
}


/**
 * Every adapter that answers, best output first. An aggregator that refused is simply absent —
 * a refusal is not evidence about the pair, and `selectRoute` reports what it rejected and why.
 */
async function quoteAll(
  adapters: ReturnType<typeof getAdaptersForChain>,
  input: FlipInput,
  amountIn: bigint,
  chainId: number,
  /** The contract that will execute the route, and therefore who it must be quoted for. */
  flipper: Address,
): Promise<QuoteResponse[]> {
  const settled = await Promise.allSettled(
    adapters.map((a) =>
      // Every route each adapter offers, quoted for the Flipper that executes them.
      quoteField(a, {
        fromAsset: input.fromAsset,
        toAsset: input.toAsset,
        amountIn: amountIn.toString(),
        slippage: input.slippagePercent,
        chainId,
        caller: flipper,
      }),
    ),
  )
  return settled
    .flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
    .sort((a, b) => (BigInt(b.amountOut) > BigInt(a.amountOut) ? 1 : -1))
}
