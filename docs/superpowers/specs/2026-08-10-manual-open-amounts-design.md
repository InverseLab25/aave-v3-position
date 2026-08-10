# Manual amount entry for opening leveraged positions

**Date:** 2026-08-10
**Status:** Approved (pending spec review)

## Problem

`AaveV3Strategies.sol` already accepts all three amounts that define a leveraged open, explicitly:

| Concept | Contract parameter | Entry point |
|---|---|---|
| What the user contributes | `marginAmount` | both |
| Borrowed from Aave | `borrowAmount` | both |
| Flash-loaned from Morpho | `supplyAmount` (`openWithDebtMargin:265`) / `flashAmount` (`openWithCollateralMargin:322`) | both |

The frontend exposes only one of them. `src/lib/strategies-sdk/sizing.ts`'s `sizeOpen` derives `flashAmount` and `borrowAmount` from `marginAmount` × `leverageBps`, so the UI is a single amount field plus a leverage slider. Users who want a specific borrow or a specific flash size cannot express it, and the ratchet path the contract supports (`marginAmount == 0`, `AaveV3Strategies.sol:334`) is unreachable from the UI entirely.

This spec covers exposing all three amounts, gated behind an opt-in override, and adding the no-margin ratchet mode.

## Approved decisions

| Decision | Choice |
|---|---|
| Mode axis | **Margin location**: margin-in-collateral / margin-in-debt / no-margin (ratchet) |
| Direction | **Keep the existing Long/Short toggle** as a separate axis; it continues to pick the volatile/stable pair |
| Entry model | **Derived by default, unlock to override.** Slider stays the default path; a checkbox unlocks Debt and Flash, pre-filled with what `sizeOpen` computed |
| Validation | **Live re-quote and block.** If projected swap output cannot cover the flash, disable Open and show the shortfall plus a suggested debt amount |
| Wiring | **Discriminated union on `OpenInput`** (approach A), one hook, one component tree |
| Surface | **Extends the existing Open tab in place**, not a separate advanced screen |

## Architecture

### `OpenInput` gains a discriminated `sizing` field

Replacing today's flat `marginAmount` + `leverageBps`:

```ts
type OpenSizing =
  | { kind: 'derived'; marginAmount: bigint; leverageBps: bigint }
  | { kind: 'manual';  marginAmount: bigint; borrowAmount: bigint; flashAmount: bigint }
```

`marginIn` continues to come from `mode` via `resolveMode` (`plan.ts:79`), so the margin-location axis needs no new plumbing. It gains a third value, `'none'`.

**On the name `flashAmount`.** The contract calls the same quantity `supplyAmount` on the debt-margin path and `flashAmount` on the collateral-margin path, but it is one thing in both: the amount flash-borrowed from Morpho, denominated in the **collateral** asset. `OpenSizing` uses `flashAmount` throughout, and `planOpen` maps it to whichever parameter name the chosen entry point uses. The UI's "Flash" field is always collateral-denominated, on every mode.

### The hook branches once

`useStrategiesOpen.ts:245` currently runs a **quote → re-size → re-quote** refine loop, because `sizeOpen` needs a swap rate that is not known until a quote comes back. The branch goes immediately before that loop:

- **`derived`** — unchanged. Seed from the oracle rate, quote, re-size, re-quote, up to `MAX_REFINE_ROUNDS`.
- **`manual`** — skip `sizeOpen` entirely. `swapIn = borrowAmount + (marginIn === 'debt' ? marginAmount : 0n)` is already the expression at `useStrategiesOpen.ts:241`, and on this path it is a constant. One quote round, rank adapters, done.

The manual path is strictly simpler: with `amountIn` fixed by the user there is nothing to converge on.

`planOpen` is untouched — it already takes the three amounts explicitly (`plan.ts:95`), so both paths converge on identical call-building. Approval, credit delegation and `writeContract` are shared verbatim.

`inputKey` (`useStrategiesOpen.ts:115`) extends to serialize the union tag and its members, so a manual-amount edit invalidates a stale preview by value exactly as a slider drag does today.

`sizeOpen`'s error codes (`ZERO_MARGIN`, `LEVERAGE_ABOVE_LTV`, …) do not apply on the manual path. Manual has its own validation set; `sizeOpenErrorMessage` is not reused there.

### Mode numbering

`resolveMode` (`plan.ts:84`) rejects anything outside 1–4. Ratchet adds:

| Mode | Direction | Margin | Entry point |
|---|---|---|---|
| 5 | long | none | `openWithCollateralMargin`, `marginAmount = 0` |
| 6 | short | none | `openWithCollateralMargin`, `marginAmount = 0` |

`openWithCollateralMargin` is the right entry point for both: with zero margin the flash alone becomes the supply and no pre-swap is needed, which is what `AaveV3Strategies.sol:334` describes.

## Layout

```
 ACTIONS   [ Open ]  Boost   Repay
 ─────────────────────────────────────────────
  Long     Collateralize WETH, borrow USDC.
  Short
 ─────────────────────────────────────────────
  Margin in   (•) Collateral   ( ) Debt   ( ) None — ratchet

  Supply      [ 1.0          ] WETH    bal 2.4  [Max]
  Leverage    [======O───────] 2.50x

  [ ] Enter amounts manually
  ┄┄┄┄┄ unlocked ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  Debt        [ 2,500        ] USDC    borrow from Aave
  Flash       [ 1.5          ] WETH    flash from Morpho
 ─────────────────────────────────────────────
  2.50x · HF 1.62 · impact 0.12%
  [ Open Position ]
```

