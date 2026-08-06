// src/lib/leverage-sdk/signatures.ts
import { parseSignature, type Address, type Hex, type TypedDataDomain } from "viem";

/** EIP-2612 permit types shared by aTokens (and standard ERC-20 permits). */
const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Aave variable-debt-token credit delegation types. */
const DELEGATION_TYPES = {
  DelegationWithSig: [
    { name: "delegatee", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface PermitRequest {
  chainId: number;
  token: Address;
  /** ERC-20 `name()` of the token — part of the EIP-712 domain. */
  tokenName: string;
  owner: Address;
  spender: Address;
  value: bigint;
  /** Current `nonces(owner)` of the token. The revoke signs nonce + 1. */
  nonce: bigint;
  deadline: bigint;
}

export interface DelegationRequest {
  chainId: number;
  debtToken: Address;
  debtTokenName: string;
  delegatee: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}

function domain(chainId: number, name: string, verifyingContract: Address): TypedDataDomain {
  return { name, version: "1", chainId, verifyingContract };
}

/** Grant permit at nonce N. Aave aTokens use EIP-712 domain version "1". */
export function buildATokenPermit(p: PermitRequest) {
  return {
    domain: domain(p.chainId, p.tokenName, p.token),
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: { owner: p.owner, spender: p.spender, value: p.value, nonce: p.nonce, deadline: p.deadline },
  };
}

/**
 * Revoke permit: value 0 at nonce N+1, consumable only after the grant at N.
 *
 * Contract-side invariant this pairs with: a non-zero `permit.value` must always be
 * accompanied by a non-zero `revokePermit.deadline` (i.e. the grant and revoke are signed
 * and submitted together). A zeroed pair (`permit.value == 0` AND `revokePermit.deadline
 * == 0`) means "skip both — rely on a standing allowance already granted in a prior tx."
 * Mixing a real grant with a zeroed revoke (or vice versa) leaves the contract's allowance
 * un-swept after the pull.
 */
export function buildRevokePermit(p: Omit<PermitRequest, "value">) {
  return {
    domain: domain(p.chainId, p.tokenName, p.token),
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: { owner: p.owner, spender: p.spender, value: 0n, nonce: p.nonce + 1n, deadline: p.deadline },
  };
}

/** delegationWithSig payload: lets the contract borrow `value` on the signer's credit. */
export function buildCreditDelegation(p: DelegationRequest) {
  return {
    domain: domain(p.chainId, p.debtTokenName, p.debtToken),
    types: DELEGATION_TYPES,
    primaryType: "DelegationWithSig" as const,
    message: { delegatee: p.delegatee, value: p.value, nonce: p.nonce, deadline: p.deadline },
  };
}

/** Normalizes viem's parsed signature: some inputs yield `yParity` without `v`. */
function normalizeV(sig: ReturnType<typeof parseSignature>): number {
  if (sig.v !== undefined) return Number(sig.v);
  return sig.yParity + 27;
}

/** Splits a 65-byte signature into the contract's Permit struct fields. */
export function toContractPermit(signature: Hex, value: bigint, deadline: bigint) {
  const sig = parseSignature(signature);
  return { value, deadline, v: normalizeV(sig), r: sig.r, s: sig.s };
}

/**
 * Splits a 65-byte signature into the contract's RevokePermit struct fields.
 *
 * Pairs with `buildRevokePermit`: submit this alongside a non-zero permit whenever
 * `permit.value != 0`. Only the fully-zeroed `{ deadline: 0, v: 0, r: 0x0, s: 0x0 }` form
 * (skip both grant and revoke) is safe to omit — see `buildRevokePermit`'s doc comment.
 */
export function toContractRevoke(signature: Hex, deadline: bigint) {
  const sig = parseSignature(signature);
  return { deadline, v: normalizeV(sig), r: sig.r, s: sig.s };
}
