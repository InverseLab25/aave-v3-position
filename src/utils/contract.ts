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
import type { UseWriteContractReturnType } from 'wagmi'

/**
 * How long to wait for a prerequisite transaction to be mined before giving up (ms).
 * Matches the close path's bound; see the note at its call site.
 */
const RECEIPT_TIMEOUT_MS = 5 * 60 * 1000

/** The parameter bag `simulateContract` accepts, before per-ABI narrowing. */
type SimulateParams = Parameters<typeof simulateContract>[1]
import { extractDetailedError } from './errors'

/** wagmi's async write, as returned by `useWriteContract().writeContractAsync`. */
type WriteContract = UseWriteContractReturnType['writeContractAsync']
import { simulateContract, estimateFeesPerGas, estimateGas, waitForTransactionReceipt } from 'wagmi/actions'
import { encodeFunctionData, type Abi } from 'viem'
import { calculateAdjustedFees, bufferedGasLimit } from './gas'

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
  /**
   * Chain the call is meant for. Pass it whenever the caller resolved its addresses from a
   * specific chain config: wagmi then raises ChainMismatchError if the wallet has since been
   * switched, instead of silently simulating and submitting against the connected chain with
   * another chain's addresses.
   */
  chainId?: number
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
  writeContractAsync: WriteContract,
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
      chainId: params.chainId,
      // viem's fee parameters are a union: EIP-1559 or legacy, never both. Passing all
      // three fell outside every member — what the old `as any` was hiding.
      ...(adjustedMaxFeePerGas
        ? { maxFeePerGas: adjustedMaxFeePerGas, maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas }
        : { gasPrice: adjustedGasPrice }),
      // simulateContract is generic over a literal ABI so it can tell payable from
      // non-payable. This helper is deliberately generic over *any* contract, so that
      // narrowing is impossible here — assert the parameter bag rather than reach for
      // `any`, which would also discard the checks that do apply.
    } as SimulateParams)

    // 4. Pin an explicit gas limit. Without one viem forwards `gas: undefined` to
    //    `eth_sendTransaction` and the wallet's own estimate — made against current
    //    state, with no buffer — becomes the limit. A failed estimate is not fatal:
    //    fall back to the wallet's behaviour rather than blocking the write.
    let gas: bigint | undefined
    try {
      const estimate = await estimateGas(config, {
        to: params.address,
        data: encodeFunctionData({
          abi: params.abi as Abi,
          functionName: params.functionName,
          args: params.args,
        }),
        value: params.value,
        chainId: params.chainId,
        account: (request as { account?: { address: `0x${string}` } }).account?.address,
      })
      gas = bufferedGasLimit(estimate)
    } catch {
      gas = undefined
    }

    // 5. Execute with the simulated request, plus the buffered gas limit.
    return await writeContractAsync(gas ? { ...request, gas } : request)
  } catch (err) {
    console.error('Simulation/Execution failed:', err)
    
    // viem nests the real revert several levels down; extractDetailedError walks to it
    // and appends the node's raw `details` when it adds anything.
    throw new Error(extractDetailedError(err), { cause: err })
  }
}

/**
 * ERC-20 `approve` that survives tokens requiring a zero-reset.
 *
 * Mainnet USDT (0xdAC17…, and the bridged Polygon/Arbitrum/Optimism/Avalanche
 * variants) reverts `approve` whenever the CURRENT allowance and the new value
 * are both non-zero:
 *
 *   require(!((_value != 0) && (allowed[msg.sender][_spender] != 0)))
 *
 * The allowance has to be zeroed first. This bites whenever an allowance is left
 * partially unspent — approve a swap and close the modal without executing, then
 * come back with a larger amount, and the second approve reverts.
 *
 * Rather than hardcoding a token blocklist, we probe with a simulation and only
 * fall back to the two-step reset when that probe actually fails. Compliant
 * tokens pay nothing but a free `eth_call` and still take a single transaction;
 * only USDT-likes see the extra reset. The probe runs as the connected account
 * (wagmi defaults `account` on simulateContract), so `msg.sender` is correct and
 * the require above is evaluated for real.
 *
 * Returns the hash of the FINAL approve. When a reset was needed its transaction
 * is sent and awaited first, so the caller still gets one hash to track.
 */
export async function approveErc20(
  config: Config,
  writeContractAsync: WriteContract,
  params: {
    token: `0x${string}`
    spender: `0x${string}`
    amount: bigint
    /** Allowance read on-chain before this call. Treat an unresolved read as 0n. */
    currentAllowance: bigint
  },
): Promise<`0x${string}`> {
  const { token, spender, amount, currentAllowance } = params
  const call = { address: token, abi: approveAbi, functionName: 'approve' }

  // Only a non-zero -> non-zero transition can trip the USDT guard.
  if (currentAllowance > 0n && amount > 0n) {
    let needsReset = false
    try {
      await simulateContract(config, {
        ...call,
        args: [spender, amount],
      } as SimulateParams)
    } catch {
      needsReset = true
    }

    if (needsReset) {
      const resetHash = await simulateAndWrite(config, writeContractAsync, {
        ...call,
        args: [spender, 0n],
      })
      // The real approve must see an allowance of 0, so this has to land first. Bounded for
      // the same reason as the close: an MEV-protected RPC never includes a transaction that
      // would revert, and a dropped one never arrives on any RPC — either way an unbounded
      // wait hangs the flow with no way out. Failing loudly beats waiting forever.
      try {
        await waitForTransactionReceipt(config, { hash: resetHash, timeout: RECEIPT_TIMEOUT_MS })
      } catch {
        throw new Error(
          `The allowance reset (${resetHash}) has not been mined after ${RECEIPT_TIMEOUT_MS / 60000} minutes. ` +
            'Check it on the explorer before retrying — the approval cannot proceed until it lands.',
        )
      }
    }
  }

  return simulateAndWrite(config, writeContractAsync, { ...call, args: [spender, amount] })
}
