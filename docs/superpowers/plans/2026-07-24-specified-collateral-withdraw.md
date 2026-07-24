# Specified Collateral Withdraw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the deleverager withdraw only the collateral the swap needs and leave the remainder supplied in Aave, instead of withdrawing everything to the wallet.

**Architecture:** Add an explicit `collateralToWithdraw` amount to `closePositionWithPermit`. The contract pulls exactly that many aTokens, withdraws them (`withdraw` MAX against its own holdings for rebase-safety), and swaps them; a `type(uint256).max` sentinel preserves the current full-drain path. The frontend sizes `collateralToWithdraw = requiredIn + tiny cushion`, drops the permit rebase buffer, and flips the preview wording to "stays supplied in Aave".

**Tech Stack:** Solidity 0.8.34 / Foundry (fork tests) for the contract; React + viem + wagmi + TypeScript for the frontend.

## Global Constraints

- Contract solc: `0.8.34`; libs are Solady + forge-std (already vendored).
- Debt is **always fully repaid**; this feature only changes how much *collateral* is withdrawn.
- Function arg order (must match across contract, both ABIs, and hook): `closePositionWithPermit(collateral, debtAsset, collateralToWithdraw, minOut, router, swapData, permit)`.
- Cushion formula (verbatim): `cushion = max(2n, requiredIn / 100_000n)` (≈0.001%, ≥2 wei).
- Sentinel: `collateralToWithdraw == type(uint256).max` → drain the full aToken balance (prior behavior).
- Fork tests require an Ethereum mainnet RPC: run with `RPC_URL=<endpoint>`. Block is pinned via `foundry.toml` / `FORK_BLOCK` (default `20_800_000`).
- Frontend verification is `pnpm build` (`tsc -b && vite build`) + `pnpm lint` (eslint clean) — there is no unit-test harness for these files.

---

### Task 1: Contract — `collateralToWithdraw` param + partial-withdraw callback

**Files:**
- Modify: `contract/src/AaveV3Deleverager.sol`
- Test: `contract/test/AaveV3DeleveragerFork.t.sol`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `closePositionWithPermit(address collateral, address debtAsset, uint256 collateralToWithdraw, uint256 minOut, address router, bytes swapData, Permit permit)`. `CloseParams` gains a `uint256 collateralToWithdraw` field (positioned after `debtAsset`).

- [ ] **Step 1: Write the failing tests** — update the existing full-close call to the new 7-arg signature (pass the sentinel) and add a partial-withdraw test.

In `contract/test/AaveV3DeleveragerFork.t.sol`, change the existing close call inside `test_ClosePositionWithPermit_ClosesDebtAndReturnsExcess`:

```solidity
        // minOut floor = the debt itself (what the frontend passes). Sentinel = drain all.
        vm.prank(user);
        deleverager.closePositionWithPermit(WETH, USDC, type(uint256).max, debt, address(router), swapData, permit);
```

Then add this new test after it:

```solidity
    /// @dev Partial withdraw: repay full debt but only pull ~1 WETH of collateral; the remaining
    ///      ~9 WETH must stay supplied in Aave (aToken balance retained).
    function test_ClosePositionWithPermit_PartialWithdraw_LeavesRestSupplied() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        assertGt(debt, 0, "no debt set up");

        uint256 debtOut = debt + 50e6;
        deal(USDC, address(router), debtOut);

        uint256 collBefore = IERC20Like(aWeth).balanceOf(user);
        uint256 collateralToWithdraw = 1 ether; // withdraw ~1 WETH; ~9 WETH stays supplied

        uint256 deadline = block.timestamp + 1200;
        // Fixed-amount pull → permit value is the exact amount, no rebase buffer.
        AaveV3Deleverager.Permit memory permit =
            _signPermit(user, address(deleverager), collateralToWithdraw, deadline);

        bytes memory swapData = abi.encodeCall(MockRouter.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        deleverager.closePositionWithPermit(WETH, USDC, collateralToWithdraw, debt, address(router), swapData, permit);

        // Full debt repaid.
        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
        // The remainder is still supplied in Aave (~9 WETH aToken).
        assertApproxEqAbs(
            IERC20Like(aWeth).balanceOf(user), collBefore - collateralToWithdraw, 1e12, "remainder not left supplied"
        );
        // Nothing stuck in the deleverager.
        assertEq(IERC20Like(USDC).balanceOf(address(deleverager)), 0, "USDC stuck in contract");
        assertLt(IERC20Like(WETH).balanceOf(address(deleverager)), 1e12, "WETH stuck in contract");
    }
```

