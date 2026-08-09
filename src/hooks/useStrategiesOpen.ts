/**
 * Orchestrates opening a leveraged position: preview here, execute in the same hook.
 *
 * The preview is the seed → quote → re-size → maybe-re-quote → build loop. It exists because
 * sizeOpen needs a swap rate it cannot fetch, and the oracle's rate is mid-market — good enough
 * to size a first quote, not good enough to sign.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useChainId, useConnection, usePublicClient } from 'wagmi'
import type { Address, Hex } from 'viem'
import {
  getAllowedRouters,
  getPauseState,
  resolveMode,
  sizeOpen,
  type OpenMode,
  type SizeOpenError,
} from '../lib/strategies-sdk'
import {
  MAX_REFINE_ROUNDS,
  minOutFromBuild,
  needsRequote,
  rateFromOracle,
  rateFromQuote,
} from '../lib/openPlan'
import { getAdaptersForChain } from '../adapters'
import { getChainConfig } from '../config/chains'

export interface ReserveInfo {
  address: Address
  decimals: number
  priceUsd: bigint
  ltvBps: bigint
  liquidationThresholdBps: bigint
}

export interface OpenInput {
  contract: Address
  mode: OpenMode
  volatile: Address
  stable: Address
  marginAmount: bigint
  leverageBps: bigint
  slippageBps: bigint
  reserves: { collateral: ReserveInfo; debt: ReserveInfo }
}

export type PreviewErrorKind = SizeOpenError | 'paused' | 'no-route' | 'no-client' | 'quote-failed'

export interface PreviewError {
  kind: PreviewErrorKind
  message: string
}

export interface OpenPreview {
  collateral: Address
  debtAsset: Address
  marginAsset: Address
  flashAmount: bigint
  borrowAmount: bigint
  minOut: bigint
  expectedCollateral: bigint
  expectedDebt: bigint
  expectedLeverageBps: bigint
  expectedHealthFactorBps: bigint
  router: Address
  swapData: Hex
  /** Aggregator name, for display. */
  aggregator: string
}

const DEBOUNCE_MS = 400

export function useStrategiesOpen(input: OpenInput | null) {
  const client = usePublicClient()
  const chainId = useChainId()
  const { address: owner } = useConnection()

  const [preview, setPreview] = useState<OpenPreview | null>(null)
  const [previewError, setPreviewError] = useState<PreviewError | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)
  const [tick, setTick] = useState(0)

  /** Set while a signature is held, to stop the preview moving underneath it (Task 7). */
  const frozen = useRef(false)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!input || !client || frozen.current) return
    let cancelled = false

    const timer = setTimeout(async () => {
      setIsQuoting(true)
      setPreviewError(null)
      try {
        const { collateral, debtAsset, marginIn } = resolveMode({
          mode: input.mode, volatile: input.volatile, stable: input.stable,
        })

        const [{ paused }, routers] = await Promise.all([
          getPauseState(client, input.contract),
          getAllowedRouters(client, input.contract),
        ])
        if (cancelled) return
        if (paused) {
          setPreviewError({ kind: 'paused', message: 'Leverage is paused.' })
          return
        }

        const coll = input.reserves.collateral
        const debt = input.reserves.debt
        const sizeArgs = {
          marginIn,
          marginAmount: input.marginAmount,
          leverageBps: input.leverageBps,
          collateralPriceUsd: coll.priceUsd,
          debtPriceUsd: debt.priceUsd,
          collateralDecimals: coll.decimals,
          debtDecimals: debt.decimals,
          ltvBps: coll.ltvBps,
          liquidationThresholdBps: coll.liquidationThresholdBps,
          rateBufferBps: input.slippageBps,
          slippageBps: input.slippageBps,
        }

        // Seed off the oracle so the first quote is asked for a plausible size.
        let sized = sizeOpen({ ...sizeArgs, rateWad: rateFromOracle({
          collateralPriceUsd: coll.priceUsd, debtPriceUsd: debt.priceUsd,
          collateralDecimals: coll.decimals, debtDecimals: debt.decimals,
        }) })
        if (!sized.ok) {
          setPreviewError({ kind: sized.error, message: sized.error })
          return
        }

        const allowed = new Set(routers.map((r) => r.toLowerCase()))
        const adapters = getAdaptersForChain(getChainConfig(chainId)?.adapters ?? [])
          .filter((a) => a.supportsExecution)

        const fromAsset = { underlyingAsset: debtAsset, symbol: '', decimals: debt.decimals }
        const toAsset = { underlyingAsset: collateral, symbol: '', decimals: coll.decimals }
        const slippagePercent = Number(input.slippageBps) / 100

        let quote = null
        let adapter = null
        for (let round = 0; round < MAX_REFINE_ROUNDS; round++) {
          const amountIn = sized.size.borrowAmount.toString()
          const results = await Promise.all(
            adapters.map(async (a) => {
              try {
                const q = await a.getQuote(fromAsset, toAsset, amountIn, slippagePercent, chainId)
                return q ? { a, q } : null
              } catch {
                return null
              }
            }),
          )
          if (cancelled) return

          const best = results
            .filter((r): r is NonNullable<typeof r> => r !== null)
            .sort((x, y) => (BigInt(y.q.amountOut) > BigInt(x.q.amountOut) ? 1 : -1))[0]
          if (!best) break

          quote = best.q
          adapter = best.a

          const resized = sizeOpen({ ...sizeArgs, rateWad: rateFromQuote({
            amountIn: BigInt(quote.amountIn), amountOut: BigInt(quote.amountOut),
          }) })
          if (!resized.ok) {
            setPreviewError({ kind: resized.error, message: resized.error })
            return
          }

          const grew = needsRequote(BigInt(quote.amountIn), resized.size.borrowAmount)
          sized = resized
          if (!grew) break
        }

        if (!quote || !adapter) {
          setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
          return
        }

        const built = await adapter.buildTransaction(quote, slippagePercent, input.contract, chainId)
        if (cancelled) return
        if (!allowed.has(built.to.toLowerCase())) {
          setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
          return
        }

        setPreview({
          collateral, debtAsset,
          marginAsset: marginIn === 'collateral' ? collateral : debtAsset,
          flashAmount: sized.size.flashAmount,
          borrowAmount: sized.size.borrowAmount,
          minOut: minOutFromBuild({
            buildAmountOut: BigInt(built.amountOut ?? quote.amountOut),
            slippageBps: input.slippageBps,
            flashAmount: sized.size.flashAmount,
          }),
          expectedCollateral: sized.size.expectedCollateral,
          expectedDebt: sized.size.expectedDebt,
          expectedLeverageBps: sized.size.expectedLeverageBps,
          expectedHealthFactorBps: sized.size.expectedHealthFactorBps,
          router: built.to as Address,
          swapData: built.data as Hex,
          aggregator: adapter.name,
        })
      } catch {
        if (!cancelled) {
          setPreviewError({ kind: 'quote-failed', message: 'Could not price this position.' })
        }
      } finally {
        if (!cancelled) setIsQuoting(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [input, client, chainId, owner, tick])

  return { preview, previewError, isQuoting, refresh, frozen }
}
