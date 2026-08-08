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
