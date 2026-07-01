import { gql, useQuery } from '@apollo/client'
import { useAccount, useChainId } from 'wagmi'
import { getChainConfig } from '../config/chains'

const GET_USER_TRANSACTIONS = gql`
  query GetUserTransactions($user: EvmAddress!, $chainId: ChainId!, $market: EvmAddress!) {
    userTransactionHistory(request: { user: $user, chainId: $chainId, market: $market }) {
      items {
        __typename
        ... on UserSupplyTransaction {
          timestamp
          amount { amount { value } usd usdPerToken }
          reserve { underlyingToken { address } }
        }
        ... on UserWithdrawTransaction {
          timestamp
          amount { amount { value } usd usdPerToken }
          reserve { underlyingToken { address } }
        }
        ... on UserBorrowTransaction {
          timestamp
          amount { amount { value } usd usdPerToken }
          reserve { underlyingToken { address } }
        }
        ... on UserRepayTransaction {
          timestamp
          amount { amount { value } usd usdPerToken }
          reserve { underlyingToken { address } }
        }
        ... on UserLiquidationCallTransaction {
          timestamp
          collateral {
            amount { amount { value } usd usdPerToken }
            reserve { underlyingToken { address } }
          }
          debtRepaid {
            amount { amount { value } usd usdPerToken }
            reserve { underlyingToken { address } }
          }
        }
      }
    }
  }
`

export type CostBasis = {
  /** Weighted-average USD entry price of the tokens still held/owed. */
  avgEntryPriceUsd: number
  /** Realized USD P&L from withdraws/repays/liquidations processed against the running basis. */
  realizedPnlUsd: number
}

type Accumulator = {
  totalUnits: number
  totalCostUsd: number
  realizedPnlUsd: number
}

const newAcc = (): Accumulator => ({ totalUnits: 0, totalCostUsd: 0, realizedPnlUsd: 0 })

/**
 * Increase basis: user acquires more of an asset (supply for lenders, borrow for borrowers).
 * Weighted-average cost — dilutes the existing avg entry price by the new amount × its execution price.
 */
function addEntry(acc: Accumulator, units: number, usdPerToken: number) {
  if (units <= 0) return
  acc.totalUnits += units
  // Skip cost contribution when the indexer returns 0 (unknown / very old tx) —
  // otherwise the avg entry price collapses to 0 and P&L blows up.
  if (usdPerToken > 0) {
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
  const avgEntry = acc.totalCostUsd / acc.totalUnits
  if (usdPerToken > 0 && avgEntry > 0) {
    const delta = direction === 'sell' ? usdPerToken - avgEntry : avgEntry - usdPerToken
    acc.realizedPnlUsd += Math.min(units, acc.totalUnits) * delta
  }
  const remainingUnits = Math.max(0, acc.totalUnits - units)
  acc.totalCostUsd = remainingUnits * avgEntry
  acc.totalUnits = remainingUnits
}

export function useAaveHistoricalInterest(userAddress?: string, chainIdOverride?: number) {
  const { address: connectedAddress } = useAccount()
  const connectedChainId = useChainId()
  const chainId = chainIdOverride ?? connectedChainId
  const chainConfig = getChainConfig(chainId)
  const hasAaveConfig = !!chainConfig?.aave

  const targetAddress = userAddress || connectedAddress

  const { data, loading, error } = useQuery(GET_USER_TRANSACTIONS, {
    variables: {
      user: targetAddress,
      chainId: chainId,
      market: chainConfig?.aave.poolAddress
    },
    skip: !targetAddress || !hasAaveConfig,
    fetchPolicy: 'cache-first'
  })

  const supplyAcc: Record<string, Accumulator> = {}
  const borrowAcc: Record<string, Accumulator> = {}

  if (data?.userTransactionHistory?.items) {
    for (const tx of data.userTransactionHistory.items) {
      switch (tx.__typename) {
        case 'UserSupplyTransaction': {
          const asset = tx.reserve.underlyingToken.address.toLowerCase()
          const acc = (supplyAcc[asset] ??= newAcc())
          addEntry(acc, Number(tx.amount.amount.value), Number(tx.amount.usdPerToken || 0))
          break
        }
        case 'UserWithdrawTransaction': {
          const asset = tx.reserve.underlyingToken.address.toLowerCase()
          const acc = (supplyAcc[asset] ??= newAcc())
          realizeExit(acc, Number(tx.amount.amount.value), Number(tx.amount.usdPerToken || 0), 'sell')
          break
        }
        case 'UserBorrowTransaction': {
          const asset = tx.reserve.underlyingToken.address.toLowerCase()
          const acc = (borrowAcc[asset] ??= newAcc())
          addEntry(acc, Number(tx.amount.amount.value), Number(tx.amount.usdPerToken || 0))
          break
        }
        case 'UserRepayTransaction': {
          const asset = tx.reserve.underlyingToken.address.toLowerCase()
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
      avgEntryPriceUsd: acc.totalUnits > 0 ? acc.totalCostUsd / acc.totalUnits : 0,
      realizedPnlUsd: acc.realizedPnlUsd
    }
  }
  for (const [asset, acc] of Object.entries(borrowAcc)) {
    netPrincipals.borrow[asset] = acc.totalUnits
    costBasis.borrow[asset] = {
      avgEntryPriceUsd: acc.totalUnits > 0 ? acc.totalCostUsd / acc.totalUnits : 0,
      realizedPnlUsd: acc.realizedPnlUsd
    }
  }

  return {
    netPrincipals,
    costBasis,
    isLoadingHistory: loading,
    errorHistory: error
  }
}
