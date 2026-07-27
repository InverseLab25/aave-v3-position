/**
 * calculateAdjustedFees
 *
 * Safely scales the priority fee while strictly enforcing the EIP-1559 invariant:
 *   maxFeePerGas >= currentBaseFee + maxPriorityFeePerGas
 *
 * wagmi/viem estimates maxFeePerGas using the formula:
 *   maxFeePerGas = (currentBaseFee * 1.2) + maxPriorityFeePerGas
 *
 * To safely inject a priority fee multiplier without guessing the current base fee,
 * we extract viem's original base fee buffer:
 *   baseFeeBuffer = maxFeePerGas - maxPriorityFeePerGas
 *
 * Then we apply the multiplier to the priority fee and add it back:
 *   adjustedMaxFeePerGas = baseFeeBuffer + (maxPriorityFeePerGas * priorityMultiplier)
 *
 * For legacy networks (returning gasPrice), we bump gasPrice by 20% for high priority.
 */
/**
 * Safety buffer applied to an `eth_estimateGas` result before it is pinned as the
 * transaction's gas limit (+25%).
 *
 * We must pin one. For an injected wallet viem's `sendTransaction` takes the
 * `json-rpc` branch: it forwards `gas: undefined` straight to `eth_sendTransaction`
 * and never calls `prepareTransactionRequest`, so the limit is whatever the wallet
 * guesses. That guess is made against current state — an Aave supply estimated
 * while `isFirstSupply` is false, but mined once it is true, has to fund an extra
 * cold `setUsingAsCollateral` bitmap write it was never quoted for, and dies with
 * out-of-gas inside SupplyLogic. Unused gas is refunded, so the buffer is free.
 */
export const GAS_LIMIT_BUFFER_PERCENT = 125n

/** Apply the safety buffer to a raw gas estimate. */
export function bufferedGasLimit(estimate: bigint): bigint {
  return (estimate * GAS_LIMIT_BUFFER_PERCENT) / 100n
}

export function calculateAdjustedFees(
  maxFeePerGas?: bigint,
  maxPriorityFeePerGas?: bigint,
  priorityMultiplier: bigint = 1n,
  gasPrice?: bigint
) {
  if (gasPrice && !maxFeePerGas && !maxPriorityFeePerGas) {
    // Legacy chain handling: we cannot 10x the entire gas price without massive overpayment,
    // so we apply a 20% bump if high priority is requested.
    const adjustedGasPrice = priorityMultiplier > 1n ? (gasPrice * 12n) / 10n : gasPrice
    return { adjustedMaxFeePerGas: undefined, adjustedMaxPriorityFeePerGas: undefined, adjustedGasPrice }
  }

  if (!maxFeePerGas || !maxPriorityFeePerGas) {
    return { adjustedMaxFeePerGas: undefined, adjustedMaxPriorityFeePerGas: undefined, adjustedGasPrice: undefined }
  }

  // Step 1: scale the priority fee
  const adjustedMaxPriorityFeePerGas = maxPriorityFeePerGas * priorityMultiplier

  // Step 2: Extract the base fee buffer that wagmi/viem originally calculated.
  // viem calculates maxFeePerGas = (baseFee * 1.2) + maxPriorityFeePerGas.
  // Instead of guessing the multiplier (which changed from 2x in ethers to 1.2x in viem),
  // we just subtract the original priority fee to get the exact base fee buffer viem used.
  const baseFeeBuffer = maxFeePerGas - maxPriorityFeePerGas

  // Step 3: Add our new adjusted priority fee to viem's base fee buffer.
  // This mathematically guarantees maxFeePerGas >= currentBaseFee + adjustedMaxPriorityFeePerGas
  const adjustedMaxFeePerGas = baseFeeBuffer + adjustedMaxPriorityFeePerGas

  return { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas, adjustedGasPrice: undefined }
}
