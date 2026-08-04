import { useChainId, useEstimateFeesPerGas } from 'wagmi'
import { formatUnits } from 'viem'
import { calculateAdjustedFees } from '../utils/gas'

/**
 * useAdjustedGas — shared EIP-1559 fee wiring for the Aave action modals.
 *
 * Wraps `useEstimateFeesPerGas` + `calculateAdjustedFees` and derives the
 * rough USD cost from an assumed gas limit, so each modal doesn't repeat the
 * same three lines.
 *
 * `enabled` gates the network estimate: pass `false` while the amount input is
 * blank so we don't fetch fees until the user actually types an amount. The
 * real transaction re-estimates fees at write time (see `simulateAndWrite`),
 * so this only controls the UI preview.
 *
 * The estimate is pinned to the connected chain, like every other read in the
 * app. Unpinned, wagmi resolves it against whichever chain the config happens to
 * consider current, so mid-switch a modal can quote another chain's gas price —
 * an L2's sub-gwei fee next to a mainnet action, or the reverse.
 */
export function useAdjustedGas(assumedGasLimit: bigint, ethPriceUsd = 0, enabled = true, priorityMultiplier: bigint = 1n) {
  const chainId = useChainId()
  const { data: feeData } = useEstimateFeesPerGas({ chainId, query: { enabled } })
  const { adjustedMaxFeePerGas: maxFee, adjustedMaxPriorityFeePerGas: maxPriority, adjustedGasPrice } =
    calculateAdjustedFees(feeData?.maxFeePerGas, feeData?.maxPriorityFeePerGas, priorityMultiplier, feeData?.gasPrice)

  const feeToUse = maxFee ?? adjustedGasPrice
  const estimatedFeeUsd = (feeToUse && ethPriceUsd > 0)
    ? Number(formatUnits(feeToUse * assumedGasLimit, 18)) * ethPriceUsd
    : 0

  return { maxFee, maxPriority, gasPrice: adjustedGasPrice, estimatedFeeUsd }
}
