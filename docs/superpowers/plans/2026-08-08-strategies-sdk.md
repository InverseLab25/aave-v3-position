# AaveV3Strategies SDK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/lib/strategies-sdk/` — a pure, fully unit-tested TypeScript layer targeting `contract/src/AaveV3Strategies.sol` — and delete the orphaned `src/lib/leverage-sdk/` and the two superseded Solidity contracts.

**Architecture:** Six focused modules with no React, no `fetch`, and no imports from `src/adapters/`. `abi.ts` holds the contract binding; `plan.ts` maps UX modes onto entry points; `signatures.ts` builds and splits EIP-712 signatures; `reads.ts` wraps on-chain views behind a minimal client interface; `sizing.ts` does open-sizing arithmetic in `bigint`. Reserve-token lookup, liquidation price, and quoting deliberately stay outside — each already has an owner elsewhere in the repo.

**Tech Stack:** TypeScript, viem v2, vitest, pnpm. Foundry for the contract-cleanup task.

**Spec:** `docs/superpowers/specs/2026-08-08-strategies-sdk-design.md`

## Global Constraints

- **Package manager is pnpm.** Never `npm` or `yarn`.
- **No new dependencies.** Everything needed (`viem`, `vitest`) is already installed.
- **Pure modules.** No React imports, no `fetch`, no `import.meta.env`, no imports from `src/adapters/` or `src/config/` anywhere under `src/lib/strategies-sdk/`.
- **All on-chain quantities are `bigint`.** Never `number`, never `string`. Ratios are expressed in basis points as `bigint` (`30000n` = 3.0x).
- **Never read, edit, or `git add` `.env`.** The address env vars are consumed via `import.meta.env.*` with a `''` fallback; no `.env` entry is required for the code to build.
- **Lint baseline:** the repo carries a pre-existing eslint backlog in unrelated files, so a clean full `pnpm lint` is not the bar. The per-task gate is `pnpm exec tsc -b` clean **and** `pnpm exec eslint <files this task changed>` clean.
- **Test gate:** `pnpm exec vitest run` green before every commit.
- **Code style:** double-quoted strings and no semicolon-free style inside `src/lib/strategies-sdk/` — match the existing `src/lib/leverage-sdk/` files it replaces (double quotes, semicolons, 2-space indent).
- **Never read `contract/out/`** from a test — it is gitignored and absent on a fresh clone.

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `src/lib/strategies-sdk/abi.ts` | Strategies ABI, `Permit`/`Sig` types, `ZERO_*` sentinels, `FULL_CLOSE` |
| `src/lib/strategies-sdk/plan.ts` | `planOpen` (4 modes) + `planClose` → `{ functionName, args }` |
| `src/lib/strategies-sdk/signatures.ts` | EIP-712 builders + Strategies-shaped signature converters |
| `src/lib/strategies-sdk/reads.ts` | Pause, router allowlist, balances, nonces, delegation allowance |
| `src/lib/strategies-sdk/sizing.ts` | Open-sizing math + leverage guardrails |
| `src/lib/strategies-sdk/index.ts` | Barrel re-export |
| `src/lib/strategies-sdk/*.test.ts` | One vitest suite per module |

**Modified:** `src/config/chains.ts` (adds `strategies` field + `getStrategiesAddress`).

**Deleted:** `src/lib/leverage-sdk/` (11 files), `contract/src/AaveV3Leverage.sol`, `contract/src/AaveV3Leverager.sol`, `contract/test/AaveV3LeverageFork.t.sol`, `contract/test/AaveV3LeveragePayload.t.sol`.

---

### Task 1: ABI module

**Files:**
- Create: `src/lib/strategies-sdk/abi.ts`
- Test: `src/lib/strategies-sdk/abi.test.ts`

**Interfaces:**
- Produces: `aaveV3StrategiesAbi`, `StrategiesPermit`, `StrategiesSig`, `ZERO_STRATEGIES_PERMIT`, `ZERO_STRATEGIES_SIG`, `FULL_CLOSE`. Every later task imports from here.

Background: the selectors below were read from the compiled contract with `forge inspect AaveV3Strategies methods`. They are the authoritative check that the hand-written `parseAbi` strings match the deployed shape — a wrong struct field order still parses fine but produces calldata the contract rejects.

- [ ] **Step 1: Write the failing test**

Create `src/lib/strategies-sdk/abi.test.ts`:

```ts
import { expect, it } from "vitest";
import { toFunctionSelector, getAbiItem } from "viem";
import {
  aaveV3StrategiesAbi,
  FULL_CLOSE,
  ZERO_STRATEGIES_PERMIT,
  ZERO_STRATEGIES_SIG,
} from "./abi";

// Pinned from `forge inspect AaveV3Strategies methods`. A struct field reordered in the
// parseAbi strings still parses, but produces calldata the contract rejects — only the
// selector catches it.
const SELECTORS: Record<string, `0x${string}`> = {
  openWithDebtMargin: "0xbfbf1d96",
  openWithCollateralMargin: "0x980dae0f",
  closePositionWithPermit: "0x329438a8",
  allowedRouters: "0xc646aee2",
  getAllowedRouters: "0x21d062b4",
  paused: "0x5c975abb",
};

it.each(Object.entries(SELECTORS))("%s matches the deployed selector", (name, selector) => {
  const item = getAbiItem({ abi: aaveV3StrategiesAbi, name });
  expect(item, `${name} missing from the ABI`).toBeDefined();
  expect(toFunctionSelector(item as never)).toBe(selector);
});

it("both open entry points take 9 arguments", () => {
  for (const name of ["openWithDebtMargin", "openWithCollateralMargin"] as const) {
    const fn = getAbiItem({ abi: aaveV3StrategiesAbi, name });
    expect(fn && "inputs" in fn && fn.inputs).toHaveLength(9);
  }
});

it("FULL_CLOSE is the uint256 max sentinel", () => {
  expect(FULL_CLOSE).toBe(2n ** 256n - 1n);
});

it("zero sentinels are fully zeroed", () => {
  expect(ZERO_STRATEGIES_PERMIT).toEqual({
    amount: 0n,
    deadline: 0n,
    r: `0x${"00".repeat(32)}`,
    s: `0x${"00".repeat(32)}`,
    v: 0,
  });
  expect(ZERO_STRATEGIES_SIG).toEqual({
    deadline: 0n,
    r: `0x${"00".repeat(32)}`,
    s: `0x${"00".repeat(32)}`,
    v: 0,
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/strategies-sdk/abi.test.ts`
Expected: FAIL — cannot resolve `./abi`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/strategies-sdk/abi.ts`:

```ts
import { parseAbi, type Hex } from "viem";

/** Strategies' permit shape: {amount, deadline, r, s, v}. Field order differs from
 *  the superseded AaveV3Leverage's — the ABI selector test pins it. */
export interface StrategiesPermit {
  amount: bigint;
  deadline: bigint;
  r: Hex;
  s: Hex;
  v: number;
}

/** A bare signature. The signed value is implied by the call site, never carried here:
 *  0 for the close revoke, `borrowAmount` for a delegation. */
export interface StrategiesSig {
  deadline: bigint;
  r: Hex;
  s: Hex;
  v: number;
}

const ZERO_B32 = `0x${"00".repeat(32)}` as const satisfies Hex;

/** amount == 0 makes the contract skip the permit and rely on a standing allowance.
 *  The revoke still runs, so a real `Sig` is required alongside this. */