Selecting **None** restructures the form rather than zeroing a field: Supply and the Leverage slider unmount, and the manual fields force open and lock (the checkbox disappears). With no margin there is no base for leverage to multiply, so the derived path is not merely unused — it is undefined.

### Files

**New:**

- `src/lib/manualOpen.ts` — pure math and validation, mirroring how `openPlan.ts` and `sizing.ts` are already split away from components. Exports `validateManualOpen()` returning a typed error union, and `projectManualPosition()` returning the resulting `{ leverageBps, healthFactorBps, impliedLtvBps }`.

`projectManualPosition` folds in the account's existing `totalCollateralBase` / `totalDebtBase` on **every** mode, not only ratchet — Aave's health factor is account-wide, so a user opening a second position against existing collateral gets a misleading number otherwise. Ratchet is simply the case where the existing position is the *only* contribution to equity. `leverageBps` is reported as `null` for ratchet, since equity added is ~zero and the ratio is meaningless.
- `src/components/ManualAmounts.tsx` — the Debt/Flash pair and the shortfall banner.

**Changed:**

- `src/components/LeverageActions.tsx` — gains `marginIn` and manual-entry state, assembles the `sizing` union. Sizing-state assembly moves into a `useOpenSizing()` hook rather than growing inline; the component is already 271 lines and juggles direction, margin location, sizing, quoting and execution state.
- `src/components/OpenPositionForm.tsx` — conditional slider, advanced checkbox.
- `src/components/PositionPreview.tsx` — labels leverage as *resulting* rather than *requested* on the manual path.
- `src/hooks/useStrategiesOpen.ts` — the union branch and `inputKey` extension.
- `src/lib/strategies-sdk/plan.ts` — modes 5 and 6, `marginIn: 'none'`.

## Validation

`validateManualOpen()` returns the first failing check, in this order:

| Code | Trigger | Message |
|---|---|---|
| `ZERO_FLASH` / `ZERO_BORROW` | either is 0 | mirrors the contract's `ZeroAmount` guard (`:274`, `:331`) |
| `MARGIN_EXCEEDS_BALANCE` | supply > wallet balance | states the available balance |
| `RATCHET_NO_POSITION` | mode 5/6 and `totalCollateralBase == 0` | ratchet needs collateral already supplied |
| `SWAP_SHORTFALL` | projected `amountOut < flashAmount` | shortfall plus suggested debt |
| `LTV_EXCEEDED` | implied LTV ≥ reserve LTV | Aave's `borrow` reverts at the wall |

**Suggested debt** comes from the live quote's realized rate, not the oracle: `neededSwapIn = flashAmount * amountIn / amountOut`, minus `marginAmount` on the debt path, padded by `slippageBps`. Using the quote's own rate means the suggestion clears on the next attempt.

**Quoting is debounced 400ms** on amount edits. The hook's existing `cancelled` flag (`useStrategiesOpen.ts:204`) discards in-flight results, so a fast typist cannot land a stale preview.

**`minOut` semantics are unchanged** — still slippage-derived through `minOutFromBuild` (`openPlan.ts:85`). When the slippage-derived `minOut` falls below `flashAmount`, the effective floor is `flashAmount`, because `AaveV3Strategies.sol:502` reverts independently of `minOut`. The UI gate surfaces that; the contract check remains the backstop.

**Execution-time errors keep the existing path.** A quote can move between preview and send, so `InsufficientOutputForFlashLoanRepayment` stays handled by `decodeStrategiesError` with its `requote` remedy. The UI gate reduces those; it does not replace them.

## Testing

- **`src/lib/manualOpen.test.ts`** (new) — validation ordering, suggested-debt arithmetic, and `projectManualPosition` folding the existing position for ratchet. Pure, no mocks.
- **`src/lib/strategies-sdk/plan.test.ts:24`** — extend the mode→entry-point table with rows 5 and 6; `planOpen rejects an out-of-range mode` moves to 7.
- **`src/lib/strategies-sdk/plan-sizing.test.ts:50`** — add modes 5/6 asserting `marginIn: 'none'`. This file exists to catch a transposed mode, so it grows with the mode set.
- **`useStrategiesOpen`** — assert the manual path issues exactly **one** quote round with no re-size. That is the behavioral difference from derived, and the thing a future refactor would silently break.
- **`src/components/ManualAmounts.test.tsx`** (new) — shortfall banner renders the shortfall and disables Open.
- **`src/components/LeverageActions.test.tsx`** — selecting None unmounts the slider and forces the manual fields open.

## Cleanup carried into implementation

A temporary patch at `src/components/LeverageActions.tsx:119` removes the `!contract` render gate, applied earlier for a local preview of the panel with a null strategies address. It is reverted as part of this work, restoring `renders nothing while the contract is undeployed` (`LeverageActions.test.tsx:95`).

Baseline before this work: 204 tests passing.

## Out of scope

- The Boost and Repay tabs remain disabled placeholders.
- Explicit collateral/debt asset pickers. Direction continues to auto-pick the first volatile reserve against the first stable one; the Long/Short toggle is the only pair control.
- Any change to the close path or `AaveV3Deleverager`.
- Any contract change. `AaveV3Strategies.sol` already supports everything here.
