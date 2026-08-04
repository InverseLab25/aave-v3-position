// Trimmed to the members this app actually references, plus all errors (needed to decode
// reverts into names). Regenerate with scripts/trim-abis.cjs if a new call is added — a
// missing entry surfaces as a viem "function not found on ABI" error at the call site.
//
// Kept as a TS literal with `as const`: TypeScript cannot apply a const assertion to a JSON
// import (microsoft/TypeScript#33398), so it widens the types and viem loses the literal ABI
// it needs to infer argument and return types.

export const uiPoolDataProviderAbi = [
  {
    "inputs": [],
    "name": "InvalidReserveIndex",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "contract IPoolAddressesProvider",
        "name": "provider",
        "type": "address"
      }
    ],
    "name": "getReservesData",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "underlyingAsset",
            "type": "address"
          },
          {
            "internalType": "string",
            "name": "name",
            "type": "string"
          },
          {
            "internalType": "string",
            "name": "symbol",
            "type": "string"
          },
          {
            "internalType": "uint256",
            "name": "decimals",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "baseLTVasCollateral",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "reserveLiquidationThreshold",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "reserveLiquidationBonus",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "reserveFactor",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "usageAsCollateralEnabled",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "borrowingEnabled",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "isActive",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "isFrozen",
            "type": "bool"
          },
          {
            "internalType": "uint128",
            "name": "liquidityIndex",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "variableBorrowIndex",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "liquidityRate",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "variableBorrowRate",
            "type": "uint128"
          },
          {
            "internalType": "uint40",
            "name": "lastUpdateTimestamp",
            "type": "uint40"
          },
          {
            "internalType": "address",
            "name": "aTokenAddress",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "variableDebtTokenAddress",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "interestRateStrategyAddress",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "availableLiquidity",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "totalScaledVariableDebt",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "priceInMarketReferenceCurrency",
            "type": "uint256"
          },
          {
            "internalType": "address",
            "name": "priceOracle",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "variableRateSlope1",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "variableRateSlope2",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "baseVariableBorrowRate",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "optimalUsageRatio",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "isPaused",
            "type": "bool"
          },
          {
            "internalType": "bool",
            "name": "isSiloedBorrowing",
            "type": "bool"
          },
          {
            "internalType": "uint128",
            "name": "accruedToTreasury",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "isolationModeTotalDebt",
            "type": "uint128"
          },
          {
            "internalType": "bool",
            "name": "flashLoanEnabled",
            "type": "bool"
          },
          {
            "internalType": "uint256",
            "name": "debtCeiling",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "debtCeilingDecimals",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "borrowCap",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "supplyCap",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "borrowableInIsolation",
            "type": "bool"
          },
          {
            "internalType": "uint128",
            "name": "virtualUnderlyingBalance",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "deficit",
            "type": "uint128"
          }
        ],
        "internalType": "struct IUiPoolDataProviderV3.AggregatedReserveData[]",
        "name": "",
        "type": "tuple[]"
      },
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "marketReferenceCurrencyUnit",
            "type": "uint256"
          },
          {
            "internalType": "int256",
            "name": "marketReferenceCurrencyPriceInUsd",
            "type": "int256"
          },
          {
            "internalType": "int256",
            "name": "networkBaseTokenPriceInUsd",
            "type": "int256"
          },
          {
            "internalType": "uint8",
            "name": "networkBaseTokenPriceDecimals",
            "type": "uint8"
          }
        ],
        "internalType": "struct IUiPoolDataProviderV3.BaseCurrencyInfo",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "contract IPoolAddressesProvider",
        "name": "provider",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getUserReservesData",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "underlyingAsset",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "scaledATokenBalance",
            "type": "uint256"
          },
          {
            "internalType": "bool",
            "name": "usageAsCollateralEnabledOnUser",
            "type": "bool"
          },
          {
            "internalType": "uint256",
            "name": "scaledVariableDebt",
            "type": "uint256"
          }
        ],
        "internalType": "struct IUiPoolDataProviderV3.UserReserveData[]",
        "name": "",
        "type": "tuple[]"
      },
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const