export const ZERO_STRATEGIES_PERMIT: StrategiesPermit = {
  amount: 0n,
  deadline: 0n,
  r: ZERO_B32,
  s: ZERO_B32,
  v: 0,
};

/** deadline == 0 makes the contract skip a delegation and rely on a standing one.
 *  Valid for the open leg only — the close revoke has no such opt-out. */
export const ZERO_STRATEGIES_SIG: StrategiesSig = {
  deadline: 0n,
  r: ZERO_B32,
  s: ZERO_B32,
  v: 0,
};

/** Sentinel: repay the entire variable debt / drain the whole aToken balance. */
export const FULL_CLOSE = 2n ** 256n - 1n;

/** ABI of AaveV3Strategies (contract/src/AaveV3Strategies.sol). */
export const aaveV3StrategiesAbi = parseAbi([
  "struct Permit { uint256 amount; uint256 deadline; bytes32 r; bytes32 s; uint8 v; }",
  "struct Sig { uint256 deadline; bytes32 r; bytes32 s; uint8 v; }",
  "function openWithDebtMargin(address collateral, address debtAsset, uint256 supplyAmount, uint256 borrowAmount, uint256 marginAmount, uint256 minOut, address router, bytes swapData, Sig delegation)",
  "function openWithCollateralMargin(address collateral, address debtAsset, uint256 flashAmount, uint256 borrowAmount, uint256 marginAmount, uint256 minOut, address router, bytes swapData, Sig delegation)",
  "function closePositionWithPermit(address collateral, address debtAsset, uint256 collateralToWithdraw, uint256 debtRepay, uint256 minOut, address router, Permit permit, Sig revokePermit, bytes swapData)",
  "function allowedRouters(address router) view returns (bool)",
  "function getAllowedRouters() view returns (address[])",
  "function paused() view returns (uint256)",
  "event PositionOpened(address indexed user, address indexed collateral, address indexed debtAsset, uint256 margin, uint256 collateralSupplied, uint256 debtBorrowed)",
  "event PositionClosed(address indexed user, address indexed collateral, address indexed debtAsset, uint256 debtRepaid, uint256 collateralWithdrawn, uint256 returnedToUser)",
] as const);
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/strategies-sdk/abi.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/strategies-sdk/abi.ts src/lib/strategies-sdk/abi.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategies-sdk/abi.ts src/lib/strategies-sdk/abi.test.ts
git commit -m "feat(sdk): Strategies ABI module with selectors pinned to the contract"
```

---

### Task 2: Call planners

**Files:**
- Create: `src/lib/strategies-sdk/plan.ts`
- Test: `src/lib/strategies-sdk/plan.test.ts`

**Interfaces:**
- Consumes: `aaveV3StrategiesAbi`, `StrategiesPermit`, `StrategiesSig`, `ZERO_STRATEGIES_SIG`, `FULL_CLOSE` from `./abi`.
- Produces: `type OpenMode = 1 | 2 | 3 | 4`, `planOpen(input: PlanOpenInput): OpenPlan`, `planClose(input: PlanCloseInput): ClosePlan`.

Background — the four UX modes and how they land on the contract:

| Mode | Direction | Collateral | Debt | Margin asset | Entry point |
| --- | --- | --- | --- | --- | --- |
| 1 | Long X, holding X | X | stable | collateral | `openWithCollateralMargin` |
| 2 | Long X, holding stable | X | stable | debt | `openWithDebtMargin` |
| 3 | Short X, holding X | stable | X | debt | `openWithDebtMargin` |
| 4 | Short X, holding stable | stable | X | collateral | `openWithCollateralMargin` |

- [ ] **Step 1: Write the failing test**

Create `src/lib/strategies-sdk/plan.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { aaveV3StrategiesAbi, FULL_CLOSE, ZERO_STRATEGIES_PERMIT, ZERO_STRATEGIES_SIG } from "./abi";
import { planClose, planOpen, type OpenMode } from "./plan";

const X = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const; // WETH (volatile)
const S = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const; // USDC (stable)
const R = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const; // router

const openBase = {
  volatile: X,
  stable: S,
  flashAmount: 1n,
  borrowAmount: 2n,
  marginAmount: 3n,
  minOut: 4n,
  router: R,
  swapData: "0x" as const,
  delegation: ZERO_STRATEGIES_SIG,
};

describe("planOpen maps (direction, held asset) onto (entry point, asset roles)", () => {
  const table: Array<[OpenMode, string, string, string, string]> = [
    // mode, functionName, collateral, debtAsset, marginAsset
    [1, "openWithCollateralMargin", X, S, X],
    [2, "openWithDebtMargin", X, S, S],
    [3, "openWithDebtMargin", S, X, X],
    [4, "openWithCollateralMargin", S, X, S],
  ];
  for (const [mode, fn, coll, debt, marginAsset] of table) {
    it(`mode ${mode}`, () => {
      const plan = planOpen({ ...openBase, mode });
      expect(plan.functionName).toBe(fn);
      expect(plan.collateral).toBe(coll);
      expect(plan.debtAsset).toBe(debt);
      expect(plan.marginAsset).toBe(marginAsset);
      expect(plan.args).toEqual([coll, debt, 1n, 2n, 3n, 4n, R, "0x", ZERO_STRATEGIES_SIG]);
    });
  }
});

it("planOpen rejects an out-of-range mode", () => {
  expect(() => planOpen({ ...openBase, mode: 5 as never })).toThrow("invalid open mode");
});

it("planOpen args encode against the ABI for every mode", () => {
  for (const mode of [1, 2, 3, 4] as const) {
    const plan = planOpen({ ...openBase, mode });
    const data = encodeFunctionData({
      abi: aaveV3StrategiesAbi,
      functionName: plan.functionName,
      args: plan.args,
    });
    expect(data.startsWith("0x")).toBe(true);
  }
});

it("planClose defaults both amounts to the full-close sentinel", () => {
  const plan = planClose({
    collateral: X,
    debtAsset: S,
    minOut: 7n,
    router: R,
    permit: ZERO_STRATEGIES_PERMIT,
    revokePermit: ZERO_STRATEGIES_SIG,
    swapData: "0x",
  });
  expect(plan.functionName).toBe("closePositionWithPermit");
  expect(plan.args).toEqual([
    X, S, FULL_CLOSE, FULL_CLOSE, 7n, R, ZERO_STRATEGIES_PERMIT, ZERO_STRATEGIES_SIG, "0x",
  ]);
});

it("planClose keeps explicit partial amounts in ABI order (withdraw before repay)", () => {
  const plan = planClose({
    collateral: X,
    debtAsset: S,
    collateralToWithdraw: 11n,
    debtRepay: 22n,
    minOut: 7n,
    router: R,
    permit: ZERO_STRATEGIES_PERMIT,
    revokePermit: ZERO_STRATEGIES_SIG,
    swapData: "0x",
  });
  expect(plan.args[2]).toBe(11n); // collateralToWithdraw
  expect(plan.args[3]).toBe(22n); // debtRepay
});