- [ ] **Step 2: Run build to verify it fails**

Run: `cd contract && forge build`
Expected: FAIL — compile error, the 7-arg `closePositionWithPermit` call does not match the contract's current 6-arg signature.

- [ ] **Step 3: Add the param to the struct and entry point**

In `contract/src/AaveV3Deleverager.sol`, add the field to `CloseParams` (after `debtAsset`):

```solidity
    struct CloseParams {
        address user;
        address collateral;
        address debtAsset;
        uint256 collateralToWithdraw;
        uint256 minOut;
        address router;
        Permit permit;
        bytes swapData;
    }
```

Change the entry point signature and the `CloseParams` construction:

```solidity
    function closePositionWithPermit(
        address collateral,
        address debtAsset,
        uint256 collateralToWithdraw,
        uint256 minOut,
        address router,
        bytes calldata swapData,
        Permit calldata permit
    ) external nonReentrant {
        if (paused != 0) revert Paused();

        if (collateral == debtAsset) revert SameAsset();

        (,, address vDebt) = DATA_PROVIDER.getReserveTokensAddresses(debtAsset);
        uint256 debt = vDebt.balanceOf(msg.sender);
        if (debt == 0) revert NoDebt();

        bytes memory data = abi.encode(
            CloseParams({
                user: msg.sender,
                collateral: collateral,
                debtAsset: debtAsset,
                collateralToWithdraw: collateralToWithdraw,
                minOut: minOut,
                router: router,
                permit: permit,
                swapData: swapData
            })
        );

        // Flash loan exact debt amount from Morpho Blue
        MORPHO.flashLoan(debtAsset, debt, data);
    }
```

- [ ] **Step 4: Pull only the requested collateral in the callback**

In `onMorphoFlashLoan`, replace the "Consume Permit & Pull aTokens" block (the `aBal` lines) with:

```solidity
        // 2. Consume Permit & pull the aTokens we intend to swap. Partial close pulls exactly
        //    `collateralToWithdraw` (a fixed amount, so the permit needs no rebase buffer); the
        //    sentinel type(uint256).max pulls the whole balance (full drain, prior behavior).
        //    Anything not pulled stays supplied in Aave.
        if (p.permit.value > 0) {
            IATokenPermit(aToken)
                .permit(p.user, address(this), p.permit.value, p.permit.deadline, p.permit.v, p.permit.r, p.permit.s);
        }

        uint256 pull =
            p.collateralToWithdraw == type(uint256).max ? aToken.balanceOf(p.user) : p.collateralToWithdraw;
        aToken.safeTransferFrom(p.user, address(this), pull);
        // Withdraw MAX against our own holdings: burns exactly the aTokens we just pulled and
        // returns the true underlying amount, immune to rayDiv/rayMul rounding on a fixed amount.
        uint256 collateralAmount = POOL.withdraw(p.collateral, type(uint256).max, address(this));
```

(The swap, output check, flash-loan repay, and `safeTransferAll` sweep below stay exactly as they are.)

- [ ] **Step 5: Run build to verify it compiles**

Run: `cd contract && forge build`
Expected: `Compiler run successful` (Solady `virtual` modifier warnings are fine).

- [ ] **Step 6: Run the fork tests**

