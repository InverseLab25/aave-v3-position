// src/lib/leverage-sdk/signatures.test.ts
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import {
  buildATokenPermit,
  buildCreditDelegation,
  buildRevokePermit,
  toContractPermit,
  toContractRevoke,
} from "./signatures";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const aToken = "0x0B925eD163218f6662a35e0f0371Ac234f9E9371"; // aWETH mainnet
const spender = "0x000000000000000000000000000000000000dEaD";

const base = {
  chainId: 1,
  token: aToken,
  tokenName: "Aave Ethereum WETH",
  owner: account.address,
  spender,
  value: 123n,
  nonce: 7n,
  deadline: 1_786_000_000n,
} as const;

describe("aToken permit pair", () => {
  it("signs a verifiable grant at nonce N", async () => {
    const typed = buildATokenPermit(base);
    expect(typed.domain).toEqual({ name: base.tokenName, version: "1", chainId: 1, verifyingContract: aToken });
    expect(typed.message.nonce).toBe(7n);
    const sig = await account.signTypedData(typed);
    expect(await verifyTypedData({ ...typed, address: account.address, signature: sig })).toBe(true);
    const p = toContractPermit(sig, base.value, base.deadline);
    expect([27, 28]).toContain(p.v);
    expect(p.value).toBe(123n);
  });

  it("builds the revoke at nonce N+1 with value 0", () => {
    const typed = buildRevokePermit(base);
    expect(typed.message.value).toBe(0n);
    expect(typed.message.nonce).toBe(8n); // grant nonce + 1
  });
});

describe("credit delegation", () => {
  it("signs a verifiable DelegationWithSig", async () => {
    const typed = buildCreditDelegation({
      chainId: 1,
      debtToken: "0x72E95b8931767C79bA4EeE721354d6E99a61D004",
      debtTokenName: "Aave Ethereum Variable Debt USDC",
      delegatee: spender,
      value: 10n ** 9n,
      nonce: 0n,
      deadline: 1_786_000_000n,
    });
    expect(typed.primaryType).toBe("DelegationWithSig");
    const sig = await account.signTypedData(typed);
    expect(await verifyTypedData({ ...typed, address: account.address, signature: sig })).toBe(true);
  });
});

describe("revoke split", () => {
  it("splits a signature without a value field", async () => {
    const typed = buildRevokePermit(base);
    const sig = await account.signTypedData(typed);
    const r = toContractRevoke(sig, base.deadline);
    expect(Object.keys(r).sort()).toEqual(["deadline", "r", "s", "v"]);
  });
});
