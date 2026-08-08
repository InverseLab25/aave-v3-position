import { expect, it } from "vitest";
import {
  getAllowedRouters,
  getDelegationAllowance,
  getPauseState,
  getPermitContext,
  getPositionBalances,
  isRouterAllowed,
} from "./reads";

const CONTRACT = "0x000000000000000000000000000000000000BEEF" as const;
const ATOKEN = "0x0B925eD163218f6662a35e0f0371Ac234f9E9371" as const;
const VDEBT = "0x72E95b8931767C79bA4EeE721354d6E99a61D004" as const;
const OWNER = "0x000000000000000000000000000000000000dEaD" as const;
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const;

/** Responses are keyed by `functionName`, or by `functionName@address` when one call
 *  shape is issued against two different contracts in the same batch. */
function stubClient(responses: Record<string, unknown>) {
  return {
    calls: [] as Array<{ address: string; functionName: string; args?: readonly unknown[] }>,
    async readContract(p: { address: string; functionName: string; args?: readonly unknown[] }) {
      this.calls.push(p);
      const keyed = `${p.functionName}@${p.address}`;
      return keyed in responses ? responses[keyed] : responses[p.functionName];
    },
  };
}

it("getPauseState treats any nonzero value as paused, not as a bitmask", async () => {
  expect(await getPauseState(stubClient({ paused: 1n }), CONTRACT)).toEqual({ paused: true });
  expect(await getPauseState(stubClient({ paused: 2n }), CONTRACT)).toEqual({ paused: true });
  expect(await getPauseState(stubClient({ paused: 0n }), CONTRACT)).toEqual({ paused: false });
});

it("getAllowedRouters returns the enumerated set", async () => {
  const client = stubClient({ getAllowedRouters: [ROUTER] });
  expect(await getAllowedRouters(client, CONTRACT)).toEqual([ROUTER]);
});

it("isRouterAllowed queries the single-router view with the router as its argument", async () => {
  const client = stubClient({ allowedRouters: true });
  expect(await isRouterAllowed(client, CONTRACT, ROUTER)).toBe(true);
  expect(client.calls[0].args).toEqual([ROUTER]);
});

it("getPermitContext fetches name and nonce for the EIP-712 domain", async () => {
  const client = stubClient({ name: "Aave Ethereum WETH", nonces: 7n });
  expect(await getPermitContext(client, ATOKEN, OWNER)).toEqual({
    name: "Aave Ethereum WETH",
    nonce: 7n,
  });
  expect(client.calls.find((c) => c.functionName === "nonces")?.args).toEqual([OWNER]);
});

it("getPositionBalances reads the aToken and debt-token balances of the user", async () => {
  const client = stubClient({
    [`balanceOf@${ATOKEN}`]: 5n,
    [`balanceOf@${VDEBT}`]: 9n,
  });
  expect(
    await getPositionBalances(client, { aToken: ATOKEN, variableDebtToken: VDEBT, user: OWNER }),
  ).toEqual({ collateral: 5n, debt: 9n });
  expect(client.calls.every((c) => c.args?.[0] === OWNER)).toBe(true);
});

it("getDelegationAllowance reads borrowAllowance(owner, delegatee)", async () => {
  const client = stubClient({ borrowAllowance: 4200n });
  expect(await getDelegationAllowance(client, VDEBT, OWNER, CONTRACT)).toBe(4200n);
  expect(client.calls[0].address).toBe(VDEBT);
  expect(client.calls[0].args).toEqual([OWNER, CONTRACT]);
});