Run: `cd contract && RPC_URL=<mainnet-rpc> forge test --match-path 'test/AaveV3DeleveragerFork.t.sol' -vvv`
Expected: PASS — `test_Aave_RejectsMaxRepayOnBehalf`, `test_ClosePositionWithPermit_ClosesDebtAndReturnsExcess` (sentinel/full-drain), and `test_ClosePositionWithPermit_PartialWithdraw_LeavesRestSupplied` all green.
(If no RPC is available, `forge build` passing is the minimum bar; the fork tests must be run before redeploy.)

- [ ] **Step 7: Commit**

```bash
git add contract/src/AaveV3Deleverager.sol contract/test/AaveV3DeleveragerFork.t.sol
git commit -m "feat(contract): specified collateral withdraw, keep rest supplied in Aave"
```

---

### Task 2: Frontend — ABI + hook sizing/permit + preview wording

**Files:**
- Modify: `src/lib/deleverage.ts` (the `DELEVERAGER_ABI` used by the hook)
- Modify: `src/config/deleverageAbi.ts` (parallel `deleveragerAbi`, kept in sync)
- Modify: `src/hooks/useDeleverageClose.ts`
- Modify: `src/components/ClosePositionModal.tsx`

**Interfaces:**
- Consumes: the contract signature from Task 1 — `closePositionWithPermit(collateral, debtAsset, collateralToWithdraw, minOut, router, swapData, permit)`.
- Produces: `ClosePreview` with `collateralKeptSupplied: string` and `collateralKeptSuppliedUsd: number | null` (replacing `collateralReturned` / `collateralReturnedUsd`).

- [ ] **Step 1: Add `collateralToWithdraw` to both ABIs**

In `src/lib/deleverage.ts`, inside the `closePositionWithPermit` `inputs` array, insert after the `debtAsset` entry and before `minOut`:

```typescript
      { name: 'collateralToWithdraw', type: 'uint256' },
```

In `src/config/deleverageAbi.ts`, inside the same function's `inputs`, insert after `debtAsset` and before `minOut`:

```typescript
      { internalType: 'uint256', name: 'collateralToWithdraw', type: 'uint256' },
```

- [ ] **Step 2: Size the withdraw and drop the permit rebase buffer in the hook**

In `src/hooks/useDeleverageClose.ts`, in `close()`, replace the `minOut` line and the `permitValue` line. Find:

```typescript
        const minOut = p.debt
```

Replace with:

```typescript
        const minOut = p.debt
        // Withdraw only the collateral the swap needs, plus a tiny cushion so a 1-wei aToken
        // rounding never leaves the router short. If the swap needs (nearly) all the collateral,
        // fall back to the full-drain sentinel. Everything not withdrawn stays supplied in Aave.
        const MAX_UINT256 = (1n << 256n) - 1n
        const cushion = p.requiredIn / 100_000n > 2n ? p.requiredIn / 100_000n : 2n
        const drainAll = p.requiredIn + cushion >= p.collAmount
        const collateralToWithdraw = drainAll ? MAX_UINT256 : p.requiredIn + cushion
```

Then find:

```typescript
        const permitValue = p.collAmount + p.collAmount / 100n
```

Replace with:

```typescript
        // Full drain pulls the live (rebasing) balance so keep the +1% buffer; a fixed partial
        // pull needs no buffer — the permit value is exactly what we pull.
        const permitValue = drainAll ? p.collAmount + p.collAmount / 100n : collateralToWithdraw
```

- [ ] **Step 3: Pass the new arg into the close call**

In the same file, find the `simulateContract` args array:

```typescript
          args: [p.collateralAddr, p.debtAddr, minOut, router, swapData, { value: permitValue, deadline, v, r: sig.r, s: sig.s }],
```

Replace with:

```typescript
          args: [p.collateralAddr, p.debtAddr, collateralToWithdraw, minOut, router, swapData, { value: permitValue, deadline, v, r: sig.r, s: sig.s }],
```

