# Specified Collateral Withdraw — Design

**Date:** 2026-07-24
**Status:** Approved
**Component:** `contract/src/AaveV3Deleverager.sol`, `src/hooks/useDeleverageClose.ts`, `src/config/deleverageAbi.ts`, `src/components/ClosePositionModal.tsx`

## Problem

The deleverager fully closes a position: it repays all debt, pulls the user's **entire** aToken balance, withdraws **all** collateral (`type(uint256).max`), swaps enough to repay the flash loan, and returns the leftover collateral **to the user's wallet**.

We want the leftover collateral to **stay supplied in Aave** (still earning yield / still collateral) instead of being withdrawn to the wallet. Debt is still repaid in full; only the collateral the swap actually needs is withdrawn.

## Chosen approach (Approach 1)

Add an explicit `collateralToWithdraw` amount to the entry point. The contract pulls exactly that many aTokens, withdraws them, and swaps them. The remaining aTokens are never touched — they stay supplied in Aave.

A sentinel preserves the current full-drain behavior:
- `collateralToWithdraw == type(uint256).max` → pull the full aToken balance and drain (today's behavior).
- `collateralToWithdraw == N` → pull exactly `N`, partial withdraw; the rest stays supplied.

Rejected alternatives:
- **Derive the amount from `permit.value`** — conflates the approval ceiling with intent; loses clarity and the full-drain buffer safety.
- **Withdraw all, then re-supply the remainder** — extra gas (withdraw-all + re-supply) and the full collateral momentarily leaves Aave.

## Interface

```solidity
struct CloseParams {
    address user;
    address collateral;
    address debtAsset;
    uint256 collateralToWithdraw; // NEW: exact aTokens to pull+withdraw; type(uint256).max = drain all
    uint256 minOut;
    address router;
    Permit permit;
    bytes swapData;
}

function closePositionWithPermit(
    address collateral,
    address debtAsset,
    uint256 collateralToWithdraw, // NEW
    uint256 minOut,
    address router,
    bytes calldata swapData,
    Permit calldata permit
) external nonReentrant;
```

## Callback flow (`onMorphoFlashLoan`)

1. **Repay full debt** — unchanged; explicit `assets` repay (per the `NoExplicitAmountToRepayOnBehalf` fix). Collateral is now fully unlocked.
2. **Consume permit, pull only the needed aTokens:**
   ```solidity
   IATokenPermit(aToken).permit(p.user, address(this), p.permit.value, p.permit.deadline, p.permit.v, p.permit.r, p.permit.s);
   uint256 pull = p.collateralToWithdraw == type(uint256).max
       ? aToken.balanceOf(p.user)   // sentinel → full drain
       : p.collateralToWithdraw;    // partial → exact amount
   aToken.safeTransferFrom(p.user, address(this), pull);
   ```
3. **Withdraw with MAX against the contract's own holdings** (rebase-safe, see below):
   ```solidity
   uint256 collateralAmount = POOL.withdraw(p.collateral, type(uint256).max, address(this));
   ```
4. **Swap `collateralAmount` -> debt**, approving the ACTUAL withdrawn amount:
   ```solidity
   p.collateral.safeApproveWithRetry(p.router, collateralAmount);
   (p.router).callContract(p.swapData);
   p.collateral.safeApproveWithRetry(p.router, 0);
   ```
5. **Output check + flash-loan repay** — unchanged (`afterBalance - beforeBalance >= minOut`, approve Morpho `assets`).
6. **Sweep excess** — return excess debt asset + any collateral dust to the wallet via `safeTransferAll`. The large untouched remainder never left Aave.

## Rebase safety audit

aTokens rebase up continuously; the liquidity index grows between quote (T0) and execution (T1). Every aToken touchpoint:

| # | Step | Risk | Mitigation |
|---|------|------|------------|
| 1 | `permit.value` | Today buffered (+1%) because we pull the live full balance. | Partial pulls a **fixed** `collateralToWithdraw`, so `permit.value = collateralToWithdraw` exactly — **no buffer needed**. |
| 2 | `transferFrom(pull)` | Needs `balance ≥ pull`. | `pull` is a fixed amount below the user's balance; index growth only makes the balance larger. Always covers. |
| 3 | `POOL.withdraw(..., max, ...)` | A specified withdraw amount could mismatch aTokens actually received (rayDiv/rayMul ±1 wei). | Withdraw **`type(uint256).max`** = burn exactly whatever the contract holds. No specified number to mismatch → rounding-proof. Returns true `collateralAmount`. |
| 4 | Router approval | Router calldata pulls a **fixed** `requiredIn` baked in at T0; if `collateralAmount < requiredIn` the swap reverts. | Approve the **actual** `collateralAmount`; frontend sizes `collateralToWithdraw` slightly above the swap input (`cushion = max(2 wei, requiredIn / 100_000)`, ≈0.001%) so `collateralAmount ≥ requiredIn` after any 1-wei rounding. |
| 5 | Leftover sweep | — | `safeTransferAll(collateral)` sends the small #4 cushion dust to the wallet. The large remainder stayed supplied. |
| 6 | Debt / flash loan | vDebt rebases. | Unchanged: `assets` read and repaid in the same block, index constant, clears exactly. |

**Residual:** the #4 cushion means a few wei (~0.001% of the *swapped slice*, not the whole position) lands in the wallet instead of staying supplied. Accepted.

## Frontend changes

**`useDeleverageClose.ts` (`close()`):**
- `collateralToWithdraw = requiredIn + cushion`, `cushion = max(2n, requiredIn / 100_000n)`.
- `permit.value = collateralToWithdraw` (drop the `+ collAmount/100n` rebase buffer).
- Pass `collateralToWithdraw` into the new arg slot.
- `minOut = p.debt`; debt/flash-loan path unchanged.

**`deleverageAbi.ts` / `DELEVERAGER_ABI`:** add the `collateralToWithdraw` (uint256) input to `closePositionWithPermit`.

**`ClosePositionModal.tsx` preview (wording flip):** leftover collateral now **stays in Aave**, not the wallet. Rename `ClosePreview.collateralReturned` → `collateralKeptSupplied` (= `collAmount − requiredIn`) and update the row label to "stays supplied in Aave". Wallet-returned collateral is ~0 (dust only).

## Testing (`contract/test/AaveV3DeleveragerFork.t.sol`)

- Update existing calls to pass the new `collateralToWithdraw` arg.
- **New:** `test_ClosePositionWithPermit_PartialWithdraw_LeavesRestSupplied` — supply 10 WETH / borrow 1,000 USDC, pass a partial `collateralToWithdraw` (~0.5 WETH worth), assert:
  - `vDebt.balanceOf(user) == 0` (full debt repaid),
  - `aWETH.balanceOf(user) ≈ 10e18 − collateralToWithdraw` (the rest is still supplied),
  - excess debt returned to wallet, nothing stuck in the contract.
- Keep the sentinel path (`type(uint256).max`) covered → proves full-drain still works.
- Keep `test_Aave_RejectsMaxRepayOnBehalf` (root-cause regression guard).

## Out of scope

- Partial **debt** repayment / keeping the position open at lower leverage (debt is always fully repaid).
- Re-supplying the dust cushion back into Aave.
