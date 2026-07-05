import type { Address } from 'viem'
import type { QuoteResponse } from '../adapters/types'

/**
 * Aggregators whose ERC20 approval-spender equals their call target, that need
 * no per-swap signature, AND that can direct swap output to an arbitrary
 * recipient. AaveV3Deleverager approves `router`, calls `router`, and expects
 * the output on itself, so only these are usable. Excluded: ParaSwap (separate
 * TokenTransferProxy), CowSwap (off-chain intent), and any Permit2-signature
 * flow (1inch/0x) a contract can't sign. Odos qualifies: spender === to,
 * Permit2 is opt-in only, and /sor/assemble takes a `receiver`.
 */
export const COMPATIBLE_ADAPTERS = ['KyberSwap', 'OpenOcean', 'Odos'] as const

/** Minimal ABI: the single entry point + the contract's custom errors (for decoding reverts). */
export const DELEVERAGER_ABI = [
  {
    type: 'function',
    name: 'closePositionWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateral', type: 'address' },
      { name: 'debtAsset', type: 'address' },
      { name: 'minOut', type: 'uint256' },
      { name: 'router', type: 'address' },
      { name: 'swapData', type: 'bytes' },
      {
        name: 'permit',
        type: 'tuple',
        components: [
          { name: 'value', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
  },
  { type: 'error', name: 'NotManager', inputs: [] },
  { type: 'error', name: 'NoDebt', inputs: [] },
  { type: 'error', name: 'BadRouter', inputs: [] },
  { type: 'error', name: 'SameAsset', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientOutput',
    inputs: [
      { name: 'have', type: 'uint256' },
      { name: 'need', type: 'uint256' },
    ],
  },
] as const

/** Pick the compatible quote with the highest net USD return; null if none compatible. */
export function pickBestRoute(quotes: (QuoteResponse | null)[]): QuoteResponse | null {
  const compatible = quotes.filter(
    (q): q is QuoteResponse =>
      q != null && (COMPATIBLE_ADAPTERS as readonly string[]).includes(q.aggregator),
  )
  if (compatible.length === 0) return null
  return compatible.reduce((best, q) => (q.netReturnUsd > best.netReturnUsd ? q : best))
}

/**
 * Slippage-adjusted minimum output, plus whether it still covers the debt.
 * @param amountOut expected debt-token output (wei) from the quote
 * @param debt live debt (wei) the swap must at least cover to repay the flash loan
 * @param slippageBps slippage tolerance in basis points (50 = 0.5%)
 */
export function computeMinOut(
  amountOut: bigint,
  debt: bigint,
  slippageBps: number,
): { minOut: bigint; covered: boolean } {
  const bps = BigInt(Math.round(slippageBps))
  const minOut = (amountOut * (10000n - bps)) / 10000n
  return { minOut, covered: minOut >= debt }
}

/** EIP-2612 typed data for an Aave V3 aToken permit (spender = deleverager). */
export function buildPermitTypedData(args: {
  aToken: Address
  aTokenName: string
  chainId: number
  owner: Address
  spender: Address
  value: bigint
  nonce: bigint
  deadline: bigint
}) {
  return {
    domain: {
      name: args.aTokenName,
      version: '1', // Aave V3 aToken EIP712_REVISION
      chainId: args.chainId,
      verifyingContract: args.aToken,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit' as const,
    message: {
      owner: args.owner,
      spender: args.spender,
      value: args.value,
      nonce: args.nonce,
      deadline: args.deadline,
    },
  }
}
