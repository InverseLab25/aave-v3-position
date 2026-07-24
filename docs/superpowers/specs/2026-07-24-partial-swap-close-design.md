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
- **Router transparency:** the preview surfaces the router's **guaranteed minimum
  debt-out** and the **collateral amount-in**, so the user reviews the actual swap
  numbers before signing.
- **Gating when router-min < debt:** show a warning, keep Execute **enabled** —
  the user decides. `minOut = debt` on-chain keeps funds safe (clean revert).

## Design

### Contract

Unchanged.

### Hook — `useDeleverageClose.ts`

Extract the resolve-balances-size-quote logic into a shared, read-only
`buildPlan(input, logFn?)` used by **both** a new `preview()` and `close()`, so
the numbers the user sees are the numbers that execute (single source of truth).

`buildPlan` returns a `ClosePlan`:

1. **Full quote** — quote all compatible adapters at live `collAmount`; pick best
   → `bestFull`, `fullOut = BigInt(bestFull.amountOut)`.
2. **Coverage** — `covered = fullOut >= debt`. Not thrown here; surfaced on the
   plan so `preview()` can warn and `close()` can throw.
3. **Target** — `targetOut = (debt * 1005n) / 1000n` (0.5% margin).
4. **Size the input**:
   - if `!covered || targetOut >= fullOut` → `requiredIn = collAmount` (swap all)
   - else `requiredIn = ceilDiv(collAmount * targetOut, fullOut)`
     (`ceilDiv(a, b) = (a + b - 1n) / b`)
5. **Partial quote** — quote all adapters at `requiredIn`; pick `best`. Fall back
   to `bestFull` if none.
6. **Router min** — `expectedOut = BigInt(best.amountOut)`;
   `minDebtOut = expectedOut * (10000 - slippageBps) / 10000` (the router's baked-in
   minimum return); `guaranteed = covered && minDebtOut >= debt`.

`preview(input)` maps a `ClosePlan` to a `ClosePreview` (formatted strings): the
collateral swapped / returned, debt to repay, **router min debt out**, expected
debt out, aggregator, `covered`, `guaranteed`, and returned-collateral USD.
Returns `null` on any error.

`close(input)` calls `buildPlan(input, log)`; throws if `!covered`; then:
- **minOut floor** — `minOut = debt`. The swap output MUST cover the debt or the
  contract reverts cleanly with `InsufficientOutput(have, need)` instead of an
  arithmetic underflow when repaying the flash loan. `minOut = debt` is a snapshot
  read a moment before execution; the contract flash-loans the debt it reads fresh
  on-chain, so in the tiny accrual window a shortfall may surface as an underflow
  panic rather than `InsufficientOutput` — funds are safe either way (the tx
  reverts), and the 0.5% output margin keeps this window practically unreachable.
- **Build & send** — `adapter.buildTransaction(best, ...)`; permit, simulate,
  write unchanged. The permit still authorizes the full aToken balance (contract
  withdraws all collateral, returns the unused portion to the wallet).

### Modal — `ClosePositionModal.tsx`

Replace the modal's own adapter-quote effect + `preview` memo with a debounced
call to the hook's `preview()` (real router numbers, no signature). State:
`preview: ClosePreview | null`, `isQuoting: boolean`. The reset lives inside the
async body (no synchronous setState in the effect).

Panel (covered):

| Row | Value |
|-----|-------|
| Collateral in (to swap) | `preview.collateralSwapped` + collateral symbol |
| Debt to repay | `preview.debtRepaid` + debt symbol |
| Min debt out (router) | `preview.minDebtOut` + debt symbol (green if `guaranteed`, red if not) |
| **Collateral returned (est.)** | `preview.collateralReturned` + collateral symbol (headline, success color) |
| Route | `preview.aggregator` |

When `covered && !guaranteed` (router-guaranteed min < debt at this slippage):
show an inline warning that the close **may revert** and to lower slippage, but
keep Execute **enabled** — the user decides. Execute is disabled only when not
covered (underwater), still quoting, or no preview.

Not covered → underwater warning. Still quoting → "Calculating your output…".

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
