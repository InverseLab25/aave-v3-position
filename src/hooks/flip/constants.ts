import { parseAbi } from 'viem'


/*//////////////////////////////////////////////////////////////
                           CONSTANTS
//////////////////////////////////////////////////////////////*/

/**
 * How far the flash is sized against a rate worse than quoted.
 *
 * Unlike the open flow this is not protecting a flash repayment — the flip repays in kind out of
 * the withdrawal plus the borrow, both fixed before the swap runs. What the buffer buys is that
 * the requested leverage becomes a CEILING rather than a target: size against a rate slightly
 * worse than quoted, fill at the quoted one, and the surplus lands as extra collateral and pulls
 * realized leverage below what was asked for. Undershooting is the safe side.
 */
export const RATE_BUFFER_BPS = 50n

/**
 * Quote rounds allowed while converging on the flash size.
 *
 * Two, where `solveBorrow` takes more. There the loop is a SAFETY loop: under-sizing means the
 * swap cannot repay the flash and the whole transaction reverts, so it has to converge. Here a
 * mis-sized flash only lands leverage a fraction of a percent off, so the second round is for
 * accuracy and a third is not worth another round trip to every aggregator.
 */
export const QUOTE_ROUNDS = 2

/** How long a signature stays valid. Long enough to survive a build and inclusion. */
export const SIGNATURE_TTL_S = 1800n

/**
 * Headroom the aToken permit grants above the pull (25%).
 *
 * It can never mean a larger withdrawal: the contract pulls the balance it reads for itself, and
 * the grant is revoked inside the same transaction. What it buys is survival — sized exactly, a
 * signature is invalidated by the first aToken rebase that drifts a single wei upward.
 */
export const PERMIT_HEADROOM_BPS = 2500n

export const RECEIPT_TIMEOUT_MS = 90_000

export const ORACLE_ABI = parseAbi(['function getAssetPrice(address asset) view returns (uint256)'])
export const DATA_PROVIDER_ABI = parseAbi([
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
  'function getDebtCeiling(address asset) view returns (uint256)',
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
])
export const NONCES_ABI = parseAbi(['function nonces(address owner) view returns (uint256)'])