- [ ] **Step 4: Rename the preview field in the `ClosePreview` interface**

In `src/hooks/useDeleverageClose.ts`, in the `ClosePreview` interface, replace:

```typescript
  collateralReturned: string
```
with
```typescript
  collateralKeptSupplied: string
```
and replace:
```typescript
  collateralReturnedUsd: number | null
```
with
```typescript
  collateralKeptSuppliedUsd: number | null
```

- [ ] **Step 5: Update the `preview()` computation to the renamed field**

In `preview()`, replace:

```typescript
        const collateralReturnedWei = p.collAmount - p.requiredIn
        const collateralPrice = Number(input.collateral.priceInUsd ?? 0)
        const collateralReturnedUsd =
          collateralPrice > 0
            ? Number(formatUnits(collateralReturnedWei, cDec)) * collateralPrice
            : null
```

with:

```typescript
        // The collateral the swap does NOT consume is never withdrawn — it stays supplied in Aave.
        const collateralKeptSuppliedWei = p.collAmount - p.requiredIn
        const collateralPrice = Number(input.collateral.priceInUsd ?? 0)
        const collateralKeptSuppliedUsd =
          collateralPrice > 0
            ? Number(formatUnits(collateralKeptSuppliedWei, cDec)) * collateralPrice
            : null
```

Then in the returned object, replace:

```typescript
          collateralReturned: formatUnits(collateralReturnedWei, cDec),
```
with
```typescript
          collateralKeptSupplied: formatUnits(collateralKeptSuppliedWei, cDec),
```
and replace:
```typescript
          collateralReturnedUsd,
```
with
```typescript
          collateralKeptSuppliedUsd,
```

- [ ] **Step 6: Flip the modal wording**

In `src/components/ClosePositionModal.tsx`, replace the "Collateral returned" row label:

```tsx
                    <span className="info-row-label" style={{ fontWeight: 600 }}>Collateral returned (est.)</span>
```
with
```tsx
                    <span className="info-row-label" style={{ fontWeight: 600 }}>Stays supplied in Aave (est.)</span>
```

Replace the value block:

```tsx
                      {formatAmount(preview.collateralReturned)} {preview.collateralSymbol}
                      {preview.collateralReturnedUsd != null ? ` (~$${preview.collateralReturnedUsd.toFixed(2)})` : ''}
```
with
```tsx
                      {formatAmount(preview.collateralKeptSupplied)} {preview.collateralSymbol}
                      {preview.collateralKeptSuppliedUsd != null ? ` (~$${preview.collateralKeptSuppliedUsd.toFixed(2)})` : ''}
```

Replace the helper sentence:

```tsx
                    Only enough {preview.collateralSymbol} is swapped to repay the debt (+0.5% margin); the rest is returned to your wallet as {preview.collateralSymbol}. Estimated from your live balances.
```
with
```tsx
                    Only enough {preview.collateralSymbol} is swapped to repay the debt (+0.5% margin); the rest stays supplied in Aave. Estimated from your live balances.
```

- [ ] **Step 7: Build**

Run: `pnpm build`
Expected: `tsc -b && vite build` completes with no type errors (no lingering references to `collateralReturned` / `collateralReturnedUsd`).

- [ ] **Step 8: Lint**

Run: `pnpm lint`
Expected: clean, no errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/deleverage.ts src/config/deleverageAbi.ts src/hooks/useDeleverageClose.ts src/components/ClosePositionModal.tsx
git commit -m "feat(frontend): specified collateral withdraw — size withdraw, keep rest supplied, update preview"
```

---

## Post-implementation (manual, out of plan scope)

- Redeploy `AaveV3Deleverager` (`forge script script/Deploy.s.sol --broadcast`) and update `VITE_DELEVERAGER_ADDRESS_1` in `.env` with the new address, then restart the dev server. (Signature changed → the redeploy is required for the new ABI.)
