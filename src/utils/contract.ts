/**
 * simulateAndWrite — wagmi standard pattern helper
 *
 * Every on-chain write should be preceded by a simulation so that revert
 * reasons are surfaced before the wallet popup appears and before gas is
 * spent on a failing transaction.
 *
 * This helper combines three steps into one call:
 *   1. estimateFeesPerGas  — fetch current EIP-1559 base + priority fees
 *   2. calculateAdjustedFees — apply multiplier to base fee (base ×1.2)
 *   3. simulateContract    — dry-run the call; throws with revert reason on failure
 *   4. writeContractAsync  — send the real transaction using the simulated request
 */

import type { Config } from 'wagmi'
import { simulateContract, estimateFeesPerGas } from 'wagmi/actions'
import type { Abi } from 'viem'
import { calculateAdjustedFees } from './gas'

/**
 * USDT-safe ERC20 `approve` ABI.
 *
 * viem's built-in `erc20Abi` declares approve as `returns (bool)`. Non-standard
 * tokens like mainnet USDT (0xdAC17…) return NO data from approve, so viem's
 * simulateContract throws `ContractFunctionExecutionError: approve returned no
 * data ("0x")`. Declaring empty outputs makes viem skip return-data decoding, so
 * both USDT (returns nothing) and standard tokens (bool ignored) work.
 *
 * Use this ABI for every `approve` WRITE. Reads (allowance/balanceOf) can keep
 * using viem's erc20Abi — only approve is non-compliant.
 */
export const approveAbi = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

export interface ContractCallParams {
  address: `0x${string}`
  abi: Abi | readonly unknown[]
  functionName: string
  args?: readonly unknown[]
  value?: bigint
  priorityMultiplier?: bigint
  [key: string]: unknown
}

/**
 * Simulate a contract call, then execute it if simulation succeeds.
 *
 * @param config             - wagmi Config (from `useConfig()`)
 * @param writeContractAsync - async write function (from `useWriteContract()`)
 * @param params             - contract call params (address, abi, functionName, args, value…)
 * @returns                  - transaction hash
 */
export async function simulateAndWrite(
  config: Config,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeContractAsync: (request: any) => Promise<`0x${string}`>,
  params: ContractCallParams,
): Promise<`0x${string}`> {
  // 1. Fetch current network fees
  const fees = await estimateFeesPerGas(config)

  // 2. Apply multiplier: maxFeePerGas ×1.2 (priority fee is used as returned by ETH API)
  const { adjustedMaxFeePerGas, adjustedMaxPriorityFeePerGas, adjustedGasPrice } = calculateAdjustedFees(
    fees.maxFeePerGas,
    fees.maxPriorityFeePerGas,
    params.priorityMultiplier ?? 1n,
    fees.gasPrice
  )

  try {
    // 3. Simulate — will throw with a human-readable revert reason if the call would fail.
    //    Only pass the gas params that simulateContract understands.
    const { request } = await simulateContract(config, {
      address: params.address,
      abi: params.abi,
      functionName: params.functionName,
      args: params.args,
      value: params.value,
      maxFeePerGas: adjustedMaxFeePerGas,
      maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas,
      gasPrice: adjustedGasPrice,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    // 4. Execute with the exact request object returned by simulation
    return await writeContractAsync(request)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    console.error('Simulation/Execution failed:', err)
    
    let errorMsg = err.shortMessage || err.message || 'Transaction failed'
    
    // Viem throws nested errors. .walk() helps find the specific revert reason.
    if (typeof err.walk === 'function') {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      const revertError = err.walk((e: any) => e.name === 'ContractFunctionRevertedError')
      if (revertError) {
        errorMsg = revertError.reason || revertError.shortMessage || revertError.message || errorMsg
      }
    } else if (err.cause) {
      errorMsg = err.cause.reason || err.cause.shortMessage || err.cause.message || errorMsg
    }

    // Append raw details (often contains the actual "vm error: ...") if not already present
    if (err.details && !errorMsg.includes(err.details)) {
      errorMsg = `${errorMsg}: ${err.details}`
    }

    // Throw a standard Error so that `e.message` in the UI gets this exact formatted string
// eslint-disable-next-line preserve-caught-error
    throw new Error(errorMsg)
  }
}
