import { expect, it } from "vitest";
import { parseSignature } from "viem";
import {
  buildATokenPermit,
  buildCreditDelegation,
  buildRevokePermit,
  toStrategiesPermit,
  toStrategiesSig,
} from "./signatures";

const TOKEN = "0x0B925eD163218f6662a35e0f0371Ac234f9E9371" as const;
const OWNER = "0x000000000000000000000000000000000000dEaD" as const;
const SPENDER = "0x000000000000000000000000000000000000BEEF" as const;

// r = 0x11..11, s = 0x22..22, v = 27 (0x1b)
const SIG = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as const;
const R = `0x${"11".repeat(32)}`;
const S = `0x${"22".repeat(32)}`;

const permitReq = {
  chainId: 1,
  token: TOKEN,
  tokenName: "Aave Ethereum WETH",
  owner: OWNER,
  spender: SPENDER,
  value: 500n,
  nonce: 7n,
  deadline: 999n,
};

it("buildATokenPermit uses EIP-712 domain version 1 and the token as verifying contract", () => {
  const td = buildATokenPermit(permitReq);
  expect(td.domain).toEqual({
    name: "Aave Ethereum WETH",
    version: "1",
    chainId: 1,
    verifyingContract: TOKEN,
  });
  expect(td.primaryType).toBe("Permit");
  expect(td.message.value).toBe(500n);
  expect(td.message.nonce).toBe(7n);
});

it("buildRevokePermit signs value 0 at nonce + 1 by default (paired with a fresh grant)", () => {
  const td = buildRevokePermit(permitReq);
  expect(td.message.value).toBe(0n);
  expect(td.message.nonce).toBe(8n);
});

it("buildRevokePermit signs at nonce + 0 on the standing-allowance path", () => {
  const td = buildRevokePermit({ ...permitReq, nonceOffset: 0n });
  expect(td.message.value).toBe(0n);
  expect(td.message.nonce).toBe(7n);
});

it("buildCreditDelegation signs the delegatee and value against the debt token", () => {
  const td = buildCreditDelegation({
    chainId: 1,
    debtToken: TOKEN,
    debtTokenName: "Aave Ethereum Variable Debt USDC",
    delegatee: SPENDER,
    value: 1234n,
    nonce: 3n,
    deadline: 999n,
  });
  expect(td.primaryType).toBe("DelegationWithSig");
  expect(td.domain.verifyingContract).toBe(TOKEN);
  expect(td.message).toEqual({ delegatee: SPENDER, value: 1234n, nonce: 3n, deadline: 999n });
});

it("toStrategiesPermit emits the contract's field order: amount, deadline, r, s, v", () => {
  const p = toStrategiesPermit(SIG, 500n, 999n);
  expect(Object.keys(p)).toEqual(["amount", "deadline", "r", "s", "v"]);
  expect(p).toEqual({ amount: 500n, deadline: 999n, r: R, s: S, v: 27 });
});

it("toStrategiesSig emits the contract's field order: deadline, r, s, v", () => {
  const s = toStrategiesSig(SIG, 999n);
  expect(Object.keys(s)).toEqual(["deadline", "r", "s", "v"]);
  expect(s).toEqual({ deadline: 999n, r: R, s: S, v: 27 });
});

it("both converters normalize a yParity-only signature to v", () => {
  const yParitySig = `0x${"11".repeat(32)}${"22".repeat(32)}00` as const;
  expect(parseSignature(yParitySig).yParity).toBe(0);
  expect(toStrategiesSig(yParitySig, 1n).v).toBe(27);
  expect(toStrategiesPermit(yParitySig, 1n, 1n).v).toBe(27);
});
