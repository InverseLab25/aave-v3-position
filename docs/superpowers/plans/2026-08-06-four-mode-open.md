# Four-Mode Open Support in AaveV3Strategies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support all four open modes — (long|short) × (holding the volatile asset | holding the stable) — by adding a collateral-margin open flow beside the existing debt-margin flow, sharing one callback leg.

**Architecture:** The four UX modes collapse to two contract flows differing only in which side of the pair the margin arrives on. Flow B (margin in debt asset — modes 2 & 3) already exists as `openPosition`. Flow A (margin in collateral asset — modes 1 & 4) pulls margin at entry and folds it into the supply (`assets + margin`) instead of the swap input; everything downstream (swap of the borrow, flash-floor checks, surplus re-supply, leftover repay-on-behalf) is shared code. A third mode word (`MODE_OPEN_COLL = 2`) routes both open modes to one `_open` leg with a single branch. The mode→flow mapping lives in the FE SDK.

**Tech Stack:** Solidity 0.8.34 + Solady, Foundry mainnet-fork tests, TypeScript + viem + vitest for the SDK mapper.

## Mode map (the contract never knows "long"/"short")

| Mode | Want | Hold | Call | collateral | debtAsset | margin asset |
|---|---|---|---|---|---|---|
| 1 | Long X | X | `openWithCollateralMargin` | X | stable | X (collateral) |
| 2 | Long X | stable | `openWithDebtMargin` | X | stable | stable (debt) |
| 3 | Short X | X | `openWithDebtMargin` | stable | X | X (debt) |
| 4 | Short X | stable | `openWithCollateralMargin` | stable | X | stable (collateral) |

## Global Constraints

