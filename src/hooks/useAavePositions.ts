import { useMemo } from 'react'
import { useConnection, useReadContract, useReadContracts, useChainId } from 'wagmi'
import { formatUnits, maxUint256 } from 'viem'
import { uiPoolDataProviderAbi } from '../config/uiPoolDataProviderAbi'
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
    // The INDEX into this list is the reserve id the eMode bitmap below is keyed by.
    inputs: [],
    name: 'getReservesList',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // Aave v3.2+ replaced the per-reserve eMode category id with per-category bitmaps. Verified
    // against the mainnet Pool: category 1 returns 0b…1011, whose bits 0 and 1 are WETH and
    // wstETH (in) and bit 2 is WBTC (out).
    inputs: [{ internalType: 'uint8', name: 'id', type: 'uint8' }],
    name: 'getEModeCategoryCollateralBitmap',
    outputs: [{ internalType: 'uint128', name: '', type: 'uint128' }],
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

/** Profit/loss breakdown attached to every supplied and borrowed row. */
interface PositionPnl {
  avgEntryPriceUsd: number
  realizedPnlUsd: number
  unrealizedPriceGainUsd: number
  interestUsd: number
  totalPnlUsd: number
}

export interface SuppliedAsset {
  symbol: string
  underlyingAsset: `0x${string}`
  decimals: number
  amount: number
  /** Raw aToken balance. `amount` is a lossy double — size MAX buttons from this. */
  amountRaw: bigint
  valueUsd: number
  priceInUsd: string
  apy: number
  aTokenAddress: `0x${string}`
  usageAsCollateralEnabledOnUser: boolean
  liquidationThreshold: number
  interestEarnedTokens: number
  interestEarnedUsd: number
  positionPnl: PositionPnl
}

export interface BorrowedAsset {
  symbol: string
  underlyingAsset: `0x${string}`
  decimals: number
  amount: number
  /** Raw variable-debt balance — see the note on the supplied-asset counterpart. */
  amountRaw: bigint
  valueUsd: number
  priceInUsd: string
  apy: number
  variableDebtTokenAddress: `0x${string}`
  interestPaidTokens: number
  interestPaidUsd: number
  positionPnl: PositionPnl
}

export interface AvailableReserve {
  symbol: string
  underlyingAsset: `0x${string}`
  decimals: number
  priceInUsd: string
  apy: number
  borrowApy: number
  variableDebtTokenAddress: `0x${string}`
  aTokenAddress: `0x${string}`
  liquidationThreshold: number
  /**
   * Reserve config at native on-chain precision, for the sizing SDK.
   *
   * The fields above are lossy Numbers for display; strategies-sdk's sizeOpen needs exact
   * bigints, and a float round-trip through a price is enough to misplace a wei.
   */
  raw: {
    ltvBps: bigint
    liquidationThresholdBps: bigint
    /** USD price on Aave's 8-decimal market-reference scale. */
    priceUsd: bigint
    decimals: number
    /** Reserve-level collateral flag. False means Aave accepts no collateral here at all. */
    usageAsCollateralEnabled: boolean
    /**
     * Non-zero puts the reserve in isolation mode, which is what stops a supply made ON BEHALF
     * of a user from being auto-enabled as collateral — see `collateralEnablement`.
     */
    debtCeiling: bigint
  }
}

/**
 * A reserve as offered in the supply/borrow pickers: every on-chain reserve, plus one
 * synthetic entry for the chain native currency. That entry reuses the wrapped reserve
 * but carries the string sentinel `native` in place of an address, so balance reads and
 * gateway routing can branch on it.
 */
export type ReserveOption = Omit<AvailableReserve, "underlyingAsset"> & {
  underlyingAsset: `0x${string}` | "native"
}

interface UseAavePositionsOptions {
  /** View mode: fetch positions for this address instead of the connected wallet. */
  viewAddress?: `0x${string}`
  /** View mode: chain to read from. Falls back to the connected chain. */
  viewChainId?: number
}

// Frozen module-scope singletons: the not-connected / loading branch returned fresh []
// literals on every render, which invalidated every downstream useMemo keyed on them.
const EMPTY_SUPPLIED: SuppliedAsset[] = []
const EMPTY_BORROWED: BorrowedAsset[] = []
const EMPTY_RESERVES: AvailableReserve[] = []
const EMPTY_EMODE_EXCLUDED: Record<string, boolean> = {}
/** Shared so the empty result keeps a stable identity across renders, like its siblings above. */
const EMPTY_COLLATERAL_FLAGS: Record<
  string,
  { scaledATokenBalance: bigint; enabledOnUser: boolean }
> = {}

