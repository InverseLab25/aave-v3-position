// Trimmed to the members this app actually references, plus all errors (needed to decode
// reverts into names). Regenerate with scripts/trim-abis.cjs if a new call is added — a
// missing entry surfaces as a viem "function not found on ABI" error at the call site.
//
// Kept as a TS literal with `as const`: TypeScript cannot apply a const assertion to a JSON
// import (microsoft/TypeScript#33398), so it widens the types and viem loses the literal ABI
// it needs to infer argument and return types.

export const aavePoolAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "target",
        "type": "address"
      }
    ],
    "name": "AddressEmptyCode",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AssetNotListed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerNotAToken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerNotPoolAdmin",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerNotPoolConfigurator",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerNotPositionManager",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerNotUmbrella",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "EModeCategoryReserved",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FailedCall",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidAddressesProvider",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddressNotValid",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "reserve",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "user",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "onBehalfOf",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "enum DataTypes.InterestRateMode",
        "name": "interestRateMode",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "borrowRate",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "uint16",
        "name": "referralCode",
        "type": "uint16"
      }
    ],
    "name": "Borrow",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "reserve",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "user",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "repayer",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "useATokens",
        "type": "bool"
      }
    ],
    "name": "Repay",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "reserve",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "user",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "onBehalfOf",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "uint16",
        "name": "referralCode",
        "type": "uint16"
      }
    ],
    "name": "Supply",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "reserve",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "user",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "to",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "Withdraw",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "interestRateMode",
        "type": "uint256"
      },
      {
        "internalType": "uint16",
        "name": "referralCode",
        "type": "uint16"
      },
      {
        "internalType": "address",
        "name": "onBehalfOf",
        "type": "address"
      }
    ],
    "name": "borrow",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "id",
        "type": "uint8"
      }
    ],
    "name": "getEModeCategoryData",
    "outputs": [
      {
        "components": [
          {
            "internalType": "uint16",
            "name": "ltv",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "liquidationThreshold",
            "type": "uint16"
          },
          {
            "internalType": "uint16",
            "name": "liquidationBonus",
            "type": "uint16"
          },
          {
            "internalType": "address",
            "name": "priceSource",
            "type": "address"
          },
          {
            "internalType": "string",
            "name": "label",
            "type": "string"
          }
        ],
        "internalType": "struct DataTypes.EModeCategoryLegacy",
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
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getUserAccountData",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "totalCollateralBase",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "totalDebtBase",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "availableBorrowsBase",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "currentLiquidationThreshold",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "ltv",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "healthFactor",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getUserEMode",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "interestRateMode",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "onBehalfOf",
        "type": "address"
      }
    ],
    "name": "repay",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "interestRateMode",
        "type": "uint256"
      }
    ],
    "name": "repayWithATokens",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "categoryId",
        "type": "uint8"
      }
    ],
    "name": "setUserEMode",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "onBehalfOf",
        "type": "address"
      },
      {
        "internalType": "uint16",
        "name": "referralCode",
        "type": "uint16"
      }
    ],
    "name": "supply",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "asset",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      }
    ],
    "name": "withdraw",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "CallerNotPoolOrEmergencyAdmin",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerNotRiskOrPoolAdmin",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerNotAssetListingOrPoolAdmin",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AddressesProviderNotRegistered",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidAddressesProviderId",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotContract",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidFlashloanExecutorReturn",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReserveAlreadyAdded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoMoreReservesAllowed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReserveLiquidityNotZero",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FlashloanPremiumInvalid",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidReserveParams",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidEmodeCategoryParams",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerMustBePool",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidMintAmount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidBurnAmount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidAmount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReserveInactive",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReserveFrozen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReservePaused",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BorrowingNotEnabled",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotEnoughAvailableUserBalance",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidInterestRateModeSelected",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "HealthFactorLowerThanLiquidationThreshold",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CollateralCannotCoverNewBorrow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoDebtOfSelectedType",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NoExplicitAmountToRepayOnBehalf",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnderlyingBalanceZero",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "HealthFactorNotBelowThreshold",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CollateralCannotBeLiquidated",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SpecifiedCurrencyNotBorrowedByUser",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InconsistentFlashloanParams",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BorrowCapExceeded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SupplyCapExceeded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LtvValidationFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InconsistentEModeCategory",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReserveAlreadyInitialized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UserHasAssetWithZeroLtv",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLtv",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLiquidationThreshold",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLiquidationBonus",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidDecimals",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidReserveFactor",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidBorrowCap",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSupplyCap",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLiquidationProtocolFee",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidReserveIndex",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AclAdminCannotBeZero",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InconsistentParamsLength",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidExpiration",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSignature",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OperationNotSupported",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidOptimalUsageRatio",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnderlyingCannotBeRescued",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AddressesProviderAlreadyAdded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PoolAddressesDoNotMatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReserveDebtNotZero",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FlashloanDisabled",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidMaxRate",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WithdrawToAToken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SupplyToAToken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Slope2MustBeGteSlope1",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CallerNotRiskOrPoolOrEmergencyAdmin",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LiquidationGraceSentinelCheckFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidGracePeriod",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidFreezeState",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLtvzeroState",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotBorrowableInEMode",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReserveNotInDeficit",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MustNotLeaveDust",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UserCannotHaveDebt",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SelfLiquidation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "reserve",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "categoryId",
        "type": "uint256"
      }
    ],
    "name": "InvalidCollateralInEmode",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "reserve",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "categoryId",
        "type": "uint256"
      }
    ],
    "name": "InvalidDebtInEmode",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "reserve",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "categoryId",
        "type": "uint256"
      }
    ],
    "name": "MustBeEmodeCollateral",
    "type": "error"
  }
] as const
