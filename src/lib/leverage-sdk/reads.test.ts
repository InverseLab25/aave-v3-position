import { expect, it } from "vitest";
import { getAllowedRouters, getPauseState, getPermitContext } from "./reads";

const CONTRACT = "0x000000000000000000000000000000000000BEEF" as const;
const TOKEN = "0x0B925eD163218f6662a35e0f0371Ac234f9E9371" as const;
const OWNER = "0x000000000000000000000000000000000000dEaD" as const;

function stubClient(responses: Record<string, unknown>) {
  return {
    calls: [] as Array<{ functionName: string; args?: readonly unknown[] }>,
    async readContract(p: { functionName: string; args?: readonly unknown[] }) {
      this.calls.push(p);
      return responses[p.functionName];
    },
  };
}

it("getAllowedRouters returns the enumerated set", async () => {
  const client = stubClient({ getAllowedRouters: [CONTRACT] });
  expect(await getAllowedRouters(client, CONTRACT)).toEqual([CONTRACT]);
});

it("getPauseState decodes the bitmask", async () => {
  const client = stubClient({ paused: 2n }); // PAUSE_CLOSE only
  expect(await getPauseState(client, CONTRACT)).toEqual({ openPaused: false, closePaused: true });
});

it("getPermitContext fetches name and nonce for the EIP-712 domain", async () => {
  const client = stubClient({ name: "Aave Ethereum WETH", nonces: 7n });
  const ctx = await getPermitContext(client, TOKEN, OWNER);
  expect(ctx).toEqual({ name: "Aave Ethereum WETH", nonce: 7n });
  expect(client.calls.find((c) => c.functionName === "nonces")?.args).toEqual([OWNER]);
});
