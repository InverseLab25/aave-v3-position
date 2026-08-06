import { parseAbi, type Address } from "viem";
import { aaveV3LeverageAbi, PAUSE_CLOSE, PAUSE_OPEN } from "./abi";

/** Minimal read surface — any viem PublicClient satisfies this. */
export interface ReadClient {
  readContract(params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

const permitContextAbi = parseAbi([
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
] as const);

/** Routers the owner has allowlisted — filter swap quotes to these before signing. */
export async function getAllowedRouters(client: ReadClient, contract: Address): Promise<readonly Address[]> {
  return (await client.readContract({
    address: contract, abi: aaveV3LeverageAbi, functionName: "getAllowedRouters",
  })) as readonly Address[];
}

/**
 * Decodes the pause bitmask into per-leg flags.
 * AaveV3Leverage only — its `paused` is a per-leg bitmask. For AaveV3Strategies use `getStrategiesPauseState`.
 */
export async function getPauseState(client: ReadClient, contract: Address) {
  const bits = (await client.readContract({
    address: contract, abi: aaveV3LeverageAbi, functionName: "paused",
  })) as bigint;
  return { openPaused: (bits & PAUSE_OPEN) !== 0n, closePaused: (bits & PAUSE_CLOSE) !== 0n };
}

/** name() + nonces(owner) of an aToken or debt token — the EIP-712 domain inputs. */
export async function getPermitContext(client: ReadClient, token: Address, owner: Address) {
  const [name, nonce] = await Promise.all([
    client.readContract({ address: token, abi: permitContextAbi, functionName: "name" }) as Promise<string>,
    client.readContract({ address: token, abi: permitContextAbi, functionName: "nonces", args: [owner] }) as Promise<bigint>,
  ]);
  return { name, nonce };
}
