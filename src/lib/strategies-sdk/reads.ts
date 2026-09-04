import { parseAbi, type Address } from "viem";
import { aaveV3StrategiesAbi } from "./abi";

/** Minimal read surface — any viem PublicClient satisfies this. */
export interface ReadClient {
  readContract(params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function borrowAllowance(address fromUser, address toUser) view returns (uint256)",
] as const);

/**
 * `paused` is 0 or 1 and halts BOTH legs. It is NOT the per-leg bitmask the superseded
 * AaveV3Leverage used — decoding it as one silently misreports the state.
 */
export async function getPauseState(
  client: ReadClient,
  contract: Address,
): Promise<{ paused: boolean }> {
  const bits = (await client.readContract({
    address: contract, abi: aaveV3StrategiesAbi, functionName: "paused",
  })) as bigint;
  return { paused: bits !== 0n };
}

/** Routers the owner has allowlisted — filter swap quotes to these before signing. */
export async function getAllowedRouters(
  client: ReadClient,
  contract: Address,
): Promise<readonly Address[]> {
  return (await client.readContract({
    address: contract, abi: aaveV3StrategiesAbi, functionName: "getAllowedRouters",
  })) as readonly Address[];
}

/**
 * The two reads every preview needs before it can quote, cached.
 *
 * Both change only when the owner sends a transaction, and both were being read again on every
 * run — every debounce while the user types and every three seconds while the confirmation is
 * open. Keyed on the CHAIN as well as the address: AaveV3Strategies sits at one CREATE3 address
 * on Base and Arbitrum, so the address alone would hand one chain the other's allowlist.
 *
 * Cached as the promise rather than the value, so two runs racing on a cold key share one
 * request instead of both issuing it. A rejected promise is dropped so the next run retries
 * rather than replaying a dead RPC for a minute.
 *
 * The TTL is safety rather than correctness: the contract enforces its own pause and allowlist,
 * so the worst a stale read does is offer a route the send then rejects. {@link
 * forgetContractState} is for the user's explicit refresh, which should see the chain as it is.
 */
export interface ContractState {
  paused: boolean
  routers: readonly Address[]
}

const CONTRACT_STATE_TTL_MS = 60_000
const contractState_ = new Map<string, { at: number; value: Promise<ContractState> }>()

export function readContractState(
  client: ReadClient,
  chainId: number,
  contract: Address,
): Promise<ContractState> {
  const key = `${chainId}:${contract.toLowerCase()}`
  const hit = contractState_.get(key)
  if (hit && Date.now() - hit.at < CONTRACT_STATE_TTL_MS) return hit.value

  const value = Promise.all([getPauseState(client, contract), getAllowedRouters(client, contract)])
    .then(([{ paused }, routers]) => ({ paused, routers }))
  value.catch(() => {
    if (contractState_.get(key)?.value === value) contractState_.delete(key)
  })
  contractState_.set(key, { at: Date.now(), value })
  return value
}

/** Drop every cached read, so the next preview sees the chain as it is now. */
export function forgetContractState(): void {
  contractState_.clear()
}

/** Single-router check — cheaper than enumerating when a candidate is already in hand. */
export async function isRouterAllowed(
  client: ReadClient,
  contract: Address,
  router: Address,
): Promise<boolean> {
  return (await client.readContract({
    address: contract, abi: aaveV3StrategiesAbi, functionName: "allowedRouters", args: [router],
  })) as boolean;
}

/** name() + nonces(owner) of an aToken or debt token — the EIP-712 domain inputs. */
export async function getPermitContext(client: ReadClient, token: Address, owner: Address) {
  const [name, nonce] = await Promise.all([
    client.readContract({ address: token, abi: tokenAbi, functionName: "name" }) as Promise<string>,
    client.readContract({
      address: token, abi: tokenAbi, functionName: "nonces", args: [owner],
    }) as Promise<bigint>,
  ]);
  return { name, nonce };
}

/**
 * The user's live position for one reserve pair. Token addresses are parameters, not derived
 * here — `src/lib/aaveStatics.ts` already resolves and caches them.
 */
export async function getPositionBalances(
  client: ReadClient,
  p: { aToken: Address; variableDebtToken: Address; user: Address },
): Promise<{ collateral: bigint; debt: bigint }> {
  const [collateral, debt] = await Promise.all([
    client.readContract({
      address: p.aToken, abi: tokenAbi, functionName: "balanceOf", args: [p.user],
    }) as Promise<bigint>,
    client.readContract({
      address: p.variableDebtToken, abi: tokenAbi, functionName: "balanceOf", args: [p.user],
    }) as Promise<bigint>,
  ]);
  return { collateral, debt };
}

/**
 * Credit already delegated to `delegatee`. When this covers the sized `borrowAmount`, the open
 * can ship a zeroed `Sig` (deadline 0n) and skip the signature prompt entirely.
 */
export async function getDelegationAllowance(
  client: ReadClient,
  variableDebtToken: Address,
  owner: Address,
  delegatee: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: variableDebtToken, abi: tokenAbi, functionName: "borrowAllowance",
    args: [owner, delegatee],
  })) as bigint;
}
