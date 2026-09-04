import { getTxGasCap } from '../config/chains'

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
 * transaction's gas limit (+50%).
 *
 * We must pin one. For an injected wallet viem's `sendTransaction` takes the
 * `json-rpc` branch: it forwards `gas: undefined` straight to `eth_sendTransaction`
 * and never calls `prepareTransactionRequest`, so the limit is whatever the wallet
 * guesses. That guess is made against current state — an Aave supply estimated
 * while `isFirstSupply` is false, but mined once it is true, has to fund an extra
 * cold `setUsingAsCollateral` bitmap write it was never quoted for, and dies with
 * out-of-gas inside SupplyLogic. Unused gas is refunded, so the buffer is free.
 */
export const GAS_LIMIT_BUFFER_PERCENT = 150n

/**
 * Everything a leveraged open or close does BESIDES the swap: the flash loan, the supply, the
 * borrow and the repayment, plus the contract's own bookkeeping.
 *
 * 1.5M, against a measured ~400-600k on Base, so roughly three times the real cost. Deliberately
 * loose: unused gas is refunded, while a limit set too low is an out-of-gas revert with the
 * margin already approved and the delegation already spent.
 */
export const STRATEGY_OVERHEAD_GAS = 1_500_000n

/**
 * A gas limit built from the swap the simulator already measured, rather than from a fresh
 * `eth_estimateGas`.
 *
 * The estimate was a second full execution of the same transaction against the same state — the
 * simulation that priced the route already ran it. What it did not run is the Aave half, which
 * {@link STRATEGY_OVERHEAD_GAS} covers.
 *
 * No {@link bufferedGasLimit} on top. That buffer exists because an estimate is a guess made
 * against state that may have moved by the time the transaction mines; the overhead allowance
 * here is already several times the measured cost, and padding it again would send limits far
 * past what any wallet will show without alarm.
 */
export function gasFromMeasuredSwap(
  swapGas: bigint,
  opts: { chainId?: number; label?: string } = {},
): bigint {
  const gas = swapGas + STRATEGY_OVERHEAD_GAS
  const cap = getTxGasCap(opts.chainId)
  if (cap !== undefined && gas > cap) {
    throw new GasEstimateError(
      `${opts.label ? `${opts.label}: ` : ''}needs ${gas} gas, above this chain's ${cap} ` +
        `per-transaction cap. Nothing was submitted.`,
      { overCap: true },
    )
  }
  return gas
}

/** Apply the safety buffer to a raw gas estimate. */
export function bufferedGasLimit(estimate: bigint): bigint {
  return (estimate * GAS_LIMIT_BUFFER_PERCENT) / 100n
}

/** Priority-fee bump applied to every send. Matches what the close has always used. */
const FEE_PRIORITY_MULTIPLIER = 10n

/**
 * Current network fees, bumped, in the shape `writeContract` wants — spread it into the call.
 *
 * Fees are ours for the same reason the gas limit is: left out, viem forwards `undefined` and the
 * wallet picks, which on a flash-loan transaction means a fee that may not get it mined before the
 * permit deadline or the aggregator's signed maker quotes expire.
 *
 * The bump buys little on an L2 whose sequencer orders by arrival rather than by bid — Base's
 * priority fee is a thousandth of a gwei — but it costs about as little, and it is what makes
 * inclusion on a 1559 L1 predictable.
 *
 * Returns EITHER the 1559 pair or a legacy `gasPrice`, never both: viem's fee parameters are a
 * union and passing all three falls outside every member of it.
 */
export async function adjustedFees(client: {
  estimateFeesPerGas: () => Promise<{
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
    gasPrice?: bigint
  }>
}): Promise<
  { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint } | Record<string, never>
> {
  const fees = await client.estimateFeesPerGas()
  const { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas, adjustedGasPrice } =
    calculateAdjustedFees(
      fees.maxFeePerGas,
      fees.maxPriorityFeePerGas,
      FEE_PRIORITY_MULTIPLIER,
      fees.gasPrice,
    )
  if (adjustedMaxFeePerGas !== undefined && adjustedMaxPriorityFeePerGas !== undefined) {
    return { maxFeePerGas: adjustedMaxFeePerGas, maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas }
  }
  if (adjustedGasPrice !== undefined) return { gasPrice: adjustedGasPrice }
  // Nothing usable came back. Sending no fee fields lets viem fill them, which is worse than ours
  // but far better than a half-populated union that viem rejects outright.
  return {}
}

/**
 * A gas limit could not be established, so nothing was sent. Carries the original failure.
 *
 * `overCap` separates the two reasons, which need different words in front of a user: the call
 * needs more gas than the chain allows in one transaction (nothing to retry — the route has to
 * change), versus the estimate itself failed (usually a revert or a flaky RPC, worth a retry).
 */
export class GasEstimateError extends Error {
  readonly overCap: boolean
  constructor(message: string, options?: { cause?: unknown; overCap?: boolean }) {
    super(message, options)
    this.name = 'GasEstimateError'
    this.overCap = options?.overCap ?? false
  }
}

/**
 * Estimate, buffer, and check a gas limit — or refuse to send.
 *
 * Every write goes through this. The limit is always ours, never the wallet's: viem forwards
 * `gas: undefined` straight to `eth_sendTransaction` for an injected wallet, and the wallet's
 * own guess is unbuffered and made against state that may have moved. On a flash-loan
 * transaction that is an out-of-gas revert with the user's money already spent on gas.
 *
 * So a failed estimate throws rather than degrading. It costs a retry when an RPC hiccups,
 * which is the price of never sending a transaction we could not size.
 *
 * `estimate` is a thunk rather than a call spec because the callers reach the node three
 * different ways — wagmi's `estimateGas`, viem's `estimateContractGas`, and a raw client — and
 * unifying those would move more code than it saves.
 */
export async function pinnedGasLimit(
  estimate: () => Promise<bigint>,
  opts: { chainId?: number; label?: string } = {},
): Promise<bigint> {
  const what = opts.label ? `${opts.label}: ` : ''
  let raw: bigint
  try {
    raw = await estimate()
  } catch (e) {
    throw new GasEstimateError(
      `${what}could not estimate gas, so nothing was submitted. ${(e as Error)?.message ?? ''}`.trim(),
      { cause: e },
    )
  }
  const gas = bufferedGasLimit(raw)
  const cap = getTxGasCap(opts.chainId)
  if (cap === undefined) return gas
  // The estimate on its own is already more than the chain will take. Clamping here would pin a
  // limit below what the call is measured to need, so it would run out of gas mid-execution and
  // burn the fee for nothing. There is no limit worth sending, so send none.
  if (raw > cap) {
    throw new GasEstimateError(
      `${what}needs ${raw} gas, above this chain's ${cap} per-transaction cap. ` +
        'The node would reject it outright, so nothing was submitted.',
      { overCap: true },
    )
  }
  // Only the buffer pushed it over, so clamp rather than refuse: the cap still sits above the
  // estimate, and a thinner margin beats not sending at all. Unused gas is refunded either way.
  return gas > cap ? cap : gas
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
