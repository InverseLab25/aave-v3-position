/**
 * Sizing helpers for the MAX buttons in the Aave action modals.
 *
 * Two rules the modals kept getting wrong:
 *
 * 1. A MAX amount must be derived from the RAW on-chain bigint, never from the
 *    `Number` we render. `Number(formatUnits(raw, 18)).toFixed(18)` prints the
 *    exact decimal expansion of a lossy double, which drifts from the true
 *    balance in both directions — measured at -99 wei on one balance and +1 wei
 *    on another. An overshoot is sent as "more than you own" and reverts.
 *
 * 2. A MAX amount of the NATIVE token is sent as `msg.value`, so the wallet must
 *    still cover `value + gas`. Spending the entire balance always fails at
 *    simulation with "insufficient funds", so we hold gas back.
 */

/**
 * Safety multiple applied to the fee estimate.
 *
 * `simulateAndWrite` re-runs `estimateFeesPerGas` at write time, so the fee the
 * MAX button saw can be stale by the time the user signs. Doubling absorbs a
 * base-fee climb between the click and the signature.
 */
export const GAS_RESERVE_MULTIPLE = 2n

/**
 * Floor for the reserve, used when the fee estimate hasn't resolved yet (the
 * user can click MAX on the first render, before `useEstimateFeesPerGas`
 * returns). 0.0005 native units is generous on an L2 and modest on mainnet;
 * whenever a real estimate exists it is larger and wins.
 */
export const MIN_GAS_RESERVE_WEI = 500_000_000_000_000n // 0.0005 ETH

/**
 * Native-token amount to hold back to pay for gas.
 *
 * @param maxFeePerGas - adjusted maxFeePerGas from `useAdjustedGas`, if loaded
 * @param gasLimit     - the modal's assumed gas limit for this action
 */
export function nativeGasReserve(maxFeePerGas: bigint | undefined, gasLimit: bigint): bigint {
  if (!maxFeePerGas) return MIN_GAS_RESERVE_WEI
  const estimated = maxFeePerGas * gasLimit * GAS_RESERVE_MULTIPLE
  return estimated > MIN_GAS_RESERVE_WEI ? estimated : MIN_GAS_RESERVE_WEI
}

/**
 * Largest native-token amount that can be sent as `msg.value` and still leave
 * gas behind. Floors at 0 so a dust balance yields a disabled-looking 0 rather
 * than underflowing.
 */
export function maxNativeSpendable(
  balance: bigint,
  maxFeePerGas: bigint | undefined,
  gasLimit: bigint,
): bigint {
  const reserve = nativeGasReserve(maxFeePerGas, gasLimit)
  return balance > reserve ? balance - reserve : 0n
}
