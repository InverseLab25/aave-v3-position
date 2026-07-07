/**
 * calculateAdjustedFees
 *
 * Applies multipliers to EIP-1559 gas parameters and enforces the
 * EIP-1559 invariant:
 *
 *   maxFeePerGas >= baseFee + maxPriorityFeePerGas
 *
 * Multipliers:
 *   • maxPriorityFeePerGas × 2   — standard safe buffer for next-block inclusion
 *   • maxFeePerGas (floor)       — must be at least baseFee + adjustedPriority
 *
 * baseFee is derived from the network estimate using the standard formula:
 *   maxFeePerGas (network) ≈ 2 × baseFee + maxPriorityFeePerGas
 *   → baseFee ≈ (maxFeePerGas - maxPriorityFeePerGas) / 2
 *
 * The final adjustedMaxFeePerGas is the larger of:
 *   a) maxFeePerGas × 1.2   (a comfortable buffer over the current fee)
 *   b) baseFee + adjustedMaxPriorityFeePerGas  (invariant floor)
 */
export function calculateAdjustedFees(
  maxFeePerGas?: bigint,
  maxPriorityFeePerGas?: bigint,
) {
  if (!maxFeePerGas || !maxPriorityFeePerGas) {
    return { adjustedMaxFeePerGas: undefined, adjustedMaxPriorityFeePerGas: undefined }
  }

  // Step 1: apply 2× to priority fee (tip) — standard safe buffer for next-block inclusion
  const adjustedMaxPriorityFeePerGas = maxPriorityFeePerGas * 2n

  // Step 2: derive baseFee from network estimate
  //   network formula: maxFeePerGas = 2×baseFee + maxPriorityFeePerGas
  //   → baseFee = (maxFeePerGas - maxPriorityFeePerGas) / 2
  const baseFee = (maxFeePerGas - maxPriorityFeePerGas) / 2n

  // Step 3: enforce EIP-1559 invariant — maxFeePerGas >= baseFee + priority
  const invariantFloor = baseFee + adjustedMaxPriorityFeePerGas

  // Step 4: also apply a 1.2× buffer on the original maxFeePerGas
  const buffered = (maxFeePerGas * 12n) / 10n

  // Final: take the higher of the two so both the invariant and the buffer hold
  const adjustedMaxFeePerGas = invariantFloor > buffered ? invariantFloor : buffered

  return { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas }
}
