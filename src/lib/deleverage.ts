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

/**
 * Minimal ABI: the entry point, the read-only preflight getters, and every custom error
 * the contract can raise (so viem decodes reverts into names instead of raw selectors).
 * Keep the error list in sync with AaveV3Deleverager.sol — a missing entry degrades a
 * clear failure into an undecodable hex selector.
 */
export const DELEVERAGER_ABI = [
  {
    type: 'function',
    name: 'closePositionWithPermit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateral', type: 'address' },
      { name: 'debtAsset', type: 'address' },
      { name: 'collateralToWithdraw', type: 'uint256' },
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
      // Second signature, over value 0 at nonce N+1. Consumed right after the aTokens are
      // pulled so no residual allowance outlives the call. It carries no `value` — the
      // contract always passes a literal 0, so this signature can only ever clear.
      {
        name: 'revokePermit',
        type: 'tuple',
        components: [
          { name: 'deadline', type: 'uint256' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
  },
  // The contract only calls routers the owner has allowlisted; an unlisted `router`
  // reverts with RouterNotAllowed() after the user has already signed a permit.
  {
    type: 'function',
    name: 'allowedRouters',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  // The whole allowlist in one read. Preferred over probing allowedRouters(x) per route:
  // the contract stores it in an enumerable set so integrators can filter routes up front.
  {
    type: 'function',
    name: 'getAllowedRouters',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address[]' }],
  },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'error', name: 'Reentrancy', inputs: [] },
  { type: 'error', name: 'ExpectedState', inputs: [] },
  { type: 'error', name: 'NotMorpho', inputs: [] },
  { type: 'error', name: 'UnexpectedCallback', inputs: [] },
  { type: 'error', name: 'NoDebt', inputs: [] },
  { type: 'error', name: 'SameAsset', inputs: [] },
  { type: 'error', name: 'Paused', inputs: [] },
  { type: 'error', name: 'RouterNotAllowed', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientOutput',
    inputs: [
      { name: 'have', type: 'uint256' },
      { name: 'need', type: 'uint256' },
    ],
  },
] as const

/** Compatible quotes, best net USD return first. Empty when none are usable. */
export function rankRoutes(quotes: (QuoteResponse | null)[]): QuoteResponse[] {
  return quotes
    .filter(
      (q): q is QuoteResponse =>
        q != null && (COMPATIBLE_ADAPTERS as readonly string[]).includes(q.aggregator),
    )
    .sort((a, b) => b.netReturnUsd - a.netReturnUsd)
}

/** Pick the compatible quote with the highest net USD return; null if none compatible. */
export function pickBestRoute(quotes: (QuoteResponse | null)[]): QuoteResponse | null {
  return rankRoutes(quotes)[0] ?? null
}

/**
 * Reasons a built router transaction cannot be handed to the deleverager. The contract
 * approves `router`, then calls `router` with zero value, so anything that violates
 * those assumptions must be caught before the user signs a permit — a revert this
 * late costs gas and leaves the signature live for the rest of its deadline.
 */
export function validateSwapTx(
  tx: { to: string; data: string; value: string; spender: string },
  isRouterAllowlisted: boolean,
): string | null {
  if (tx.to.toLowerCase() !== tx.spender.toLowerCase()) {
    return 'approval target and call target differ'
  }
  if (!tx.data || tx.data === '0x') return 'router returned empty calldata'
  // LibCall.callContract sends no ETH, so a route needing msg.value can never execute.
  let value: bigint
  try {
    value = BigInt(tx.value || '0')
  } catch {
    return `unparseable tx value "${tx.value}"`
  }
  if (value !== 0n) return `route requires ${value} wei of ETH; the deleverager sends none`
  if (!isRouterAllowlisted) return `router ${tx.to} is not allowlisted on the deleverager`
  return null
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