it("planClose args encode against the ABI", () => {
  const plan = planClose({
    collateral: X,
    debtAsset: S,
    minOut: 7n,
    router: R,
    permit: ZERO_STRATEGIES_PERMIT,
    revokePermit: ZERO_STRATEGIES_SIG,
    swapData: "0x",
  });
  const data = encodeFunctionData({
    abi: aaveV3StrategiesAbi,
    functionName: plan.functionName,
    args: plan.args,
  });
  expect(data.startsWith("0x329438a8")).toBe(true);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/strategies-sdk/plan.test.ts`
Expected: FAIL — cannot resolve `./plan`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/strategies-sdk/plan.ts`:

```ts
import type { Address, Hex } from "viem";
import { FULL_CLOSE, type StrategiesPermit, type StrategiesSig } from "./abi";

/**
 * 1 = long X holding X · 2 = long X holding stable ·
 * 3 = short X holding X · 4 = short X holding stable.
 * Longs collateralize X and borrow the stable; shorts collateralize the stable and borrow X.
 * Modes 1/4 bring margin in the collateral asset; modes 2/3 bring it in the debt asset.
 */
export type OpenMode = 1 | 2 | 3 | 4;

export interface PlanOpenInput {
  mode: OpenMode;
  /** The asset being longed/shorted (X). */
  volatile: Address;
  stable: Address;
  /** Collateral flash-borrowed and supplied. */
  flashAmount: bigint;
  /** Debt borrowed on the user's credit delegation. */
  borrowAmount: bigint;
  /** Margin pulled from the wallet — in `marginAsset` of the returned plan. */
  marginAmount: bigint;
  /** Swap-output floor; must also cover `flashAmount` (the contract enforces both). */
  minOut: bigint;
  router: Address;
  swapData: Hex;
  /** Signed over exactly `borrowAmount`; deadline 0n relies on an existing delegation. */
  delegation: StrategiesSig;
}

export interface OpenPlan {
  functionName: "openWithCollateralMargin" | "openWithDebtMargin";
  collateral: Address;
  debtAsset: Address;
  /** What the wallet must have approved (and holds): tells the FE which allowance to check. */
  marginAsset: Address;
  args: readonly [Address, Address, bigint, bigint, bigint, bigint, Address, Hex, StrategiesSig];
}

export interface PlanCloseInput {
  collateral: Address;
  debtAsset: Address;
  /** Defaults to FULL_CLOSE (drain the whole aToken balance). */
  collateralToWithdraw?: bigint;
  /** Defaults to FULL_CLOSE (repay the entire variable debt). */
  debtRepay?: bigint;
  minOut: bigint;
  router: Address;
  permit: StrategiesPermit;
  /** Always required — the contract zeroes the aToken allowance on every close. */
  revokePermit: StrategiesSig;
  swapData: Hex;
}

export interface ClosePlan {
  functionName: "closePositionWithPermit";
  args: readonly [
    Address, Address, bigint, bigint, bigint, Address, StrategiesPermit, StrategiesSig, Hex,
  ];
}

/** Maps a UX mode onto the contract call: which entry point, and which asset plays which role. */
export function planOpen(p: PlanOpenInput): OpenPlan {
  if (p.mode !== 1 && p.mode !== 2 && p.mode !== 3 && p.mode !== 4) {
    throw new Error(`invalid open mode: ${p.mode}`);
  }
  const long = p.mode === 1 || p.mode === 2;
  const collateral = long ? p.volatile : p.stable;
  const debtAsset = long ? p.stable : p.volatile;
  const collateralMargin = p.mode === 1 || p.mode === 4;

  return {
    functionName: collateralMargin ? "openWithCollateralMargin" : "openWithDebtMargin",
    collateral,
    debtAsset,
    marginAsset: collateralMargin ? collateral : debtAsset,
    args: [
      collateral, debtAsset, p.flashAmount, p.borrowAmount, p.marginAmount,
      p.minOut, p.router, p.swapData, p.delegation,
    ] as const,
  };
}

/** Args tuple for the single close entry point. Note the ABI order: withdraw before repay. */
export function planClose(p: PlanCloseInput): ClosePlan {
  return {
    functionName: "closePositionWithPermit",
    args: [
      p.collateral, p.debtAsset,
      p.collateralToWithdraw ?? FULL_CLOSE,
      p.debtRepay ?? FULL_CLOSE,
      p.minOut, p.router, p.permit, p.revokePermit, p.swapData,
    ] as const,
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/strategies-sdk/plan.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/strategies-sdk/plan.ts src/lib/strategies-sdk/plan.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategies-sdk/plan.ts src/lib/strategies-sdk/plan.test.ts
git commit -m "feat(sdk): planOpen for the four modes and planClose"
```

---

### Task 3: Signatures

**Files:**
- Create: `src/lib/strategies-sdk/signatures.ts`
- Test: `src/lib/strategies-sdk/signatures.test.ts`

**Interfaces:**
- Consumes: `StrategiesPermit`, `StrategiesSig` from `./abi`.
- Produces: `buildATokenPermit(p: PermitRequest)`, `buildRevokePermit(p: Omit<PermitRequest,"value"> & { nonceOffset?: bigint })`, `buildCreditDelegation(p: DelegationRequest)`, `toStrategiesPermit(signature: Hex, amount: bigint, deadline: bigint): StrategiesPermit`, `toStrategiesSig(signature: Hex, deadline: bigint): StrategiesSig`.

Background — two contract invariants this module exists to encode, both silent-failure shaped:

1. A delegation `Sig` is signed over **exactly** `borrowAmount`, so it must be built *after* sizing. A mismatch either reverts or leaves residual borrowing power granted to the contract.
2. On close, the revoke `Sig` is **always** required — `_permitZero` runs unconditionally. Its nonce is `nonce + 1` when paired with a fresh permit (the grant consumes `nonce` first), but `nonce + 0` on the standing-allowance path where no grant is submitted. A wrong offset reverts with `InvalidExpiration()`, which reads as an unrelated bug. This exact mistake already broke the Solidity fork suite, which is why `nonceOffset` is an explicit parameter rather than a hardcoded `+ 1`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/strategies-sdk/signatures.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/strategies-sdk/signatures.test.ts`
Expected: FAIL — cannot resolve `./signatures`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/strategies-sdk/signatures.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/strategies-sdk/signatures.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/strategies-sdk/signatures.ts src/lib/strategies-sdk/signatures.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategies-sdk/signatures.ts src/lib/strategies-sdk/signatures.test.ts
git commit -m "feat(sdk): Strategies-shaped signature builders and converters"
```

---

### Task 4: Reads

**Files:**
- Create: `src/lib/strategies-sdk/reads.ts`
- Test: `src/lib/strategies-sdk/reads.test.ts`

**Interfaces:**
- Consumes: `aaveV3StrategiesAbi` from `./abi`.
- Produces: `interface ReadClient`, `getPauseState`, `getAllowedRouters`, `isRouterAllowed`, `getPermitContext`, `getPositionBalances`, `getDelegationAllowance`.

Background: `AaveV3Strategies.paused` is a plain `uint256` that is 0 or 1 — **not** the per-leg bitmask the superseded `AaveV3Leverage` used. Decoding it as a bitmask silently misreports the state, which is why the old `PAUSE_OPEN`/`PAUSE_CLOSE` decoding does not carry over.

Reserve-token addresses are **not** resolved here — `src/lib/aaveStatics.ts` already caches them, so these functions take token addresses as parameters.

- [ ] **Step 1: Write the failing test**

Create `src/lib/strategies-sdk/reads.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/strategies-sdk/reads.test.ts`
Expected: FAIL — cannot resolve `./reads`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/strategies-sdk/reads.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/strategies-sdk/reads.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/strategies-sdk/reads.ts src/lib/strategies-sdk/reads.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategies-sdk/reads.ts src/lib/strategies-sdk/reads.test.ts
git commit -m "feat(sdk): Strategies reads incl. position balances and delegation allowance"
```

---

### Task 5: Leverage guardrails

**Files:**
- Create: `src/lib/strategies-sdk/sizing.ts`
- Test: `src/lib/strategies-sdk/sizing.test.ts`

**Interfaces:**
- Produces: `BPS`, `WAD`, `LTV_CEILING_FACTOR_BPS`, `maxLeverageForLtvBps(ltvBps: bigint): bigint`, `maxLeverageForHealthFactorBps(ltBps: bigint, targetHfBps: bigint): bigint | null`. Tasks 6 and 7 extend this same file.

Background — two distinct Aave parameters, and conflating them is the classic bug in leverage products:

- **LTV** gates `borrow`. A position of collateral `C` and debt `D` has leverage `L = C/(C−D)`; Aave requires `D ≤ C·LTV`, which rearranges to `L ≤ 1/(1−LTV)`. This is a hard wall — exceed it and the borrow reverts. At LTV 75% it is 4.0x.
- **Liquidation threshold (LT)** governs the health factor. At leverage `L`, `HF = L·LT/(L−1)`, so a target HF inverts to `L = HF/(HF−LT)`. This is a soft ceiling for clamping a UI slider. At LT 80% holding HF 1.5 it is 2.14x.

Note `HF` is a ratio in bps (1.5 → `15000n`) while `LT` is a fraction in bps (0.8 → `8000n`). `HF` falls as `L` rises, asymptotically approaching `LT`, so a target at or below `LT` is unreachable at any finite leverage — the function returns `null` there rather than a misleading number.

- [ ] **Step 1: Write the failing test**

Create `src/lib/strategies-sdk/sizing.test.ts`:

```ts
import { expect, it } from "vitest";
import {
  BPS,
  LTV_CEILING_FACTOR_BPS,
  maxLeverageForHealthFactorBps,
  maxLeverageForLtvBps,
} from "./sizing";

it("maxLeverageForLtvBps inverts 1/(1-LTV)", () => {
  expect(maxLeverageForLtvBps(7500n)).toBe(40000n); // 75% LTV -> 4.00x
  expect(maxLeverageForLtvBps(8000n)).toBe(50000n); // 80% LTV -> 5.00x
  expect(maxLeverageForLtvBps(5000n)).toBe(20000n); // 50% LTV -> 2.00x
});

it("maxLeverageForHealthFactorBps inverts HF/(HF-LT)", () => {
  expect(maxLeverageForHealthFactorBps(8000n, 15000n)).toBe(21428n); // LT 80%, HF 1.5 -> 2.14x
  expect(maxLeverageForHealthFactorBps(8000n, 10000n)).toBe(50000n); // HF 1.0 -> the LTV=LT wall
});

it("maxLeverageForHealthFactorBps returns null when the target is at or below LT", () => {
  // HF decays toward LT as leverage rises, so LT is an asymptote no finite leverage reaches.
  expect(maxLeverageForHealthFactorBps(8000n, 8000n)).toBeNull();
  expect(maxLeverageForHealthFactorBps(8000n, 7000n)).toBeNull();
});

it("the LTV ceiling factor leaves headroom below the exact wall", () => {
  expect(LTV_CEILING_FACTOR_BPS).toBe(9800n);
  const wall = maxLeverageForLtvBps(7500n);
  expect((wall * LTV_CEILING_FACTOR_BPS) / BPS).toBe(39200n); // 3.92x, strictly below 4.00x
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/strategies-sdk/sizing.test.ts`
Expected: FAIL — cannot resolve `./sizing`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/strategies-sdk/sizing.ts`:

```ts
/** Basis-point scale: 10000n == 1.0. Leverage, LTV, LT and health factors all use it. */
export const BPS = 10_000n;

/** Fixed-point scale for swap rates. */
export const WAD = 10n ** 18n;

/**
 * How close to the exact LTV wall sizing is allowed to land. The wall is exact and the borrow
 * reverts *at* it, so sizing must stay strictly below; 0.98 is the haircut.
 */
export const LTV_CEILING_FACTOR_BPS = 9800n;

/** Smallest n such that n * b >= a. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * The hard leverage wall: Aave's `borrow` requires debt <= collateral * LTV, and
 * L = C/(C-D), so L <= 1/(1-LTV). Exceed it and the borrow reverts.
 * LTV 7500 -> 40000 (4.00x).
 */
export function maxLeverageForLtvBps(ltvBps: bigint): bigint {
  return (BPS * BPS) / (BPS - ltvBps);
}

/**
 * The soft ceiling for a UI slider: at leverage L, HF = L*LT/(L-1), which inverts to
 * L = HF/(HF-LT). LT 8000 with a target HF of 15000 -> 21428 (2.14x).
 *
 * Returns null when `targetHfBps <= ltBps`: HF decays toward LT as leverage rises, so LT is an
 * asymptote no finite leverage reaches, and the constraint is simply not binding.
 */
export function maxLeverageForHealthFactorBps(ltBps: bigint, targetHfBps: bigint): bigint | null {
  if (targetHfBps <= ltBps) return null;
  return (targetHfBps * BPS) / (targetHfBps - ltBps);
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/strategies-sdk/sizing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/strategies-sdk/sizing.ts src/lib/strategies-sdk/sizing.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategies-sdk/sizing.ts src/lib/strategies-sdk/sizing.test.ts
git commit -m "feat(sdk): leverage guardrails for the LTV wall and the health-factor ceiling"
```

---

### Task 6: `sizeOpen` — collateral-margin flow

**Files:**
- Modify: `src/lib/strategies-sdk/sizing.ts` (append)
- Modify: `src/lib/strategies-sdk/sizing.test.ts` (append)

**Interfaces:**
- Consumes: `BPS`, `WAD`, `LTV_CEILING_FACTOR_BPS`, `ceilDiv`, `maxLeverageForLtvBps` from Task 5. Note `maxLeverageForLtvBps` returns `bigint | null` — `null` means the LTV is at or above 100%, which has no finite leverage wall. Narrow it before use; do not assert it away with `!` or `as bigint`.
- Produces: `type SizeOpenError`, `interface SizeOpenInput`, `interface OpenSize`, `type SizeOpenResult`, `sizeOpen(input: SizeOpenInput): SizeOpenResult`. Task 7 extends `sizeOpen` with the debt-margin branch; do not rename anything here.

Background — the collateral-margin flow (`openWithCollateralMargin`, UX modes 1 and 4). The contract pulls margin `M`, flash-borrows `flashAmount`, supplies `flashAmount + M`, borrows `B`, swaps `B` into collateral, and the output must clear `flashAmount`. Whatever the swap over-delivers folds back into the supply, so:

```
flashAmount  = M · (L − 1)
effRate      = rateWad · (1 − buffer)
borrowAmount = ceil(flashAmount · WAD / effRate)
expectedOut  = borrowAmount · rateWad / WAD
minOut       = max(flashAmount, expectedOut · (1 − slippage))
collateral   = M + expectedOut          (flash is repaid out of the swap output)
debt         = borrowAmount
```

`rateWad` is collateral wei obtained per 1 debt wei, scaled by `WAD`. Worked example used by the test: WETH collateral (18dp) at $2500, USDC debt (6dp) at $1 → 1 USDC wei buys 4e8 WETH wei, so `rateWad = 4e26`.

Requested leverage is a **floor**, never the exact outcome — the buffer surplus lands in `expectedLeverageBps`.

- [ ] **Step 1: Write the failing test**

First **replace** the existing `./sizing` import at the top of `src/lib/strategies-sdk/sizing.test.ts` with the combined one below — a second `import … from "./sizing"` statement would trip `no-duplicate-imports`:

```ts
import {
  BPS,
  LTV_CEILING_FACTOR_BPS,
  maxLeverageForHealthFactorBps,
  maxLeverageForLtvBps,
  sizeOpen,
  type SizeOpenInput,
} from "./sizing";
```

Then append to the same file:

```ts

// WETH (18dp) at $2500 and USDC (6dp) at $1, both on Aave's 8-decimal USD scale.
// 1 USDC wei buys 4e8 WETH wei, so rateWad = 4e8 * 1e18.
const PRICES = {
  rateWad: 4n * 10n ** 26n,
  collateralPriceUsd: 250_000_000_000n,
  debtPriceUsd: 100_000_000n,
  collateralDecimals: 18,
  debtDecimals: 6,
  ltvBps: 7500n,
  liquidationThresholdBps: 8000n,
  rateBufferBps: 50n,
  slippageBps: 50n,
} as const;

const collateralMargin: SizeOpenInput = {
  marginIn: "collateral",
  marginAmount: 10n ** 18n, // 1 WETH
  leverageBps: 30_000n, // 3.00x
  ...PRICES,
};

function unwrap(r: ReturnType<typeof sizeOpen>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.size;
}

it("sizes a 3x collateral-margin open against a 0.5% rate buffer", () => {
  const s = unwrap(sizeOpen(collateralMargin));
  expect(s.flashAmount).toBe(2_000_000_000_000_000_000n); // 2 WETH: M * (L - 1)
  expect(s.borrowAmount).toBe(5_025_125_629n); // 5025.125629 USDC, rounded up
  expect(s.expectedSwapOut).toBe(2_010_050_251_600_000_000n); // 2.01005 WETH
  expect(s.minOut).toBe(2_000_000_000_342_000_000n); // just above the flash it must clear
  expect(s.expectedCollateral).toBe(3_010_050_251_600_000_000n); // margin + swap output
  expect(s.expectedDebt).toBe(5_025_125_629n);
});

it("borrowing enough to clear the flash makes realized leverage a floor, not a target", () => {
  const s = unwrap(sizeOpen(collateralMargin));
  expect(s.expectedLeverageBps).toBe(30_100n); // 3.01x, above the 3.00x requested
  expect(s.expectedLeverageBps).toBeGreaterThan(collateralMargin.leverageBps);
  expect(s.expectedHealthFactorBps).toBe(11_979n); // ~1.198, matching L*LT/(L-1) at 3.01x
});

it("minOut never lands below the flash amount the swap has to repay", () => {
  const s = unwrap(sizeOpen({ ...collateralMargin, slippageBps: 500n }));
  expect(s.minOut).toBe(s.flashAmount);
});

it("a wider rate buffer borrows more and lands higher up the leverage floor", () => {
  const tight = unwrap(sizeOpen({ ...collateralMargin, rateBufferBps: 10n }));
  const wide = unwrap(sizeOpen({ ...collateralMargin, rateBufferBps: 200n }));
  expect(wide.borrowAmount).toBeGreaterThan(tight.borrowAmount);
  expect(wide.expectedLeverageBps).toBeGreaterThan(tight.expectedLeverageBps);
  expect(wide.expectedHealthFactorBps).toBeLessThan(tight.expectedHealthFactorBps);
});

it("sizes correctly when the collateral is the 6-decimal asset (short direction)", () => {
  // Mode 4: USDC collateral (6dp, $1), WETH debt (18dp, $2500). One WETH wei is worth
  // 2.5e-9 USDC wei, so rateWad = 2.5e-9 * 1e18 = 2.5e9.
  const s = unwrap(
    sizeOpen({
      marginIn: "collateral",
      marginAmount: 5_000_000_000n, // 5000 USDC
      leverageBps: 20_000n, // 2.00x
      rateWad: 2_500_000_000n,
      collateralPriceUsd: 100_000_000n,
      debtPriceUsd: 250_000_000_000n,
      collateralDecimals: 6,
      debtDecimals: 18,
      ltvBps: 7500n,
      liquidationThresholdBps: 8000n,
      rateBufferBps: 50n,
      slippageBps: 50n,
    }),
  );
  expect(s.flashAmount).toBe(5_000_000_000n); // M * (2 - 1)
  expect(s.borrowAmount).toBe(2_010_050_251_256_281_408n); // ~2.01 WETH
  expect(s.expectedSwapOut).toBe(5_025_125_628n);
  expect(s.expectedCollateral).toBe(10_025_125_628n); // margin + swap output
  expect(s.expectedLeverageBps).toBe(20_050n); // above the 2.00x requested
});

it.each([
  ["ZERO_MARGIN", { marginAmount: 0n }],
  ["ZERO_RATE", { rateWad: 0n }],
  ["LEVERAGE_TOO_LOW", { leverageBps: 10_000n }],
  ["LEVERAGE_ABOVE_LTV", { leverageBps: 39_200n }], // == 0.98 * the 4.00x wall
  ["ZERO_PRICE", { collateralPriceUsd: 0n }],
  ["INVALID_LTV", { ltvBps: 10_000n }], // 100% LTV has no finite wall; must not throw
])("rejects with %s rather than throwing", (error, override) => {
  const r = sizeOpen({ ...collateralMargin, ...override });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.error).toBe(error);
});

it("accepts leverage just under the LTV ceiling", () => {
  const r = sizeOpen({ ...collateralMargin, leverageBps: 39_199n });
  expect(r.ok).toBe(true);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/strategies-sdk/sizing.test.ts`
Expected: FAIL — `sizeOpen` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/strategies-sdk/sizing.ts`:

```ts
export type SizeOpenError =
  | "ZERO_MARGIN"
  | "ZERO_RATE"
  | "ZERO_PRICE"
  | "INVALID_LTV"
  | "LEVERAGE_TOO_LOW"
  | "LEVERAGE_ABOVE_LTV";

export interface SizeOpenInput {
  /** Which role the wallet's margin plays — picks the contract entry point and the math. */
  marginIn: "collateral" | "debt";
  /** Margin pulled from the wallet, in the asset named by `marginIn`. */
  marginAmount: bigint;
  /** Target leverage in bps: 30000n == 3.00x. */
  leverageBps: bigint;
  /** Collateral wei obtained per 1 debt wei, scaled by WAD. */
  rateWad: bigint;
  /** Aave oracle prices — any shared fixed-point scale, as long as both sides use it. */
  collateralPriceUsd: bigint;
  debtPriceUsd: bigint;
  collateralDecimals: number;
  debtDecimals: number;
  /** Aave reserve LTV, e.g. 7500n. Gates the borrow. */
  ltvBps: bigint;
  /** Aave liquidation threshold, e.g. 8000n. Drives the health factor. */
  liquidationThresholdBps: bigint;
  /** Rate safety margin, e.g. 50n = 0.5%. Oversizes the borrow so the swap clears the flash. */
  rateBufferBps: bigint;
  /** User slippage tolerance, e.g. 50n = 0.5%. Drives minOut. */
  slippageBps: bigint;
}

export interface OpenSize {
  /** `flashAmount` for the collateral-margin flow, `supplyAmount` for the debt-margin flow. */
  flashAmount: bigint;
  borrowAmount: bigint;
  minOut: bigint;
  expectedSwapOut: bigint;
  expectedCollateral: bigint;
  expectedDebt: bigint;
  /** Realized leverage in bps. Always >= the requested figure — surplus folds into the position. */
  expectedLeverageBps: bigint;
  expectedHealthFactorBps: bigint;
}

export type SizeOpenResult = { ok: true; size: OpenSize } | { ok: false; error: SizeOpenError };

/**
 * Solves margin + target leverage into the contract's amounts.
 *
 * Every division rounds so the error falls on the safe side: the borrow rounds UP, because
 * under-borrowing means the swap cannot repay the flash and the whole transaction reverts,
 * while over-borrowing merely folds surplus collateral into the position.
 */
export function sizeOpen(p: SizeOpenInput): SizeOpenResult {
  if (p.marginAmount <= 0n) return { ok: false, error: "ZERO_MARGIN" };
  if (p.rateWad <= 0n) return { ok: false, error: "ZERO_RATE" };
  if (p.collateralPriceUsd <= 0n || p.debtPriceUsd <= 0n) return { ok: false, error: "ZERO_PRICE" };
  if (p.leverageBps <= BPS) return { ok: false, error: "LEVERAGE_TOO_LOW" };

  // `maxLeverageForLtvBps` returns null for an LTV at or above 100%, which has no finite wall
  // and is not a valid Aave reserve config. Reject rather than let the arithmetic throw.
  const wall = maxLeverageForLtvBps(p.ltvBps);
  if (wall === null) return { ok: false, error: "INVALID_LTV" };

  const ceiling = (wall * LTV_CEILING_FACTOR_BPS) / BPS;
  if (p.leverageBps >= ceiling) return { ok: false, error: "LEVERAGE_ABOVE_LTV" };

  // The buffer is applied to the rate rather than to the borrow, so a thinner quoted rate and a
  // wider safety margin compose into one effective rate.
  const effRate = (p.rateWad * (BPS - p.rateBufferBps)) / BPS;
  if (effRate <= 0n) return { ok: false, error: "ZERO_RATE" };

  // Flash the exposure the margin does not itself provide, then borrow enough to buy it back.
  const flashAmount = (p.marginAmount * (p.leverageBps - BPS)) / BPS;
  if (flashAmount <= 0n) return { ok: false, error: "LEVERAGE_TOO_LOW" };

  const borrowAmount = ceilDiv(flashAmount * WAD, effRate);
  if (borrowAmount <= 0n) return { ok: false, error: "LEVERAGE_TOO_LOW" };

  const expectedSwapOut = (borrowAmount * p.rateWad) / WAD;
  // The flash is repaid out of the swap output, so the position keeps margin plus the whole output.
  const expectedCollateral = p.marginAmount + expectedSwapOut;

  return {
    ok: true,
    size: finish(p, {
      flashAmount,
      borrowAmount,
      expectedSwapOut,
      expectedCollateral,
      // The contract enforces both floors; the slippage floor is the one that protects the user,
      // and it can never be allowed to drop below the amount the flash needs back.
      minOut: max(flashAmount, (expectedSwapOut * (BPS - p.slippageBps)) / BPS),
    }),
  };
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Attaches the derived position metrics shared by both flows. */
function finish(
  p: SizeOpenInput,
  s: Omit<OpenSize, "expectedDebt" | "expectedLeverageBps" | "expectedHealthFactorBps"> & {
    borrowAmount: bigint;
  },
): OpenSize {
  const collUsd = (s.expectedCollateral * p.collateralPriceUsd) / 10n ** BigInt(p.collateralDecimals);
  const debtUsd = (s.borrowAmount * p.debtPriceUsd) / 10n ** BigInt(p.debtDecimals);
  const equityUsd = collUsd - debtUsd;

  return {
    ...s,
    expectedDebt: s.borrowAmount,
    expectedLeverageBps: equityUsd > 0n ? (collUsd * BPS) / equityUsd : 0n,
    expectedHealthFactorBps: debtUsd > 0n ? (collUsd * p.liquidationThresholdBps) / debtUsd : 0n,
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/strategies-sdk/sizing.test.ts`
Expected: PASS (all Task 5 tests plus 11 new ones).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/strategies-sdk/sizing.ts src/lib/strategies-sdk/sizing.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategies-sdk/sizing.ts src/lib/strategies-sdk/sizing.test.ts
git commit -m "feat(sdk): sizeOpen for the collateral-margin flow"
```

---

### Task 7: `sizeOpen` — debt-margin flow

**Files:**
- Modify: `src/lib/strategies-sdk/sizing.ts`
- Modify: `src/lib/strategies-sdk/sizing.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 5 and 6. No new exported names — this branches the existing `sizeOpen` on `p.marginIn === "debt"` and reuses `finish`.

Background — the debt-margin flow (`openWithDebtMargin`, UX modes 2 and 3). The contract pulls margin `M` in the **debt** asset, flash-borrows `supplyAmount` of collateral, supplies it, borrows `B`, then swaps `B + M` into collateral. So the margin is spent inside the swap rather than supplied directly, and the whole swap output becomes the position:

```
supplyAmount = L · M · Pdebt / Pcoll          (converted to collateral units)
swapIn       = ceil(supplyAmount · WAD / effRate)
borrowAmount = swapIn − M
expectedOut  = swapIn · rateWad / WAD
minOut       = max(supplyAmount, expectedOut · (1 − slippage))
collateral   = expectedOut                    (flash is repaid out of the output)
debt         = borrowAmount
```

`borrowAmount` is `swapIn − M`, which can come out zero or negative — a `LEVERAGE_TOO_LOW` rejection, not a clamp, since the contract reverts `ZeroAmount` on a zero borrow. Note *when* that actually happens: at the oracle-implied rate the borrow works out to `(L − 1) · M`, which stays positive for any leverage above 1x. The guard fires when the quoted rate **beats** the oracle rate enough that the margin alone covers the swap input — a stale oracle against a favorable market, not merely low leverage.

Worked example used by the test: 5000 USDC margin at 3x, WETH at $2500 → `supplyAmount` = 6 WETH ($15000 exposure from $5000 equity).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/strategies-sdk/sizing.test.ts`:

```ts
const debtMargin: SizeOpenInput = {
  marginIn: "debt",
  marginAmount: 5_000_000_000n, // 5000 USDC
  leverageBps: 30_000n, // 3.00x
  ...PRICES,
};

it("sizes a 3x debt-margin open, spending the margin inside the swap", () => {
  const s = unwrap(sizeOpen(debtMargin));
  expect(s.flashAmount).toBe(6_000_000_000_000_000_000n); // 6 WETH == $15000 of exposure
  expect(s.borrowAmount).toBe(10_075_376_885n); // swapIn minus the 5000 USDC margin
  expect(s.expectedSwapOut).toBe(6_030_150_754_000_000_000n);
  expect(s.minOut).toBe(6_000_000_000_230_000_000n);
  expect(s.expectedCollateral).toBe(6_030_150_754_000_000_000n); // the whole swap output
  expect(s.expectedDebt).toBe(10_075_376_885n);
});

it("the debt-margin position lands on the same leverage floor", () => {
  const s = unwrap(sizeOpen(debtMargin));
  expect(s.expectedLeverageBps).toBe(30_150n); // 3.015x
  expect(s.expectedHealthFactorBps).toBe(11_970n);
});

it("the margin is not double-counted: collateral equals the swap output alone", () => {
  const s = unwrap(sizeOpen(debtMargin));
  expect(s.expectedCollateral).toBe(s.expectedSwapOut);
  expect(s.borrowAmount).toBeLessThan(s.borrowAmount + debtMargin.marginAmount);
});

it("sizes correctly when the debt asset is the 18-decimal one (short direction)", () => {
  // Mode 3: USDC collateral (6dp, $1), WETH debt (18dp, $2500), margin held in WETH.
  // One WETH wei is worth 2.5e-9 USDC wei, so rateWad = 2.5e9.
  const s = unwrap(
    sizeOpen({
      marginIn: "debt",
      marginAmount: 10n ** 18n, // 1 WETH
      leverageBps: 20_000n,
      rateWad: 2_500_000_000n,
      collateralPriceUsd: 100_000_000n,
      debtPriceUsd: 250_000_000_000n,
      collateralDecimals: 6,
      debtDecimals: 18,
      ltvBps: 7500n,
      liquidationThresholdBps: 8000n,
      rateBufferBps: 50n,
      slippageBps: 50n,
    }),
  );
  expect(s.flashAmount).toBe(5_000_000_000n); // 2 * $2500 = $5000 of USDC collateral
  expect(s.borrowAmount).toBe(1_010_050_251_256_281_408n); // swapIn minus the 1 WETH margin
  expect(s.expectedCollateral).toBe(5_025_125_628n);
  expect(s.expectedCollateral).toBe(s.expectedSwapOut);
  expect(s.expectedLeverageBps).toBe(20_100n);
});

it("rejects when a market rate better than the oracle leaves nothing to borrow", () => {
  // At low leverage the margin can cover the whole swap input on its own once the quoted rate
  // beats the oracle-implied one. Borrowing zero reverts ZeroAmount on-chain, so reject here.
  // Note a plain low leverage does NOT trigger this: at the oracle rate the borrow is
  // (L-1) * margin, which stays positive for any L above 1.
  const r = sizeOpen({ ...debtMargin, leverageBps: 10_500n, rateWad: 5n * 10n ** 26n });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.error).toBe("LEVERAGE_TOO_LOW");
});

it("accepts a barely-levered debt-margin open, borrowing only the sliver above the margin", () => {
  const s = unwrap(sizeOpen({ ...debtMargin, leverageBps: 10_001n }));
  expect(s.borrowAmount).toBe(25_628_141n); // ~25.6 USDC on a 5000 USDC margin
  expect(s.expectedLeverageBps).toBe(10_051n);
});

it("applies the same guardrails as the collateral-margin flow", () => {
  expect(sizeOpen({ ...debtMargin, marginAmount: 0n }).ok).toBe(false);
  expect(sizeOpen({ ...debtMargin, leverageBps: 39_200n }).ok).toBe(false);
  expect(sizeOpen({ ...debtMargin, debtPriceUsd: 0n }).ok).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/strategies-sdk/sizing.test.ts`
Expected: FAIL — the debt-margin cases produce collateral-margin numbers (`flashAmount` comes back as `10_000_000_000n` rather than `6_000_000_000_000_000_000n`), because `sizeOpen` does not yet branch on `marginIn`.

- [ ] **Step 3: Write the implementation**

In `src/lib/strategies-sdk/sizing.ts`, replace the **tail of `sizeOpen`** — everything from the `// Flash the exposure the margin does not itself provide…` comment and its `const flashAmount = …` line, down to and including the `}` that closes `sizeOpen` — with the branching version below.

Leave untouched: the guard block above it (margin, rate, price, leverage, ceiling, `effRate`), and the `max` and `finish` helpers that follow `sizeOpen` in the file. The final `}` in the block below is `sizeOpen`'s own closing brace.

```ts
  if (p.marginIn === "debt") {
    // Margin is spent inside the swap, so the exposure is the margin's USD value levered up,
    // expressed in collateral units.
    const supplyAmount =
      (p.marginAmount * p.leverageBps * p.debtPriceUsd * 10n ** BigInt(p.collateralDecimals)) /
      (BPS * p.collateralPriceUsd * 10n ** BigInt(p.debtDecimals));
    if (supplyAmount <= 0n) return { ok: false, error: "LEVERAGE_TOO_LOW" };

    const swapIn = ceilDiv(supplyAmount * WAD, effRate);
    // When the quoted rate beats the oracle-implied one, the margin can cover the whole swap
    // input on its own and there is nothing left to borrow. The contract reverts ZeroAmount on
    // a zero borrow, so reject rather than clamp.
    if (swapIn <= p.marginAmount) return { ok: false, error: "LEVERAGE_TOO_LOW" };
    const borrowAmount = swapIn - p.marginAmount;

    const expectedSwapOut = (swapIn * p.rateWad) / WAD;

    return {
      ok: true,
      size: finish(p, {
        flashAmount: supplyAmount,
        borrowAmount,
        expectedSwapOut,
        // The flash is repaid out of the output, so the position is the whole output — the
        // margin is already inside it and must not be added again.
        expectedCollateral: expectedSwapOut,
        minOut: max(supplyAmount, (expectedSwapOut * (BPS - p.slippageBps)) / BPS),
      }),
    };
  }

  // Collateral-margin flow: flash the exposure the margin does not provide, borrow to buy it back.
  const flashAmount = (p.marginAmount * (p.leverageBps - BPS)) / BPS;
  if (flashAmount <= 0n) return { ok: false, error: "LEVERAGE_TOO_LOW" };

  const borrowAmount = ceilDiv(flashAmount * WAD, effRate);
  if (borrowAmount <= 0n) return { ok: false, error: "LEVERAGE_TOO_LOW" };

  const expectedSwapOut = (borrowAmount * p.rateWad) / WAD;
  const expectedCollateral = p.marginAmount + expectedSwapOut;

  return {
    ok: true,
    size: finish(p, {
      flashAmount,
      borrowAmount,
      expectedSwapOut,
      expectedCollateral,
      minOut: max(flashAmount, (expectedSwapOut * (BPS - p.slippageBps)) / BPS),
    }),
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/strategies-sdk/sizing.test.ts`
Expected: PASS — all Task 5, 6 and 7 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/strategies-sdk/sizing.ts src/lib/strategies-sdk/sizing.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategies-sdk/sizing.ts src/lib/strategies-sdk/sizing.test.ts
git commit -m "feat(sdk): sizeOpen for the debt-margin flow"
```

---

### Task 8: Barrel export and removal of the old SDK

**Files:**
- Create: `src/lib/strategies-sdk/index.ts`
- Delete: `src/lib/leverage-sdk/` (all 11 files)

**Interfaces:**
- Produces: `src/lib/strategies-sdk` as an importable module re-exporting all five modules.

Background: `src/lib/leverage-sdk/` is imported by nothing in the app — the grep in Step 2 is the proof, not a formality. If it returns any hit, stop and report rather than deleting.

- [ ] **Step 1: Create the barrel**

Create `src/lib/strategies-sdk/index.ts`:

```ts
export * from "./abi";
export * from "./plan";
export * from "./reads";
export * from "./signatures";
export * from "./sizing";
```

- [ ] **Step 2: Prove the old SDK is orphaned**

Run: `grep -rn "leverage-sdk" src --include='*.ts' --include='*.tsx' | grep -v "src/lib/leverage-sdk/"`
Expected: no output. **If anything prints, stop and report it instead of deleting.**

- [ ] **Step 3: Delete the old SDK**

```bash
git rm -r src/lib/leverage-sdk
```

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `pnpm exec tsc -b && pnpm exec vitest run`
Expected: typecheck clean; every suite green, with the `leverage-sdk` suites gone from the run.

- [ ] **Step 5: Commit**

```bash
git add src/lib/strategies-sdk/index.ts
git commit -m "refactor(sdk): export strategies-sdk and delete the orphaned leverage-sdk"
```

---

### Task 9: Address configuration

**Files:**
- Modify: `src/config/chains.ts`
- Test: `src/config/chains.test.ts` (create)

**Interfaces:**
- Produces: `ChainConfig.aave.strategies?: \`0x${string}\``, `getStrategiesAddress(chainId: number | undefined): \`0x${string}\` | null`.

Background: mirrors the existing `getDeleveragerAddress` exactly, including its `ZERO_ADDRESS` and regex validation. The contract is undeployed, so this returns `null` on every chain today and the future UI hides itself — that is the intended state, not a bug.

Only mainnet (chain 1) gets a `strategies` entry for now; the contract will not be deployed to other chains in this phase, and an unset entry and a missing entry both resolve to `null`.

**Do NOT touch `.env`.** The code reads `import.meta.env.VITE_STRATEGIES_ADDRESS_1` with a `''` fallback, so it builds without any `.env` entry.

- [ ] **Step 1: Write the failing test**

Create `src/config/chains.test.ts`:

```ts
import { expect, it } from "vitest";
import { getStrategiesAddress } from "./chains";

it("returns null when the address is unset", () => {
  // The contract is undeployed, so VITE_STRATEGIES_ADDRESS_1 is empty in every environment
  // this suite runs in.
  expect(getStrategiesAddress(1)).toBeNull();
});

it("returns null for an unknown chain", () => {
  expect(getStrategiesAddress(999999)).toBeNull();
});

it("returns null for an undefined chain id", () => {
  expect(getStrategiesAddress(undefined)).toBeNull();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/config/chains.test.ts`
Expected: FAIL — `getStrategiesAddress` is not exported.

- [ ] **Step 3: Add the config field**

In `src/config/chains.ts`, add `strategies` to the `aave` block of the `ChainConfig` interface, after `deleverager`:

```ts
  aave: {
    poolAddress: `0x${string}`;
    uiPoolDataProvider: `0x${string}`;
    poolAddressesProvider: `0x${string}`;
    wethGateway?: `0x${string}`;
    deleverager?: `0x${string}`;
    strategies?: `0x${string}`;
  };
```

Then in the `CHAIN_CONFIGS[1].aave` object (Ethereum mainnet), add the entry after the `deleverager` line:

```ts
      deleverager: (import.meta.env.VITE_DELEVERAGER_ADDRESS_1 ?? '') as `0x${string}`,
      strategies: (import.meta.env.VITE_STRATEGIES_ADDRESS_1 ?? '') as `0x${string}`,
```

- [ ] **Step 4: Add the accessor**

Append to the end of `src/config/chains.ts`, directly after `getDeleveragerAddress`:

```ts
/** The configured Strategies router for a chain, or null when unset/zero/malformed. */
export function getStrategiesAddress(chainId: number | undefined): `0x${string}` | null {
  const addr = getChainConfig(chainId)?.aave.strategies;
  if (!addr || addr === ZERO_ADDRESS || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  return addr;
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `pnpm exec vitest run src/config/chains.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Document the env var**

In `README.md`, add `VITE_STRATEGIES_ADDRESS_1` to the environment-variable list alongside `VITE_DELEVERAGER_ADDRESS_1`, described as: "AaveV3Strategies router on Ethereum mainnet. Unset until the contract is deployed; while unset, the leveraged-open UI stays hidden." If no such list exists, create a short `## Environment variables` section for it.

- [ ] **Step 7: Typecheck, lint, full suite**

Run: `pnpm exec tsc -b && pnpm exec eslint src/config/chains.ts src/config/chains.test.ts && pnpm exec vitest run`
Expected: all clean and green.

- [ ] **Step 8: Commit**

```bash
git add src/config/chains.ts src/config/chains.test.ts README.md
git commit -m "feat(config): per-chain AaveV3Strategies address with getStrategiesAddress"
```

---

### Task 10: Delete the superseded contracts

**Files:**
- Delete: `contract/src/AaveV3Leverage.sol`, `contract/src/AaveV3Leverager.sol`
- Delete: `contract/test/AaveV3LeverageFork.t.sol`, `contract/test/AaveV3LeveragePayload.t.sol`

Background: `AaveV3Leverage.sol` is superseded by `AaveV3Strategies.sol` and referenced only by the two test suites deleted alongside it. `AaveV3Leverager.sol` is referenced by nothing at all.

**`contract/src/AaveV3Deleverager.sol` stays.** It is deployed at `0x834796774eb472e571b5c21da438069225c2b162`, both deployment scripts import it, and the app's live close flow calls it. It goes only once that flow has migrated to Strategies.

- [ ] **Step 1: Confirm nothing else references the two contracts**

Run: `grep -rn "AaveV3Leverage\b\|AaveV3Leverager\b" contract --include='*.sol' | grep -v "contract/src/AaveV3Leverage.sol\|contract/src/AaveV3Leverager.sol\|contract/test/AaveV3LeverageFork.t.sol\|contract/test/AaveV3LeveragePayload.t.sol"`
Expected: no output. **If anything prints, stop and report it.**

- [ ] **Step 2: Delete the files**

`AaveV3Leverager.sol` is **untracked** — it was never committed, so `git rm` errors on it and it needs a plain `rm`. The other three are tracked.

```bash
git rm contract/src/AaveV3Leverage.sol \
       contract/test/AaveV3LeverageFork.t.sol contract/test/AaveV3LeveragePayload.t.sol
rm contract/src/AaveV3Leverager.sol
```

Verify: `git status --short contract/` should show three staged `D` entries and no remaining `?? contract/src/AaveV3Leverager.sol`.

- [ ] **Step 3: Verify the contracts still build**

Run: `cd contract && forge build`
Expected: compiles clean, with no unresolved imports.

- [ ] **Step 4: Verify the remaining Solidity suites pass**

Run: `cd contract && forge test`
Expected: green. Only `AaveV3DeleveragerFork.t.sol` and `AaveV3StrategiesFork.t.sol` remain.

Note: the fork suites are known to be flaky by a wei or two on unpinned blocks. If a failure is a rounding difference in a fork test rather than a compile or link error, re-run once to confirm, and report it as pre-existing rather than fixing it here.

- [ ] **Step 5: Commit**

The commit records the three tracked deletions; `AaveV3Leverager.sol` simply stops existing on disk, since git never tracked it.

```bash
git commit -m "chore(contract): delete AaveV3Leverage and AaveV3Leverager, superseded by AaveV3Strategies"
```

---

## Done criteria

- `src/lib/strategies-sdk/` exists with six modules and five test suites, all green.
- `src/lib/leverage-sdk/` is gone.
- `getStrategiesAddress` resolves per chain and returns `null` while the contract is undeployed.
- `contract/src/` holds `AaveV3Strategies.sol` and `AaveV3Deleverager.sol` only.
- `pnpm exec tsc -b`, `pnpm exec vitest run`, and `cd contract && forge test` are all clean.