- Solidity 0.8.34, `via_ir`, `optimizer_runs = 1_000_000` (existing `contract/foundry.toml`).
- House style for `AaveV3Strategies.sol` (the user's): exact-amount `safeApproveWithRetry` everywhere (NO lazy-max), assembly `_permit`/`_permitZero` helpers stay as-is, `_reserveToken` raw-staticcall getters, old-style `////` banners, `@dev`-only NatSpec.
- Contract commands from `/Users/atarpara/project/defi-route/contract`; fork tests need `RPC_URL`, auto-loaded from `contract/.env` — NEVER read or print `.env`.
- Do NOT modify `AaveV3Leverage.sol`, `AaveV3Deleverager.sol`, `AaveV3Leverager.sol`, their test files, or `script/*`.
- Only `git add` the files each task's commit step names; the working tree has unrelated uncommitted changes.
- pnpm only for FE (`pnpm test -- --run`, `pnpm exec tsc -b`). SDK code: viem only, no React/wagmi.
- Mainnet constants: WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`.

---

### Task 1: Contract — `openWithCollateralMargin` + shared `_open` leg

**Files:**
- Modify: `contract/src/AaveV3Strategies.sol`

**Interfaces:**
- Consumes: existing `openPosition(collateral, debtAsset, supplyAmount, borrowAmount, marginAmount, minOut, router, swapData, delegation)`, `_open(assets, params)`, `OpenParam` struct (mode, user, collateral, debtAsset, router, margin, borrowAmount, minOut, swapData), `MODE_OPEN = 0`, `MODE_CLOSE = 1`.
- Produces (Tasks 2–3 rely on these exact names):
  - `openWithDebtMargin(address collateral, address debtAsset, uint256 supplyAmount, uint256 borrowAmount, uint256 marginAmount, uint256 minOut, address router, bytes swapData, Permit delegation)` — rename of `openPosition`, body unchanged.
  - `openWithCollateralMargin(address collateral, address debtAsset, uint256 flashAmount, uint256 borrowAmount, uint256 marginAmount, uint256 minOut, address router, bytes swapData, Permit delegation)` — total supplied = `flashAmount + marginAmount` (+ surplus).
  - `MODE_OPEN_COLL = 2`.

- [ ] **Step 1: Add the mode constant**

Below `uint256 private constant MODE_CLOSE = 1;` add:

```solidity
    /// @dev Flow A: margin arrives in the collateral asset and joins the flash in one supply.
    uint256 private constant MODE_OPEN_COLL = 2;
```

- [ ] **Step 2: Rename `openPosition` → `openWithDebtMargin`**

Only the function name changes (declaration only — no internal callers exist). Update its `@dev` first line to: `/// @dev Flow B (modes 2 & 3): margin arrives in the DEBT asset and joins the borrow in the swap.` followed by the existing text.

- [ ] **Step 3: Add the new entry point**

Insert directly after `openWithDebtMargin`:

```solidity
    /// @dev Flow A (modes 1 & 4): margin arrives in the COLLATERAL asset, so it needs no swap —
    /// it joins the flash-borrowed collateral in one supply. Total supplied for the caller is
    /// `flashAmount + marginAmount` (plus any swap surplus). The borrow is swapped back into
    /// collateral to repay the flash; output must cover both `minOut` and `flashAmount`.
    /// `delegation.amount` must cover `borrowAmount`.
    function openWithCollateralMargin(
        address collateral,
        address debtAsset,
        uint256 flashAmount,
        uint256 borrowAmount,
        uint256 marginAmount,
        uint256 minOut,
        address router,
        bytes calldata swapData,
        Permit calldata delegation
    ) external {
        _preflight(collateral, debtAsset, router);
        if (flashAmount == 0 || borrowAmount == 0 || marginAmount == 0 || minOut == 0) revert ZeroAmount();

        // Margin is already the right asset — pull it here, supply it with the flash in the callback.
        collateral.safeTransferFrom(msg.sender, address(this), marginAmount);

        if (delegation.amount != 0) {
            ICreditDelegationToken(_reserveToken(GET_RESERVE_VDEBT_SEL, debtAsset)).delegationWithSig(
                msg.sender,
                address(this),
                delegation.amount,
                delegation.deadline,
                delegation.v,
                delegation.r,
                delegation.s
            );
        }

        _flash(
            collateral,
            flashAmount,
            abi.encode(
                OpenParam({
                    mode: MODE_OPEN_COLL,
                    user: msg.sender, // bound to the caller — the callback can never act for anyone else
                    collateral: collateral,
                    debtAsset: debtAsset,
                    router: router,
                    margin: marginAmount,
                    borrowAmount: borrowAmount,
                    minOut: minOut,
                    swapData: swapData
                })
            )
        );
    }
```

- [ ] **Step 4: Route both open modes through the shared leg**

In `onMorphoFlashLoan`, replace the dispatch:

```solidity
        if (mode == MODE_OPEN) _open(assets, params);
        else _close(assets, params);
```

with:

```solidity
        if (mode == MODE_CLOSE) _close(assets, params);
        else _open(assets, params);
```

- [ ] **Step 5: One branch in `_open`**

In `_open`, replace:

```solidity
        // 1. Supply the flash-borrowed collateral straight to the user's account — the exact
        //    exposure they asked for.
        collateral.safeApproveWithRetry(address(POOL), assets);
        POOL.supply(collateral, assets, user, REFERRAL_NONE);
```

with:

```solidity
        // 1. Supply the flash-borrowed collateral straight to the user's account — the exact
        //    exposure they asked for. Flow A margin is already the collateral asset: it joins
        //    this supply and never touches the swap (Flow B margin is debt-asset and flows
        //    into the swap input below via balanceOf).
        uint256 supplyTotal = assets;
        if (p.mode == MODE_OPEN_COLL) supplyTotal += p.margin;

        collateral.safeApproveWithRetry(address(POOL), supplyTotal);
        POOL.supply(collateral, supplyTotal, user, REFERRAL_NONE);
```

And update the event emission at the end of `_open` from `assets + surplus` to `supplyTotal + surplus`:

```solidity
        emit PositionOpened(user, collateral, debtAsset, p.margin, supplyTotal + surplus, debtBorrowed);
```

- [ ] **Step 6: Build**

Run: `cd /Users/atarpara/project/defi-route/contract && forge build`
Expected: compile fails ONLY in `test/AaveV3StrategiesFork.t.sol` (call sites still say `openPosition`) — the contract itself must produce no errors. Task 2 fixes the tests; do not commit yet if the build shows contract errors.

- [ ] **Step 7: Commit (contract only)**

```bash
git add contract/src/AaveV3Strategies.sol
git commit -m "feat: openWithCollateralMargin — four-mode open via shared _open leg"
```

---

### Task 2: Fork tests — all four modes exercised

**Files:**
- Modify: `contract/test/AaveV3StrategiesFork.t.sol`

**Interfaces:**
- Consumes: Task 1's `openWithDebtMargin` / `openWithCollateralMargin` signatures, existing harness (`strat`, `router` MockRouterS, `MockRouterFixedPullS`, `_one`, `_signPermit`, `_signRevoke`, `_signDelegation(pk, owner, debtToken, value, deadline)`, `aWeth`, `vDebtUsdc`, setUp position 10 WETH / 1,000 USDC for `user`).
- Produces: fork coverage named per mode; Task 3's SDK mapper mirrors these role assignments.

- [ ] **Step 1: Rename existing call sites**

Mechanical: every `strat.openPosition(` in the file becomes `strat.openWithDebtMargin(` (three sites: `test_Open_ExactSupply_UsdcMargin`, `test_Open_LeftoverUsdcRepaysDebt`, `test_Open_RevertsWhen_ZeroMargin`). Rename `test_Open_ExactSupply_UsdcMargin` → `test_Mode2_LongX_HoldingStable` (it IS mode 2).

- [ ] **Step 2: Add the three missing mode tests + new-entry zero-margin test**

```solidity
    /// @dev Mode 1 — long WETH holding WETH: collateral margin joins the flash in one supply.
    function test_Mode1_LongX_HoldingX() public {
        address openUser = vm.addr(0xB0B);
        uint256 marginWeth = 1 ether;
        uint256 flashWeth = 1 ether;
        uint256 borrowUsdc = 2_000e6;
        uint256 wethOut = 1.005 ether; // swap of the borrow must cover the 1 WETH flash
        deal(WETH, openUser, marginWeth);
        deal(WETH, address(router), wethOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory delegation =
            _signDelegation(0xB0B, openUser, vDebtUsdc, borrowUsdc, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, wethOut));

        vm.prank(openUser);
        IERC20LikeS(WETH).approve(address(strat), marginWeth);
        vm.prank(openUser);
        strat.openWithCollateralMargin(
            WETH, USDC, flashWeth, borrowUsdc, marginWeth, flashWeth, address(router), swapData, delegation
        );

        // Supplied = margin + flash + surplus (0.005), each supply rounding ≤1 wei down.
        assertGe(IERC20LikeS(aWeth).balanceOf(openUser), marginWeth + wethOut - 2, "aWETH short");
        assertApproxEqAbs(IERC20LikeS(vDebtUsdc).balanceOf(openUser), borrowUsdc, 2, "debt mismatch");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
    }

    /// @dev Mode 3 — short WETH holding WETH: same openWithDebtMargin code path, roles swapped
    ///      (USDC is the collateral, WETH is the debt AND the margin asset).
    function test_Mode3_ShortX_HoldingX() public {
        address openUser = vm.addr(0xB0B);
        uint256 flashUsdc = 4_000e6;   // exact USDC exposure supplied
        uint256 borrowWeth = 0.5 ether;
        uint256 marginWeth = 0.5 ether;
        uint256 usdcOut = 4_005e6;     // swap of borrow+margin WETH must cover the flash
        deal(WETH, openUser, marginWeth);
        deal(USDC, address(router), usdcOut);

        (address aUsdc,,) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(USDC);
        (,, address vDebtWeth) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(WETH);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory delegation =
            _signDelegation(0xB0B, openUser, vDebtWeth, borrowWeth, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, usdcOut));

        vm.prank(openUser);
        IERC20LikeS(WETH).approve(address(strat), marginWeth);
        vm.prank(openUser);
        strat.openWithDebtMargin(
            USDC, WETH, flashUsdc, borrowWeth, marginWeth, flashUsdc, address(router), swapData, delegation
        );

        assertGe(IERC20LikeS(aUsdc).balanceOf(openUser), usdcOut - 2, "aUSDC short");
        assertApproxEqAbs(IERC20LikeS(vDebtWeth).balanceOf(openUser), borrowWeth, 2, "WETH debt mismatch");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
    }

    /// @dev Mode 4 — short WETH holding USDC: collateral-margin flow with stable roles.
    function test_Mode4_ShortX_HoldingStable() public {
        address openUser = vm.addr(0xB0B);
        uint256 marginUsdc = 2_000e6;
        uint256 flashUsdc = 2_000e6;
        uint256 borrowWeth = 0.5 ether;
        uint256 usdcOut = 2_005e6;     // swap of the borrowed WETH must cover the USDC flash
        deal(USDC, openUser, marginUsdc);
        deal(USDC, address(router), usdcOut);

        (address aUsdc,,) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(USDC);
        (,, address vDebtWeth) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(WETH);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory delegation =
            _signDelegation(0xB0B, openUser, vDebtWeth, borrowWeth, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, usdcOut));

        vm.prank(openUser);
        IERC20LikeS(USDC).approve(address(strat), marginUsdc);
        vm.prank(openUser);
        strat.openWithCollateralMargin(
            USDC, WETH, flashUsdc, borrowWeth, marginUsdc, flashUsdc, address(router), swapData, delegation
        );

        assertGe(IERC20LikeS(aUsdc).balanceOf(openUser), marginUsdc + usdcOut - 2, "aUSDC short");
        assertApproxEqAbs(IERC20LikeS(vDebtWeth).balanceOf(openUser), borrowWeth, 2, "WETH debt mismatch");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
    }

    /// @dev The collateral-margin entry also requires non-zero margin.
    function test_OpenCollateralMargin_RevertsWhen_ZeroMargin() public {
        AaveV3Strategies.Permit memory z;
        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector);
        strat.openWithCollateralMargin(WETH, USDC, 1 ether, 1e6, 0, 1, address(router), hex"", z);
    }
```

Note: `test_Open_LeftoverUsdcRepaysDebt` (mode 2 variant) already covers the leftover-repay branch shared by all modes; the existing close tests cover closing regardless of mode.

- [ ] **Step 3: Run the Strategies suite**

Run: `cd /Users/atarpara/project/defi-route/contract && forge test --match-contract AaveV3StrategiesForkTest -vv`
Expected: 11 tests PASS (7 existing — one renamed — + 4 new). If an LTV revert appears in mode 3/4 (borrow 0.5 WETH against $4,000 USDC needs WETH ≤ ~$6,100), reduce `borrowWeth` to `0.3 ether` in that test and the delegation to match — do not touch the contract.

- [ ] **Step 4: Full regression**

Run: `cd /Users/atarpara/project/defi-route/contract && forge test`
Expected: all suites pass (old Deleverager 22 + payload 2 + Leverage 31 + Strategies 11 = 66).

- [ ] **Step 5: Commit**

```bash
git add contract/test/AaveV3StrategiesFork.t.sol
git commit -m "test: fork coverage for all four open modes"
```

---

### Task 3: SDK — Strategies ABI + four-mode mapper

**Files:**
- Create: `src/lib/leverage-sdk/strategies.ts`
- Modify: `src/lib/leverage-sdk/index.ts` (append `export * from "./strategies";`)
- Test: `src/lib/leverage-sdk/strategies.test.ts`

**Interfaces:**
- Consumes: Task 1 signatures (exact); `ContractPermit`/`ContractRevoke` and `ZERO_PERMIT` from `./params`; `FULL_CLOSE` from `./abi`.
- Produces:
  - `aaveV3StrategiesAbi` (viem `parseAbi`).
  - `type OpenMode = 1 | 2 | 3 | 4`.
  - `planOpen(p: PlanOpenInput): OpenPlan` where `PlanOpenInput = { mode: OpenMode; volatile: Address; stable: Address; flashAmount: bigint; borrowAmount: bigint; marginAmount: bigint; minOut: bigint; router: Address; swapData: Hex; delegation: ContractPermit }` and `OpenPlan = { functionName: "openWithCollateralMargin" | "openWithDebtMargin"; collateral: Address; debtAsset: Address; marginAsset: Address; args: readonly [...] }` (args in exact ABI order).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/leverage-sdk/strategies.test.ts
import { describe, expect, it } from "vitest";
import { getAbiItem } from "viem";
import { ZERO_PERMIT } from "./params";
import { aaveV3StrategiesAbi, planOpen, type OpenMode } from "./strategies";

const X = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const; // WETH (volatile)
const S = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const; // USDC (stable)
const R = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const;

const base = {
  volatile: X, stable: S, flashAmount: 1n, borrowAmount: 2n, marginAmount: 3n,
  minOut: 4n, router: R, swapData: "0x" as const, delegation: ZERO_PERMIT,
};

it("both open functions exist with 9 inputs", () => {
  for (const name of ["openWithCollateralMargin", "openWithDebtMargin"] as const) {
    const fn = getAbiItem({ abi: aaveV3StrategiesAbi, name });
    expect(fn && "inputs" in fn && fn.inputs).toHaveLength(9);
  }
});

describe("planOpen maps (direction, held asset) onto (function, roles)", () => {
  const table: Array<[OpenMode, string, string, string, string]> = [
    // mode, functionName, collateral, debtAsset, marginAsset
    [1, "openWithCollateralMargin", X, S, X],
    [2, "openWithDebtMargin", X, S, S],
    [3, "openWithDebtMargin", S, X, X],
    [4, "openWithCollateralMargin", S, X, S],
  ];
  for (const [mode, fn, coll, debt, marginAsset] of table) {
    it(`mode ${mode}`, () => {
      const plan = planOpen({ ...base, mode });
      expect(plan.functionName).toBe(fn);
      expect(plan.collateral).toBe(coll);
      expect(plan.debtAsset).toBe(debt);
      expect(plan.marginAsset).toBe(marginAsset);
      expect(plan.args).toEqual([coll, debt, 1n, 2n, 3n, 4n, R, "0x", ZERO_PERMIT]);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run src/lib/leverage-sdk/strategies.test.ts`
Expected: FAIL — module `./strategies` not found.

- [ ] **Step 3: Implement**

```typescript
// src/lib/leverage-sdk/strategies.ts
import { parseAbi, type Address, type Hex } from "viem";
import type { ContractPermit, ContractRevoke } from "./params";

/** ABI of AaveV3Strategies (contract/src/AaveV3Strategies.sol). */
export const aaveV3StrategiesAbi = parseAbi([
  "struct Permit { uint256 amount; uint256 deadline; bytes32 r; bytes32 s; uint8 v; }",
  "struct RevokePermit { uint256 deadline; bytes32 r; bytes32 s; uint8 v; }",
  "function openWithDebtMargin(address collateral, address debtAsset, uint256 supplyAmount, uint256 borrowAmount, uint256 marginAmount, uint256 minOut, address router, bytes swapData, Permit delegation)",
  "function openWithCollateralMargin(address collateral, address debtAsset, uint256 flashAmount, uint256 borrowAmount, uint256 marginAmount, uint256 minOut, address router, bytes swapData, Permit delegation)",
  "function closePositionWithPermit(address collateral, address debtAsset, uint256 collateralToWithdraw, uint256 debtRepay, uint256 minOut, address router, Permit permit, RevokePermit revokePermit, bytes swapData)",
  "function allowedRouters(address router) view returns (bool)",
  "function getAllowedRouters() view returns (address[])",
  "function paused() view returns (uint256)",
  "event PositionOpened(address indexed user, address indexed collateral, address indexed debtAsset, uint256 margin, uint256 collateralSupplied, uint256 debtBorrowed)",
  "event PositionClosed(address indexed user, address indexed collateral, address indexed debtAsset, uint256 debtRepaid, uint256 collateralWithdrawn, uint256 returnedToUser)",
] as const);

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
  /** Collateral flash-borrowed and supplied (exact exposure component). */
  flashAmount: bigint;
  /** Debt borrowed on the user's credit delegation. */
  borrowAmount: bigint;
  /** Margin pulled from the wallet — in `marginAsset` of the returned plan. */
  marginAmount: bigint;
  /** Swap-output floor; must also cover `flashAmount` (the contract enforces both). */
  minOut: bigint;
  router: Address;
  swapData: Hex;
  delegation: ContractPermit;
}

export interface OpenPlan {
  functionName: "openWithCollateralMargin" | "openWithDebtMargin";
  collateral: Address;
  debtAsset: Address;
  /** What the wallet must have approved (and holds): tells the FE which allowance to check. */
  marginAsset: Address;
  args: readonly [Address, Address, bigint, bigint, bigint, bigint, Address, Hex, ContractPermit];
}

/** Maps a UX mode onto the contract call: which entry point, and which asset plays which role. */
export function planOpen(p: PlanOpenInput): OpenPlan {
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

export type { ContractPermit, ContractRevoke };
```

Append to `src/lib/leverage-sdk/index.ts`: `export * from "./strategies";`

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test -- --run src/lib/leverage-sdk/ && pnpm exec tsc -b`
Expected: all SDK tests PASS (5 new), tsc clean. Note: `./abi`'s `parseAbi` names (`Permit` with `value`) belong to AaveV3Leverage and stay untouched — the two ABIs coexist; only `strategies.ts` describes AaveV3Strategies.

- [ ] **Step 5: Commit**

```bash
git add src/lib/leverage-sdk/
git commit -m "feat(sdk): AaveV3Strategies ABI and four-mode open planner"
```

---

## Explicitly out of scope

- Choosing which contract ships (Leverage vs Strategies) and retiring the loser + pointing `abi.ts`/`params.ts` at the winner.
- FE hook/UI for mode selection; sizing math for `borrowAmount` headroom (existing `maxSafeCollateralWithdraw` covers closes only).
- Third-asset margin (holding DAI while trading WETH/USDC) — rejected earlier, still out.
