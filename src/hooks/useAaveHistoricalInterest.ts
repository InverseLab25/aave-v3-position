import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useConnection, useChainId } from 'wagmi'
import { getChainConfig } from '../config/chains'
import { browserStorage } from '../lib/delegationCache'
import {
  readHistorySnapshot,
  userHistoryQuery,
  type HistoryItem,
} from '../lib/aaveUserHistory'

export type CostBasis = {
  /** Weighted-average USD entry price of the tokens still held/owed. */
  avgEntryPriceUsd: number
  /** Realized USD P&L from withdraws/repays/liquidations processed against the running basis. */
  realizedPnlUsd: number
}

type Accumulator = {
  /** Every unit acquired, priced or not. This is the net principal. */
  totalUnits: number
  /**
   * Units whose execution price the indexer actually reported — the denominator for the average
   * entry price, and deliberately NOT `totalUnits`.
   *
   * Kept separate because the two questions have different answers. An entry the indexer prices
   * at 0 (very old, or unknown) still moved tokens, so it belongs in the principal; but folding
   * it into the average at a cost of nothing drags that average toward zero, which inflates
   * apparent unrealized gain. Excluding it from `totalUnits` instead would understate the
   * principal and overstate interest earned. Only splitting them gets both right.
   */
  pricedUnits: number
  totalCostUsd: number
  realizedPnlUsd: number
}

const newAcc = (): Accumulator => ({
  totalUnits: 0,
  pricedUnits: 0,
  totalCostUsd: 0,
  realizedPnlUsd: 0,
})

/** Weighted-average USD entry price over the units we have a price for. */
const avgEntryOf = (acc: Accumulator): number =>
  acc.pricedUnits > 0 ? acc.totalCostUsd / acc.pricedUnits : 0

/**
 * Increase basis: user acquires more of an asset (supply for lenders, borrow for borrowers).
 * Weighted-average cost — dilutes the existing avg entry price by the new amount × its execution price.
 */
function addEntry(acc: Accumulator, units: number, usdPerToken: number) {
  if (units <= 0) return
  acc.totalUnits += units
  // An entry the indexer could not price contributes to the principal but not to the average:
  // it goes into `totalUnits` only, leaving `pricedUnits` and the cost untouched so the average
  // stays a true average of the entries we can actually see. See {@link Accumulator}.
  if (usdPerToken > 0) {
    acc.pricedUnits += units
    acc.totalCostUsd += units * usdPerToken
  }
}

/**
 * Decrease basis and realize P&L. `direction`:
 *   'sell'  — lender withdraws or is liquidated: gain = (exitPrice - avgEntry) × units
 *   'cover' — borrower repays or is liquidated:  gain = (avgEntry - exitPrice) × units
 */
function realizeExit(
  acc: Accumulator,
  units: number,
  usdPerToken: number,
  direction: 'sell' | 'cover'
) {
  if (units <= 0 || acc.totalUnits <= 0) return
  const avgEntry = avgEntryOf(acc)
  const consumed = Math.min(units, acc.totalUnits)
  if (usdPerToken > 0 && avgEntry > 0) {
    const delta = direction === 'sell' ? usdPerToken - avgEntry : avgEntry - usdPerToken
    acc.realizedPnlUsd += consumed * delta
  }
  // Scale the priced basis by the share of the position that remains, so the average entry
  // price is unchanged by an exit — which is what weighted-average cost means. Scaling
  // `pricedUnits` and `totalCostUsd` by the same factor is what preserves it.
  const remainingShare = (acc.totalUnits - consumed) / acc.totalUnits
  acc.totalUnits -= consumed
  acc.pricedUnits *= remainingShare
  acc.totalCostUsd *= remainingShare
}