export function useAavePositions(options?: UseAavePositionsOptions) {
  const { address: connectedAddress, isConnected: isWalletConnected } = useConnection()
  const connectedChainId = useChainId()
  const isViewMode = !!options?.viewAddress
  const targetAddress = (options?.viewAddress ?? connectedAddress) as `0x${string}` | undefined
  const chainId = options?.viewChainId ?? connectedChainId
  const chainConfig = getChainConfig(chainId)

  const hasAaveConfig = !!chainConfig?.aave

  const { netPrincipals, costBasis } = useAaveHistoricalInterest(
    options?.viewAddress,
    options?.viewChainId
  )

  // 1. Fetch top-level account data for Health Factor and LTV
  const { data: accountData, isLoading: isAccountLoading, error: accountError } = useReadContract({
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

  // 1c. Fetch E-Mode category details if active. `aavePoolAbi` is an `as const` literal,
  // so viem infers the returned struct — no cast needed.
  const { data: eModeCategory } = useReadContract({
    chainId,
    address: chainConfig?.aave.poolAddress,
    abi: aavePoolAbi,
    functionName: 'getEModeCategoryData',
    args: eModeCategoryId > 0 ? [eModeCategoryId] : undefined,
    query: { enabled: eModeCategoryId > 0 && hasAaveConfig }
  })

  // 1d. The reserve list, whose INDEX is the reserve id the eMode bitmap below is keyed by.
  // Verified against mainnet: getReservesList()[0] is WETH and bit 0 of category 1's collateral
  // bitmap is set, [2] is WBTC and bit 2 is clear.
  const { data: reservesList } = useReadContract({
    chainId,
    address: chainConfig?.aave.poolAddress,
    abi: aavePoolAbi,
    functionName: 'getReservesList',
    query: { enabled: hasAaveConfig }
  })

  // 1e. Which reserves the user's eMode category will actually count as collateral.
  //
  // Needed because eMode does not merely re-rate a reserve, it can zero it: an out-of-category
  // collateral is assigned ltv = liquidationThreshold = 0 and then SKIPPED entirely by
  // `calculateUserAccountData`. Supplying it therefore adds no borrowing power even though the
  // user's collateral flag for it is set — which is invisible without this read.
  const { data: eModeCollateralBitmap } = useReadContract({
    chainId,
    address: chainConfig?.aave.poolAddress,
    abi: aavePoolAbi,
    functionName: 'getEModeCategoryCollateralBitmap',
    args: eModeCategoryId > 0 ? [eModeCategoryId] : undefined,
    query: { enabled: eModeCategoryId > 0 && hasAaveConfig }
  })

  /**
   * Reserves the user's eMode category excludes from collateral, lowercased.
   *
   * Empty when eMode is off, and empty while either read is in flight — an unresolved read must
   * read as "not excluded" so a slow RPC cannot block the form. `collateralEnablement` treats
   * this as one input among several, so a false negative here degrades to today's behaviour.
   */
  const eModeExcludedReserves: Record<string, boolean> = {}
  if (eModeCategoryId > 0 && reservesList && eModeCollateralBitmap !== undefined) {
    reservesList.forEach((asset, i) => {
      if (((eModeCollateralBitmap >> BigInt(i)) & 1n) === 0n) {
        eModeExcludedReserves[asset.toLowerCase()] = true
      }
    })
  }

  // Narrowed once so the typed ABI's `args` tuples accept it: both reads below require a
  // defined provider address, which `hasAaveConfig` already guarantees at runtime but
  // TypeScript cannot see through `chainConfig?.aave`.
  const addressesProvider = chainConfig?.aave.poolAddressesProvider

  // 2. Fetch detailed asset breakdown
  const { data: uiData, isLoading: isUiLoading, error: uiError } = useReadContracts({
    contracts: [
      {
        chainId,
        address: chainConfig?.aave.uiPoolDataProvider as `0x${string}`,
        abi: uiPoolDataProviderAbi,
        functionName: 'getReservesData',
        args: addressesProvider ? [addressesProvider] : undefined
      },
      {
        chainId,
        address: chainConfig?.aave.uiPoolDataProvider as `0x${string}`,
        abi: uiPoolDataProviderAbi,
        functionName: 'getUserReservesData',
        args: addressesProvider && targetAddress ? [addressesProvider, targetAddress] : undefined
      }
    ],
    query: { enabled: !!targetAddress && hasAaveConfig }
  })

  // In view mode, "isConnected" reflects whether we have a target address to view.
  // Existing consumers (e.g., AavePosition) use this to decide whether to render.
  const isConnected = isViewMode ? !!targetAddress : isWalletConnected

  /**
   * A read FAILED, as distinct from an account having nothing in it.
   *
   * `useReadContracts` reports a per-call failure by leaving `result` undefined, which the
   * derivation below cannot tell apart from an empty position — so without this the whole hook
   * returns zeroed totals and an empty asset list, and the UI shows "start your position" to
   * someone who has one. That is not only cosmetic: `collateralBase`/`debtBase` feed
   * `maxSupplyAmount`, so a user carrying real debt would be offered a supply ceiling computed
   * for an empty account, and a health factor that ignores what they already owe. Aave rejects
   * the borrow on-chain, so it fails closed — but only after they have paid for the attempt.
   */
  const hasReadError = Boolean(
    accountError || uiError || uiData?.some((r) => r.status === 'failure'),
  )

  const emptyResult = {
    isConnected,
    isViewMode,
    viewedAddress: targetAddress ?? null,
    chainId,
    chainName: chainConfig?.name ?? 'Unknown',
    isUnsupportedChain: !hasAaveConfig,
    // NOT `|| isLoadingHistory`. Cost basis comes from Aave's hosted indexer, and everything the
    // position itself reports — collateral, debt, health factor — is already in hand from the
    // chain. Folding that call in here let a slow third party blank the whole panel behind
    // "Loading Aave Position...", with nothing on screen to say why. The basis fills in when it
    // arrives, the way the history list already handles its own sync.
    isLoading: isAccountLoading || isUiLoading,
    hasReadError,
    collateralUsd: 0,
    debtUsd: 0,
    collateralBase: 0n,
    debtBase: 0n,
    ltvBps: 0n,
    liquidationThresholdBps: 0n,
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
    eModeExcludedReserves: EMPTY_EMODE_EXCLUDED,
    suppliedAssets: EMPTY_SUPPLIED,
    borrowedAssets: EMPTY_BORROWED,
    availableReserves: EMPTY_RESERVES,
    collateralFlags: EMPTY_COLLATERAL_FLAGS,
    hasAnyCollateralEnabled: false
  }

  // ~200 lines of reserve parsing, interest and P&L maths. It is a pure function of the
  // contract reads below, but it used to run on every render of every one of the eight
  // components that call this hook. Memoising also stabilises suppliedAssets/borrowedAssets
  // identity, which is what previously forced consumers into latest-ref workarounds.
  const derived = useMemo(() => {
  if (!targetAddress || !hasAaveConfig || !accountData || !uiData || !uiData[0].result || !uiData[1].result) {
    return null
  }

  const [
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold,
    ltv,
    healthFactor
  ] = accountData

  const collateralUsd = Number(formatUnits(totalCollateralBase, 8))
  const debtUsd = Number(formatUnits(totalDebtBase, 8))
  const availableBorrowsUsd = Number(formatUnits(availableBorrowsBase, 8))
  const ltvPercent = Number(ltv) / 100
  const liquidationThreshold = Number(currentLiquidationThreshold) / 10000

  // Aave returns uint256 max when there is no debt to be liquidated against.
  const formattedHealthFactor = healthFactor === maxUint256 ? '∞' : formatUnits(healthFactor, 18)

  const globalReserves = uiData[0].result[0]
  const userReserves = uiData[1].result[0]

  let totalEarningsUsd = 0
  let totalCostsUsd = 0

  let totalInterestEarnedUsd = 0
  let totalInterestPaidUsd = 0
  let totalPositionPnlUsd = 0

  const suppliedAssets: SuppliedAsset[] = []
  const borrowedAssets: BorrowedAsset[] = []

  const availableReserves = globalReserves.map((reserve) => ({
    symbol: reserve.symbol,
    underlyingAsset: reserve.underlyingAsset,
    decimals: Number(reserve.decimals),
    priceInUsd: (Number(reserve.priceInMarketReferenceCurrency) / 1e8).toString(),
    apy: calculateAPY(reserve.liquidityRate) * 100,
    borrowApy: calculateAPY(reserve.variableBorrowRate) * 100,
    variableDebtTokenAddress: reserve.variableDebtTokenAddress,
    aTokenAddress: reserve.aTokenAddress,
    liquidationThreshold: Number(reserve.reserveLiquidationThreshold) / 10000,
    raw: {
      ltvBps: BigInt(reserve.baseLTVasCollateral),
      liquidationThresholdBps: BigInt(reserve.reserveLiquidationThreshold),
      priceUsd: BigInt(reserve.priceInMarketReferenceCurrency),
      decimals: Number(reserve.decimals),
      usageAsCollateralEnabled: Boolean(reserve.usageAsCollateralEnabled),
      debtCeiling: BigInt(reserve.debtCeiling ?? 0n),
    },
  }))

  /**
   * Per-reserve collateral state for the connected account, keyed by lowercased address.
   *
   * Kept separate from `availableReserves` because it is USER state, not market state: two
   * accounts see the same reserve differently, and `collateralEnablement` needs both halves.
   * `getUserReservesData` returns an entry per listed reserve, including untouched ones, so a
   * missing key means the reserve is not listed rather than that the user holds none.
   */
  const collateralFlags: Record<string, { scaledATokenBalance: bigint; enabledOnUser: boolean }> = {}
  for (const uRes of userReserves) {
    collateralFlags[uRes.underlyingAsset.toLowerCase()] = {
      scaledATokenBalance: BigInt(uRes.scaledATokenBalance),
      enabledOnUser: Boolean(uRes.usageAsCollateralEnabledOnUser),
    }
  }

  /** Whether ANY reserve is switched on as collateral — decides whether a bad open reverts
   *  (nothing enabled, Aave rejects the borrow) or silently pledges the rest of the account. */
  const hasAnyCollateralEnabled = Object.values(collateralFlags).some(
    (f) => f.enabledOnUser && f.scaledATokenBalance > 0n,
  )


  userReserves.forEach((uRes) => {
    if (uRes.scaledATokenBalance === 0n && uRes.scaledVariableDebt === 0n) return;

    // Lowercased on both sides like every other address comparison here: a miss silently
    // drops the asset from the position rather than erroring.
    const reserve = globalReserves.find(
      (r) => r.underlyingAsset.toLowerCase() === uRes.underlyingAsset.toLowerCase(),
    )
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
        // Raw aToken balance. `amount` is a lossy double — MAX buttons must size
        // from this bigint so the sent amount matches the balance to the wei.
        amountRaw: balanceAmount,
        valueUsd,
        priceInUsd: priceUsd.toString(),
        apy: apy * 100,
        aTokenAddress: reserve.aTokenAddress,
        usageAsCollateralEnabledOnUser: uRes.usageAsCollateralEnabledOnUser,
        liquidationThreshold: Number(reserve.reserveLiquidationThreshold) / 10000,
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
        // Raw variable-debt balance — see the note on the supplied-asset counterpart.
        amountRaw: balanceAmount,
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

  // Only the values actually derived from the contract reads live inside the memo.
  // Render-scope flags (isLoading, isConnected, chain metadata) are assembled outside,
  // so a loading-state flip does not throw away the parsed reserves.
  return {
    collateralUsd,
    debtUsd,
    /** The same totals as `collateralUsd`/`debtUsd`, unrounded: Aave base units, 8 decimals.
     *  Sizing math consumes these; the numbers above are for display. */
    collateralBase: totalCollateralBase,
    debtBase: totalDebtBase,
    /** The account's collateral-weighted LTV and liquidation threshold in bps, eMode included —
     *  Aave's own averages across every supplied reserve. `ltvPercent`/`liquidationThreshold`
     *  above are the rounded display forms of these two. */
    ltvBps: ltv,
    liquidationThresholdBps: currentLiquidationThreshold,
    availableBorrowsUsd,
    ltvPercent,
    liquidationThreshold,
    formattedHealthFactor,
    netApy,
    totalInterestEarnedUsd,
    totalInterestPaidUsd,
    totalPositionPnlUsd,
    suppliedAssets,
    borrowedAssets,
    availableReserves,
    collateralFlags,
    hasAnyCollateralEnabled
  }
  }, [targetAddress, hasAaveConfig, accountData, uiData, netPrincipals, costBasis])

  if (!derived) return emptyResult

  return {
    isConnected,
    isViewMode,
    viewedAddress: targetAddress,
    chainId,
    chainName: chainConfig?.name ?? 'Unknown',
    isUnsupportedChain: false,
    // Same as above: the indexer must not be able to hide an on-chain position.
    isLoading: isAccountLoading || isUiLoading,
    hasReadError,
    eModeCategoryId,
    isEModeEnabled: eModeCategoryId > 0,
    eModeLabel: eModeCategory?.label || (eModeCategoryId === 1 ? 'ETH Correlated' : eModeCategoryId === 2 ? 'Stablecoins' : eModeCategoryId > 0 ? `Category ${eModeCategoryId}` : 'Disabled'),
    eModeLtv: eModeCategory?.ltv ? Number(eModeCategory.ltv) / 100 : 0,
    eModeLiquidationThreshold: eModeCategory?.liquidationThreshold ? Number(eModeCategory.liquidationThreshold) / 10000 : 0,
    eModeExcludedReserves,
    ...derived
  }
}
