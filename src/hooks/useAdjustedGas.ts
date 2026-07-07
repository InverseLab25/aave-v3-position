import { useEstimateFeesPerGas } from 'wagmi'
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
 */
export function useAdjustedGas(assumedGasLimit: bigint, ethPriceUsd = 0, enabled = true) {
  const { data: feeData } = useEstimateFeesPerGas({ query: { enabled } })
  const { adjustedMaxFeePerGas: maxFee, adjustedMaxPriorityFeePerGas: maxPriority } =
    calculateAdjustedFees(feeData?.maxFeePerGas, feeData?.maxPriorityFeePerGas)

  const estimatedFeeUsd = (maxFee && ethPriceUsd > 0)
    ? Number(formatUnits(maxFee * assumedGasLimit, 18)) * ethPriceUsd
    : 0

  return { maxFee, maxPriority, estimatedFeeUsd }
}