export function useAaveHistoricalInterest(userAddress?: string, chainIdOverride?: number) {
  const { address: connectedAddress } = useConnection()
  const connectedChainId = useChainId()
  const chainId = chainIdOverride ?? connectedChainId
  const chainConfig = getChainConfig(chainId)
  const hasAaveConfig = !!chainConfig?.aave

  const targetAddress = userAddress || connectedAddress
  const market = chainConfig?.aave.poolAddress

  const storage = useMemo(() => browserStorage(), [])

  /** Last load's rows, so the profit column has something to show on the first frame. */
  const snapshot = useMemo(
    () => readHistorySnapshot(storage, targetAddress, chainId, market),
    [storage, targetAddress, chainId, market],
  )

  const { data, isLoading, error } = useQuery({
    ...userHistoryQuery(storage, targetAddress, chainId, market),
    enabled: !!targetAddress && hasAaveConfig,
    initialData: snapshot?.items,
    /**
     * Stamped at the epoch, NOT at when the snapshot was written.
     *
     * A seed is a first frame, never an answer, so it has to be stale on arrival or react-query
     * has no reason to go and ask. Handing over the real write time looks more honest and is the
     * bug: `staleTime` is five minutes, so anyone who reloaded within five minutes of their last
     * load would be shown a basis off the disk and no request would be made to check it — and a
     * basis that stale prices a position that may have been closed since.
     *
     * Costing nothing extra is what makes this safe: with no snapshot the query fetches on mount
     * anyway. The only difference is what is on screen while it does. Once the real rows land they
     * carry a real timestamp, and the five minutes applies normally from there.
     */
    initialDataUpdatedAt: 0,
  })

  // Replaying the whole transaction history on every render is pure waste: the result is a
  // function of `data` alone, and this hook feeds useAavePositions, which feeds eight
  // components. Without this memo every one of them re-derived cost basis on every render,
  // and the fresh object identities invalidated every downstream useMemo.
  const { netPrincipals, costBasis } = useMemo(() => {
  const supplyAcc: Record<string, Accumulator> = {}
  const borrowAcc: Record<string, Accumulator> = {}

  const items: HistoryItem[] | undefined = data
  if (items) {
    for (const tx of items) {
      switch (tx.__typename) {
        case 'UserSupplyTransaction': {
          const asset = tx.reserve?.underlyingToken.address.toLowerCase()
          if (!asset || !tx.amount) break
          const acc = (supplyAcc[asset] ??= newAcc())
          addEntry(acc, Number(tx.amount.amount.value), Number(tx.amount.usdPerToken || 0))
          break
        }
        case 'UserWithdrawTransaction': {
          const asset = tx.reserve?.underlyingToken.address.toLowerCase()
          if (!asset || !tx.amount) break
          const acc = (supplyAcc[asset] ??= newAcc())
          realizeExit(acc, Number(tx.amount.amount.value), Number(tx.amount.usdPerToken || 0), 'sell')
          break
        }
        case 'UserBorrowTransaction': {
          const asset = tx.reserve?.underlyingToken.address.toLowerCase()
          if (!asset || !tx.amount) break
          const acc = (borrowAcc[asset] ??= newAcc())
          addEntry(acc, Number(tx.amount.amount.value), Number(tx.amount.usdPerToken || 0))
          break
        }
        case 'UserRepayTransaction': {
          const asset = tx.reserve?.underlyingToken.address.toLowerCase()
          if (!asset || !tx.amount) break
          const acc = (borrowAcc[asset] ??= newAcc())
          realizeExit(acc, Number(tx.amount.amount.value), Number(tx.amount.usdPerToken || 0), 'cover')
          break
        }
        case 'UserLiquidationCallTransaction': {
          if (tx.collateral?.amount) {
            const asset = tx.collateral.reserve.underlyingToken.address.toLowerCase()
            const acc = (supplyAcc[asset] ??= newAcc())
            realizeExit(
              acc,
              Number(tx.collateral.amount.amount.value),
              Number(tx.collateral.amount.usdPerToken || 0),
              'sell'
            )
          }
          if (tx.debtRepaid?.amount) {
            const asset = tx.debtRepaid.reserve.underlyingToken.address.toLowerCase()
            const acc = (borrowAcc[asset] ??= newAcc())
            realizeExit(
              acc,
              Number(tx.debtRepaid.amount.amount.value),
              Number(tx.debtRepaid.amount.usdPerToken || 0),
              'cover'
            )
          }
          break
        }
      }
    }
  }

  const netPrincipals = {
    supply: {} as Record<string, number>,
    borrow: {} as Record<string, number>
  }
  const costBasis = {
    supply: {} as Record<string, CostBasis>,
    borrow: {} as Record<string, CostBasis>
  }

  for (const [asset, acc] of Object.entries(supplyAcc)) {
    netPrincipals.supply[asset] = acc.totalUnits
    costBasis.supply[asset] = {
      avgEntryPriceUsd: avgEntryOf(acc),
      realizedPnlUsd: acc.realizedPnlUsd
    }
  }
  for (const [asset, acc] of Object.entries(borrowAcc)) {
    netPrincipals.borrow[asset] = acc.totalUnits
    // Borrow P&L reflects only the currently-open position: the avg entry is the
    // weighted-average price of the open borrow, and realized P&L from repaid (closed)
    // amounts is intentionally excluded.
    costBasis.borrow[asset] = {
      avgEntryPriceUsd: avgEntryOf(acc),
      realizedPnlUsd: 0
    }
  }

  return { netPrincipals, costBasis }
  }, [data])

  return {
    netPrincipals,
    costBasis,
    isLoadingHistory: isLoading,
    errorHistory: error
  }
}
