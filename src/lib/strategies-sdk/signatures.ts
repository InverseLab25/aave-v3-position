import { parseSignature, type Address, type Hex, type TypedDataDomain } from "viem";
import type { StrategiesPermit, StrategiesSig } from "./abi";

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
  /** Current `nonces(owner)` of the token. */
  nonce: bigint;
  deadline: bigint;
}

export interface DelegationRequest {
  chainId: number;
  debtToken: Address;
  debtTokenName: string;
  delegatee: Address;
  /** Must equal the sized `borrowAmount` exactly — the contract borrows the full signed value. */
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}

/** Aave aTokens and variable-debt tokens both use EIP-712 domain version "1". */
function domain(chainId: number, name: string, verifyingContract: Address): TypedDataDomain {
  return { name, version: "1", chainId, verifyingContract };
}

/** Grant permit at nonce N. */
export function buildATokenPermit(p: PermitRequest) {
  return {
    domain: domain(p.chainId, p.tokenName, p.token),
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: {
      owner: p.owner, spender: p.spender, value: p.value, nonce: p.nonce, deadline: p.deadline,
    },
  };
}

/**
 * Revoke permit: value 0, always required on close — the contract's `_permitZero` runs
 * unconditionally.
 *
 * `nonceOffset` selects which path this revoke belongs to, and getting it wrong reverts with
 * `InvalidExpiration()`:
 *   - 1n (default): paired with a fresh grant, which consumes nonce N first.
 *   - 0n: standing-allowance path, where no grant is submitted and N is still unconsumed.
 */
export function buildRevokePermit(p: Omit<PermitRequest, "value"> & { nonceOffset?: bigint }) {
  return {
    domain: domain(p.chainId, p.tokenName, p.token),
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: {
      owner: p.owner,
      spender: p.spender,
      value: 0n,
      nonce: p.nonce + (p.nonceOffset ?? 1n),
      deadline: p.deadline,
    },
  };
}

/**
 * delegationWithSig payload: lets the contract borrow `value` on the signer's credit.
 * Build this AFTER sizing — the contract borrows exactly `value`, so a stale figure either
 * reverts or leaves residual borrowing power granted to the contract.
 */
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

/** Splits a 65-byte signature into the contract's Permit struct. Field order is load-bearing. */
export function toStrategiesPermit(signature: Hex, amount: bigint, deadline: bigint): StrategiesPermit {
  const sig = parseSignature(signature);
  return { amount, deadline, r: sig.r, s: sig.s, v: normalizeV(sig) };
}

/** Splits a 65-byte signature into the contract's Sig struct. Field order is load-bearing. */
export function toStrategiesSig(signature: Hex, deadline: bigint): StrategiesSig {
  const sig = parseSignature(signature);
  return { deadline, r: sig.r, s: sig.s, v: normalizeV(sig) };
}
