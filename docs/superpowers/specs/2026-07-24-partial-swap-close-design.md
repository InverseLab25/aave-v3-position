# Close Position — Partial Swap (Return Leftover as Collateral)

Date: 2026-07-24
Status: Approved (design)
Scope: Frontend only — `src/hooks/useDeleverageClose.ts`, `src/components/ClosePositionModal.tsx`

## Problem

The one-click close swaps the user's **entire** collateral balance into the debt
asset and returns everything left over as the **debt asset**. Users would rather
swap only enough collateral to repay the debt (plus a small margin, since debt
accrues) and **keep the remainder as the original collateral token**.

## Key finding

The `AaveV3Deleverager` contract already returns leftover collateral —
`onMorphoFlashLoan` ends with `p.collateral.safeTransferAll(p.user)`
(`contract/src/AaveV3Deleverager.sol:182`). It swaps only what the router
calldata consumes. The 100%-swap behavior comes entirely from the frontend:
`useDeleverageClose.ts` builds the swap for the **full** collateral balance.

Therefore this is a **frontend-only** change. No contract change, no redeploy.

The aggregator adapters (KyberSwap / OpenOcean / Odos) are **exact-input only**
(`getQuote(fromAsset, toAsset, amountIn, ...)`), so "swap only the required
amount" is implemented by sizing a partial `amountIn`, not by an exact-output
swap.

## Decisions

- **Margin:** fixed **0.5%** above the debt (`targetOut = debt × 1005 / 1000`).
- **Leftover destination:** user's **wallet**, as the underlying collateral token
  (the contract's existing behavior — it withdraws the full reserve and returns
  the unused portion). Not re-supplied to Aave.

## Design

### Contract

Unchanged.

### Hook — `useDeleverageClose.ts`

Replace the single full-collateral quote (current steps 3–4) with a two-step
sizing flow. `debt` and `collAmount` (live on-chain wei) are already read at the
current step 2.

1. **Full quote** — quote all compatible adapters at `collAmount`; pick best →
   `bestFull`, `fullOut = BigInt(bestFull.amountOut)`.
2. **Coverage guard** — if `fullOut < debt`, throw
   `'Collateral will not cover the debt (position underwater)'`.
3. **Target** — `targetOut = (debt * 1005n) / 1000n`.
4. **Size the input**:
   - if `targetOut >= fullOut` → `requiredIn = collAmount` (swap all)
   - else `requiredIn = ceilDiv(collAmount * targetOut, fullOut)`, capped at
     `collAmount`
     (`ceilDiv(a, b) = (a + b - 1n) / b`)
5. **Partial quote** — quote all compatible adapters at `requiredIn`; pick best →
   `bestPartial`. If none, fall back to `bestFull` with `requiredIn = collAmount`.
6. **minOut floor** — `minOut = debt`. The swap output MUST cover the debt or the
   contract reverts cleanly with `InsufficientOutput(have, need)` instead of an
   arithmetic underflow when repaying the flash loan. This replaces the previous
   `computeMinOut` slippage-floor logic for the deleverager path.
7. **Build & send** — `adapter.buildTransaction(bestPartial, ...)`; permit,
   simulate, write unchanged. The permit still authorizes the full aToken balance
   (contract withdraws all collateral, returns the unused portion to the wallet).

Logging: note the sized swap, e.g.
`Swapping ~{requiredIn} of {collateral.symbol} to cover the debt; the rest is returned.`

### Modal — `ClosePositionModal.tsx`

Rework the `preview` memo (added earlier) to reflect partial swap, computed
arithmetically from the existing **full-collateral** background quote — no extra
network call. Inputs: `bestQuote` (full), `selectedCollateral.amount`,
`borrowedAsset.amount`/`decimals`.

- `collateralWei = parseUnits(selectedCollateral.amount, collateralDecimals)`
- `fullOut = BigInt(bestQuote.amountOut)` (debt-token wei)
- `debtWei = parseUnits(borrowedAsset.amount, debtDecimals)`
- `covered = fullOut >= debtWei`
- `targetOut = (debtWei * 1005n) / 1000n`
- `requiredIn = targetOut >= fullOut ? collateralWei : ceilDiv(collateralWei * targetOut, fullOut)` (capped at `collateralWei`)
- `collateralReturnedWei = collateralWei - requiredIn`

Panel (covered):

| Row | Value |
|-----|-------|
| Collateral swapped (est.) | `requiredIn` + collateral symbol |
| **Collateral returned (est.)** | `collateralReturnedWei` + collateral symbol (headline, success color) |
| Debt repaid | `borrowedAsset.amount` + debt symbol |
| Route | `bestQuote.aggregator` |

Not covered → existing underwater warning; Execute disabled (`preview?.covered`).
Still quoting → existing "Calculating your output…".

The `formatAmount` helper and `canExecute` gating stay as-is.

## Non-Goals

- Exact-output swaps (adapters don't support them).
- Keeping leftover collateral supplied in Aave (would need a contract change).
- Any change to the same-asset `repayWithATokens` path.

## Testing / Verification

- `pnpm run build` (`tsc -b && vite build`) passes; `eslint` clean on both files.
- Manual: cross-asset close → preview shows collateral swapped vs returned; after
  execution the wallet receives leftover **collateral** (not debt asset) plus at
  most ~0.5% debt-token dust.
- Underwater case → warning, Execute disabled.
- Near-underwater (collateral value ≈ debt) → `requiredIn == collAmount`, behaves
  like the old full-swap path.
