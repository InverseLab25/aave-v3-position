import { useConnection, useReadContract, useReadContracts, useChainId } from 'wagmi'
import { formatUnits } from 'viem'
import uiPoolDataProviderAbi from '../config/uiPoolDataProviderAbi.json'
import { getChainConfig } from '../config/chains'

const aavePoolAbi = [
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'getUserAccountData',
    outputs: [
      { internalType: 'uint256', name: 'totalCollateralBase', type: 'uint256' },
      { internalType: 'uint256', name: 'totalDebtBase', type: 'uint256' },
      { internalType: 'uint256', name: 'availableBorrowsBase', type: 'uint256' },
      { internalType: 'uint256', name: 'currentLiquidationThreshold', type: 'uint256' },
      { internalType: 'uint256', name: 'ltv', type: 'uint256' },
      { internalType: 'uint256', name: 'healthFactor', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'getUserEMode',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint8', name: 'id', type: 'uint8' }],
    name: 'getEModeCategoryData',
    outputs: [
      {
        components: [
          { internalType: 'uint16', name: 'ltv', type: 'uint16' },
          { internalType: 'uint16', name: 'liquidationThreshold', type: 'uint16' },
          { internalType: 'uint16', name: 'liquidationBonus', type: 'uint16' },
          { internalType: 'address', name: 'priceSource', type: 'address' },
          { internalType: 'string', name: 'label', type: 'string' },
        ],
        internalType: 'struct DataTypes.EModeCategoryLegacy',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const SECONDS_PER_YEAR = 31536000
const RAY = 10n ** 27n

function calculateAPY(rateInRay: bigint) {
  const apr = Number(rateInRay) / Number(RAY)
  const apy = Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1
  return apy
}

import { useAaveHistoricalInterest } from './useAaveHistoricalInterest'

export interface UseAavePositionsOptions {
  /** View mode: fetch positions for this address instead of the connected wallet. */
  viewAddress?: `0x${string}`
  /** View mode: chain to read from. Falls back to the connected chain. */
  viewChainId?: number
}

export function useAavePositions(options?: UseAavePositionsOptions) {
  const { address: connectedAddress, isConnected: isWalletConnected } = useConnection()
  const connectedChainId = useChainId()
  const isViewMode = !!options?.viewAddress
  const targetAddress = (options?.viewAddress ?? connectedAddress) as `0x${string}` | undefined
  const chainId = options?.viewChainId ?? connectedChainId
  const chainConfig = getChainConfig(chainId)

  const hasAaveConfig = !!chainConfig?.aave

  const { netPrincipals, costBasis, isLoadingHistory } = useAaveHistoricalInterest(
    options?.viewAddress,
    options?.viewChainId
  )

  // 1. Fetch top-level account data for Health Factor and LTV
  const { data: accountData, isLoading: isAccountLoading } = useReadContract({
    chainId,
    address: chainConfig?.aave.poolAddress,
    abi: aavePoolAbi,
    functionName: 'getUserAccountData',
    args: targetAddress ? [targetAddress] : undefined,
    query: { enabled: !!targetAddress && hasAaveConfig }
  })

  // 1b. Fetch user E-Mode category
  const { data: userEModeData } = useReadContract({
    chainId,
    address: chainConfig?.aave.poolAddress,
    abi: aavePoolAbi,
    functionName: 'getUserEMode',
    args: targetAddress ? [targetAddress] : undefined,
    query: { enabled: !!targetAddress && hasAaveConfig }
  })

  const eModeCategoryId = userEModeData ? Number(userEModeData) : 0

  // 1c. Fetch E-Mode category details if active
  const { data: eModeCategoryData } = useReadContract({
    chainId,
    address: chainConfig?.aave.poolAddress,
    abi: aavePoolAbi,
    functionName: 'getEModeCategoryData',
    args: eModeCategoryId > 0 ? [eModeCategoryId] : undefined,
    query: { enabled: eModeCategoryId > 0 && hasAaveConfig }
  })

  // 2. Fetch detailed asset breakdown
  const { data: uiData, isLoading: isUiLoading } = useReadContracts({
    contracts: [
      {
        chainId,
        address: chainConfig?.aave.uiPoolDataProvider as `0x${string}`,
        abi: uiPoolDataProviderAbi,
        functionName: 'getReservesData',
        args: [chainConfig?.aave.poolAddressesProvider]
      },
      {
        chainId,
        address: chainConfig?.aave.uiPoolDataProvider as `0x${string}`,
        abi: uiPoolDataProviderAbi,
        functionName: 'getUserReservesData',
        args: targetAddress ? [chainConfig?.aave.poolAddressesProvider, targetAddress] : undefined
      }
    ],
    query: { enabled: !!targetAddress && hasAaveConfig }
  })

  // In view mode, "isConnected" reflects whether we have a target address to view.
  // Existing consumers (e.g., AavePosition) use this to decide whether to render.
  const isConnected = isViewMode ? !!targetAddress : isWalletConnected

  const emptyResult = {
    isConnected,
    isViewMode,
    viewedAddress: targetAddress ?? null,
    chainId,
    chainName: chainConfig?.name ?? 'Unknown',
    isUnsupportedChain: !hasAaveConfig,
    isLoading: isAccountLoading || isUiLoading || isLoadingHistory,
    collateralUsd: 0,
    debtUsd: 0,
    availableBorrowsUsd: 0,
    ltvPercent: 0,
    liquidationThreshold: 0,
    formattedHealthFactor: '0',
    netApy: 0,
    totalInterestEarnedUsd: 0,
    totalInterestPaidUsd: 0,
    totalPositionPnlUsd: 0,
    eModeCategoryId: 0,
    isEModeEnabled: false,
    eModeLabel: 'Disabled',
    eModeLtv: 0,
    eModeLiquidationThreshold: 0,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    suppliedAssets: [] as any[],
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    borrowedAssets: [] as any[],
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    availableReserves: [] as any[]
  }

  if (!targetAddress || !hasAaveConfig || !accountData || !uiData || !uiData[0].result || !uiData[1].result) {
    return emptyResult
  }

  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  ] = accountData as any

  const collateralUsd = Number(formatUnits(totalCollateralBase, 8))
  const debtUsd = Number(formatUnits(totalDebtBase, 8))
  const availableBorrowsUsd = Number(formatUnits(availableBorrowsBase, 8))
  const ltvPercent = Number(ltv) / 100
  const liquidationThreshold = Number(currentLiquidationThreshold) / 10000

  const MAX_UINT256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
  const formattedHealthFactor = healthFactor === MAX_UINT256 ? '∞' : formatUnits(healthFactor, 18)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalReserves = (uiData[0].result as any)[0]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userReserves = (uiData[1].result as any)[0]

  let totalEarningsUsd = 0
  let totalCostsUsd = 0

  let totalInterestEarnedUsd = 0
  let totalInterestPaidUsd = 0
  let totalPositionPnlUsd = 0

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const suppliedAssets: any[] = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const borrowedAssets: any[] = []

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  const availableReserves = globalReserves.map((reserve: any) => ({
    symbol: reserve.symbol,
    underlyingAsset: reserve.underlyingAsset,
    decimals: Number(reserve.decimals),
    priceInUsd: (Number(reserve.priceInMarketReferenceCurrency) / 1e8).toString(),
    apy: calculateAPY(reserve.liquidityRate) * 100,
    borrowApy: calculateAPY(reserve.variableBorrowRate) * 100,
    variableDebtTokenAddress: reserve.variableDebtTokenAddress,
    aTokenAddress: reserve.aTokenAddress,
    liquidationThreshold: Number(reserve.reserveLiquidationThreshold) / 10000,
  }))


// eslint-disable-next-line @typescript-eslint/no-explicit-any
  userReserves.forEach((uRes: any) => {
    if (uRes.scaledATokenBalance === 0n && uRes.scaledVariableDebt === 0n) return;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reserve = globalReserves.find((r: any) => r.underlyingAsset === uRes.underlyingAsset)
    if (!reserve) return;

    const priceUsd = Number(reserve.priceInMarketReferenceCurrency) / 1e8
    const assetAddress = reserve.underlyingAsset.toLowerCase()

    // Calculate Supply
    if (uRes.scaledATokenBalance > 0n) {
      const balanceAmount = (BigInt(uRes.scaledATokenBalance) * BigInt(reserve.liquidityIndex)) / RAY
      const formattedAmount = Number(formatUnits(balanceAmount, Number(reserve.decimals)))
      const valueUsd = formattedAmount * priceUsd
      const apy = calculateAPY(reserve.liquidityRate)

      totalEarningsUsd += valueUsd * apy

      const netPrincipalTokens = netPrincipals.supply[assetAddress] || 0
      // Due to potential minor precision issues or timing, we enforce a floor of 0
      const interestEarnedTokens = Math.max(0, formattedAmount - netPrincipalTokens)
      const interestEarnedUsd = interestEarnedTokens * priceUsd

      totalInterestEarnedUsd += interestEarnedUsd

      const basis = costBasis.supply[assetAddress]
      const avgEntryPriceUsd = basis?.avgEntryPriceUsd ?? 0
      const realizedPnlUsd = basis?.realizedPnlUsd ?? 0
      // Lender gains when the collateral appreciates above the avg entry price.
      const unrealizedPriceGainUsd = avgEntryPriceUsd > 0
        ? (priceUsd - avgEntryPriceUsd) * netPrincipalTokens
        : 0
      const positionPnlUsd = realizedPnlUsd + unrealizedPriceGainUsd + interestEarnedUsd
      totalPositionPnlUsd += positionPnlUsd

      suppliedAssets.push({
        symbol: reserve.symbol,
        underlyingAsset: reserve.underlyingAsset,
        decimals: Number(reserve.decimals),
        amount: formattedAmount,
        valueUsd,
        priceInUsd: priceUsd.toString(),
        apy: apy * 100,
        aTokenAddress: reserve.aTokenAddress,
        usageAsCollateralEnabledOnUser: uRes.usageAsCollateralEnabledOnUser,
        interestEarnedTokens,
        interestEarnedUsd,
        positionPnl: {
          avgEntryPriceUsd,
          realizedPnlUsd,
          unrealizedPriceGainUsd,
          interestUsd: interestEarnedUsd,
          totalPnlUsd: positionPnlUsd
        }
      })
    }

    // Calculate Borrow
    if (uRes.scaledVariableDebt > 0n) {
      const balanceAmount = (BigInt(uRes.scaledVariableDebt) * BigInt(reserve.variableBorrowIndex)) / RAY
      const formattedAmount = Number(formatUnits(balanceAmount, Number(reserve.decimals)))
      const valueUsd = formattedAmount * priceUsd
      const apy = calculateAPY(reserve.variableBorrowRate)

      totalCostsUsd += valueUsd * apy

      const netPrincipalTokens = netPrincipals.borrow[assetAddress] || 0
      const interestPaidTokens = Math.max(0, formattedAmount - netPrincipalTokens)
      const interestPaidUsd = interestPaidTokens * priceUsd

      totalInterestPaidUsd += interestPaidUsd

      const basis = costBasis.borrow[assetAddress]
      const avgEntryPriceUsd = basis?.avgEntryPriceUsd ?? 0
      const realizedPnlUsd = basis?.realizedPnlUsd ?? 0
      // Borrower gains when the borrowed asset DEPRECIATES: debt cheaper to repay in USD.
      const unrealizedPriceGainUsd = avgEntryPriceUsd > 0
        ? (avgEntryPriceUsd - priceUsd) * netPrincipalTokens
        : 0
      const positionPnlUsd = realizedPnlUsd + unrealizedPriceGainUsd - interestPaidUsd
      totalPositionPnlUsd += positionPnlUsd

      borrowedAssets.push({
        symbol: reserve.symbol,
        underlyingAsset: reserve.underlyingAsset,
        decimals: Number(reserve.decimals),
        amount: formattedAmount,
        valueUsd,
        priceInUsd: priceUsd.toString(),
        apy: apy * 100,
        variableDebtTokenAddress: reserve.variableDebtTokenAddress,
        interestPaidTokens,
        interestPaidUsd,
        positionPnl: {
          avgEntryPriceUsd,
          realizedPnlUsd,
          unrealizedPriceGainUsd,
          interestUsd: -interestPaidUsd,
          totalPnlUsd: positionPnlUsd
        }
      })
    }
  })

  const netWorthUsd = collateralUsd - debtUsd;
  const netApy = netWorthUsd > 0
    ? ((totalEarningsUsd - totalCostsUsd) / netWorthUsd) * 100
    : 0

  return {
    isConnected,
    isViewMode,
    viewedAddress: targetAddress,
    chainId,
    chainName: chainConfig?.name ?? 'Unknown',
    isUnsupportedChain: false,
    isLoading: isAccountLoading || isUiLoading || isLoadingHistory,
    collateralUsd,
    debtUsd,
    availableBorrowsUsd,
    ltvPercent,
    liquidationThreshold,
    formattedHealthFactor,
    netApy,
    totalInterestEarnedUsd,
    totalInterestPaidUsd,
    totalPositionPnlUsd,
    eModeCategoryId,
    isEModeEnabled: eModeCategoryId > 0,
    eModeLabel: (eModeCategoryData as any)?.label || (eModeCategoryId === 1 ? 'ETH Correlated' : eModeCategoryId === 2 ? 'Stablecoins' : eModeCategoryId > 0 ? `Category ${eModeCategoryId}` : 'Disabled'),
    eModeLtv: (eModeCategoryData as any)?.ltv ? Number((eModeCategoryData as any).ltv) / 100 : 0,
    eModeLiquidationThreshold: (eModeCategoryData as any)?.liquidationThreshold ? Number((eModeCategoryData as any).liquidationThreshold) / 10000 : 0,
    suppliedAssets,
    borrowedAssets,
    availableReserves
  }
}
