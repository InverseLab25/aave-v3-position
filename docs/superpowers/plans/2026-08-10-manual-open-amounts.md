# Manual Open Amounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user enter the margin, borrow and flash amounts of a leveraged open directly instead of only a margin plus a leverage slider, and add the no-margin ratchet mode the contract already supports.

**Architecture:** `OpenInput.sizing` becomes a discriminated union — `derived` keeps today's quote/re-size refine loop, `manual` skips `sizeOpen` entirely and does a single quote round because `amountIn` is fixed by the user. A new pure module `src/lib/manualOpen.ts` owns manual validation and position projection. `planOpen` is unchanged; both paths converge on the same call-building, approval, delegation and execution code.

**Tech Stack:** TypeScript, React, viem, wagmi, Vitest, Testing Library. Package manager is **pnpm**.

**Spec:** `docs/superpowers/specs/2026-08-10-manual-open-amounts-design.md`

## Global Constraints

- Test command is `pnpm exec vitest run`; typecheck is `pnpm exec tsc -b`. Both run **from the repo root** — running from `contract/` silently typechecks the wrong project.
- Baseline before Task 1: 204 tests passing, with **one failure** from an uncommitted temporary patch that Task 1 reverts.
- Solidity is not touched. `AaveV3Strategies.sol` already supports everything here.
- Money is `bigint` end to end. Never convert an amount through `Number` for arithmetic — only for display.
- All USD values are Aave market-reference units: **8 decimals**. `ReserveInfo.priceUsd` (`useAavePositions.ts:312`) and `getUserAccountData`'s `totalCollateralBase`/`totalDebtBase` share this scale, so they compose without conversion.
- `BPS = 10_000n`. Leverage, LTV, liquidation threshold and health factor all use it.
- Comments explain *why*, not *what* — match the density and voice of `sizing.ts` and `openPlan.ts`.
- Commit after every task.

---

### Task 1: Restore the green baseline

A temporary patch from an earlier session removed the `!contract` render gate so the panel could be previewed with an unset strategies address. It must come out before anything else, or every later task inherits a failing test and cannot tell its own regressions apart.

**Files:**
- Modify: `src/components/LeverageActions.tsx:118-120`

**Interfaces:**
- Consumes: nothing.
- Produces: a clean tree with 204 passing tests.

- [ ] **Step 1: Confirm the patch is present and failing**

Run: `pnpm exec vitest run src/components/LeverageActions.test.tsx`
Expected: FAIL — `renders nothing while the contract is undeployed` receives a rendered tree instead of `null`.

- [ ] **Step 2: Revert the patch**

Replace the temporary gate in `src/components/LeverageActions.tsx`:

```tsx
  // The contract is undeployed, or we are looking at someone else's portfolio.
  if (!contract || viewAddress) return null
```

(Removing both the `TEMP` comment line and the `if (viewAddress) return null` that replaced it.)

- [ ] **Step 3: Verify the whole suite is green**

Run: `pnpm exec vitest run`
Expected: PASS, 204 tests.

- [ ] **Step 4: Commit**

```bash
git add src/components/LeverageActions.tsx
git commit -m "revert: restore the undeployed-contract render gate

The gate was removed temporarily to preview the panel against a null
strategies address. Restores LeverageActions.test.tsx:95 to green."
```

---

### Task 2: Ratchet modes 5 and 6

`resolveMode` is the single source of truth both `planOpen` and the sizing hook consume, so the mode set widens here first and everything downstream reads it.

**Files:**
- Modify: `src/lib/strategies-sdk/sizing.ts:43` (add `MarginLocation`)
- Modify: `src/lib/strategies-sdk/plan.ts:5-11,63-110`
- Test: `src/lib/strategies-sdk/plan.test.ts:24-44`
- Test: `src/lib/strategies-sdk/plan-sizing.test.ts:50-56`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MarginLocation = MarginIn | "none"` exported from `sizing.ts`
  - `type OpenMode = 1 | 2 | 3 | 4 | 5 | 6`
  - `ResolvedMode.marginIn: MarginLocation`
  - `resolveMode({mode: 5, volatile, stable})` → `{collateral: volatile, debtAsset: stable, marginIn: "none"}`
  - `resolveMode({mode: 6, ...})` → `{collateral: stable, debtAsset: volatile, marginIn: "none"}`
  - `planOpen` picks `openWithCollateralMargin` for `marginIn !== "debt"`

- [ ] **Step 1: Write the failing tests**

In `src/lib/strategies-sdk/plan.test.ts`, extend the existing mode table (currently at line 24) with two rows, and move the out-of-range case off 5:

```ts
    // mode, functionName, collateral, debtAsset, marginAsset
    [5, 'openWithCollateralMargin', X, S, X],
    [6, 'openWithCollateralMargin', S, X, S],
```

```ts
it("planOpen rejects an out-of-range mode", () => {
  expect(() => planOpen({ ...openBase, mode: 7 as never })).toThrow("invalid open mode");
});
```

Add a dedicated ratchet assertion to the same file:

```ts
it("ratchet modes resolve to no margin and the collateral entry point", () => {
  for (const mode of [5, 6] as const) {
    expect(resolveMode({ mode, volatile: X, stable: S }).marginIn).toBe("none");
    expect(planOpen({ ...openBase, mode, marginAmount: 0n }).functionName)
      .toBe("openWithCollateralMargin");
  }
});
```

In `src/lib/strategies-sdk/plan-sizing.test.ts`, the `CASES` table drives a loop that calls `sizeOpen`, which rejects zero margin — so ratchet gets its own assertion rather than a table row:

```ts
it("ratchet modes report marginIn 'none', which sizeOpen never sees", () => {
  for (const mode of [5, 6] as const) {
    expect(resolveMode({ mode, volatile: X, stable: S }).marginIn).toBe("none");
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/lib/strategies-sdk/plan.test.ts src/lib/strategies-sdk/plan-sizing.test.ts`
Expected: FAIL — `invalid open mode: 5`.

- [ ] **Step 3: Add `MarginLocation` to `sizing.ts`**

Directly below the existing `MarginIn` declaration (`sizing.ts:43`):

```ts
/**
 * Adds the ratchet path, where no margin is posted at all. `sizeOpen` never sees this: leverage
 * is a multiple of a margin base, and with no base the derived path is not merely unused but
 * undefined. Ratchet positions are sized by hand.
 */
export type MarginLocation = MarginIn | "none";
```

- [ ] **Step 4: Widen the mode set in `plan.ts`**

Replace the `OpenMode` declaration and its doc comment (`plan.ts:5-11`):

```ts
/**
 * 1 = long X holding X · 2 = long X holding stable ·
 * 3 = short X holding X · 4 = short X holding stable ·
 * 5 = long X, no margin · 6 = short X, no margin.
 * Longs collateralize X and borrow the stable; shorts collateralize the stable and borrow X.
 * Modes 1/4 bring margin in the collateral asset, 2/3 in the debt asset, and 5/6 bring none —
 * the ratchet path, which levers an existing position rather than opening against new equity.
 */
export type OpenMode = 1 | 2 | 3 | 4 | 5 | 6;
```

Change the `ResolvedMode.marginIn` import and field:

```ts
import type { MarginLocation } from "./sizing";
```

```ts
export interface ResolvedMode {
  collateral: Address;
  debtAsset: Address;
  /** Feeds `sizeOpen`'s `marginIn` directly on the derived path — imported from `sizing.ts` so
   *  the two can never drift apart. `"none"` never reaches `sizeOpen`. */
  marginIn: MarginLocation;
}
```

Replace `resolveMode`'s body:

```ts
export function resolveMode(p: ResolveModeInput): ResolvedMode {
  if (!Number.isInteger(p.mode) || p.mode < 1 || p.mode > 6) {
    throw new Error(`invalid open mode: ${p.mode}`);
  }
  const long = p.mode === 1 || p.mode === 2 || p.mode === 5;
  const marginIn: MarginLocation =
    p.mode === 5 || p.mode === 6
      ? "none"
      : p.mode === 1 || p.mode === 4
        ? "collateral"
        : "debt";
  return {
    collateral: long ? p.volatile : p.stable,
    debtAsset: long ? p.stable : p.volatile,
    marginIn,
  };
}
```

In `planOpen`, replace the entry-point selection (`plan.ts:98`):

```ts
  // "none" takes the collateral entry point: with zero margin the flash alone becomes the
  // supply and no pre-swap is needed — AaveV3Strategies.sol:334.
  const collateralMargin = marginIn !== "debt";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/lib/strategies-sdk/ && pnpm exec tsc -b`
Expected: PASS, and no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/strategies-sdk/plan.ts src/lib/strategies-sdk/sizing.ts \
        src/lib/strategies-sdk/plan.test.ts src/lib/strategies-sdk/plan-sizing.test.ts
git commit -m "feat(sdk): add ratchet open modes 5 and 6

Both map to openWithCollateralMargin with marginAmount 0, the path
AaveV3Strategies.sol:334 describes: the flash alone becomes the supply."
```

---

### Task 3: `manualOpen.ts` — validation and projection

Pure module, no React and no network, mirroring how `sizing.ts` and `openPlan.ts` already sit apart from the components.

**Files:**
- Create: `src/lib/manualOpen.ts`
- Test: `src/lib/manualOpen.test.ts`

**Interfaces:**
- Consumes: `MarginLocation`, `BPS`, `ceilDiv` from `./strategies-sdk/sizing` (Task 2).
- Produces:
  - `type ManualOpenError = 'ZERO_FLASH' | 'ZERO_BORROW' | 'MARGIN_EXCEEDS_BALANCE' | 'RATCHET_NO_POSITION' | 'SWAP_SHORTFALL' | 'LTV_EXCEEDED'`
  - `interface ManualQuote { amountIn: bigint; amountOut: bigint }`
  - `interface ManualOpenInput` (fields as written below)
  - `interface ManualProjection { expectedSwapOut, expectedCollateral, expectedDebt, expectedLeverageBps: bigint | null, expectedHealthFactorBps, impliedLtvBps }`
  - `type ManualOpenResult = {ok: true; projection: ManualProjection} | {ok: false; error: ManualOpenError; suggestedBorrow: bigint | null}`
  - `validateManualOpen(p: ManualOpenInput): ManualOpenResult`
  - `manualOpenErrorMessage(e: ManualOpenError, ctx: {marginSymbol: string; debtSymbol: string; collateralSymbol: string; marginBalance: string; shortfall: string; suggestedBorrow: string | null}): string`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/manualOpen.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { manualOpenErrorMessage, validateManualOpen } from './manualOpen'
import type { ManualOpenInput } from './manualOpen'

// WETH collateral at $2,000 (8dp), USDC debt at $1. 18 and 6 decimals respectively.
const BASE: ManualOpenInput = {
  marginIn: 'collateral',
  marginAmount: 10n ** 18n,          // 1 WETH
  borrowAmount: 2_000_000_000n,      // 2,000 USDC
  flashAmount: 10n ** 18n,           // 1 WETH
  marginBalance: 5n * 10n ** 18n,
  collateralPriceUsd: 200_000_000_000n, // 2000 * 1e8
  debtPriceUsd: 100_000_000n,           // 1 * 1e8
  collateralDecimals: 18,
  debtDecimals: 6,
  ltvBps: 8000n,
  liquidationThresholdBps: 8300n,
  existingCollateralUsd: 0n,
  existingDebtUsd: 0n,
  // 2,000 USDC in -> 1 WETH out: exactly covers a 1 WETH flash.
  quote: { amountIn: 2_000_000_000n, amountOut: 10n ** 18n },
  slippageBps: 50n,
}

it('accepts a position whose swap exactly covers the flash', () => {
  const r = validateManualOpen(BASE)
  expect(r.ok).toBe(true)
})

it('rejects a zero flash before anything else', () => {
  const r = validateManualOpen({ ...BASE, flashAmount: 0n, borrowAmount: 0n })
  expect(r).toMatchObject({ ok: false, error: 'ZERO_FLASH' })
})

it('rejects a zero borrow', () => {
  const r = validateManualOpen({ ...BASE, borrowAmount: 0n })
  expect(r).toMatchObject({ ok: false, error: 'ZERO_BORROW' })
})

it('rejects margin above the wallet balance', () => {
  const r = validateManualOpen({ ...BASE, marginBalance: 10n ** 17n })
  expect(r).toMatchObject({ ok: false, error: 'MARGIN_EXCEEDS_BALANCE' })
})

it('rejects ratchet with no existing position', () => {
  const r = validateManualOpen({ ...BASE, marginIn: 'none', marginAmount: 0n })
  expect(r).toMatchObject({ ok: false, error: 'RATCHET_NO_POSITION' })
})

it('rejects a borrow that cannot swap into the flash, and suggests one that can', () => {
  // Halve the borrow: 1,000 USDC buys 0.5 WETH, short of the 1 WETH flash.
  const r = validateManualOpen({ ...BASE, borrowAmount: 1_000_000_000n })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error).toBe('SWAP_SHORTFALL')
  // 1 WETH needs 2,000 USDC at the quoted rate, padded by 0.5% slippage.
  expect(r.suggestedBorrow).toBe(2_010_000_000n)
})

it('subtracts debt-asset margin from the suggested borrow, since it joins the swap', () => {
  const r = validateManualOpen({
    ...BASE, marginIn: 'debt', marginAmount: 500_000_000n, borrowAmount: 100_000_000n,
  })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.suggestedBorrow).toBe(2_010_000_000n - 500_000_000n)
})

it('rejects a position whose implied LTV reaches the reserve ceiling', () => {
  // The swap buys collateral worth what was borrowed, so LTV = D/(M+D) and clearing 80% needs
  // D >= 4M. With $2,000 of margin that is $8,000 of debt; 9,000 USDC lands at 8181 bps.
  const r = validateManualOpen({
    ...BASE,
    borrowAmount: 9_000_000_000n,
    quote: { amountIn: 9_000_000_000n, amountOut: 45n * 10n ** 17n },
  })
  expect(r).toMatchObject({ ok: false, error: 'LTV_EXCEEDED' })
})

it('projects collateral as margin plus swap output on the collateral path', () => {
  const r = validateManualOpen(BASE)
  if (!r.ok) throw new Error('expected ok')
  expect(r.projection.expectedCollateral).toBe(2n * 10n ** 18n)
  expect(r.projection.expectedDebt).toBe(2_000_000_000n)
})

it('projects collateral as the swap output alone on the debt path', () => {
  // The flash is repaid out of the output, so the margin is already inside it. The rate is
  // doubled from BASE so the resulting position clears the LTV ceiling rather than tripping it.
  const r = validateManualOpen({
    ...BASE,
    marginIn: 'debt',
    marginAmount: 0n,
    quote: { amountIn: 2_000_000_000n, amountOut: 2n * 10n ** 18n },
  })
  if (!r.ok) throw new Error('expected ok')
  expect(r.projection.expectedCollateral).toBe(2n * 10n ** 18n)
})

it('folds the existing account position into the health factor on every mode', () => {
  const alone = validateManualOpen(BASE)
  const withExisting = validateManualOpen({
    ...BASE,
    existingCollateralUsd: 1_000_000_000_000n, // $10,000
    existingDebtUsd: 0n,
  })
  if (!alone.ok || !withExisting.ok) throw new Error('expected ok')
  expect(withExisting.projection.expectedHealthFactorBps)
    .toBeGreaterThan(alone.projection.expectedHealthFactorBps)
})

it('reports no leverage figure for ratchet, where equity added is ~zero', () => {
  const r = validateManualOpen({
    ...BASE,
    marginIn: 'none',
    marginAmount: 0n,
    existingCollateralUsd: 1_000_000_000_000n,
  })
  if (!r.ok) throw new Error('expected ok')
  expect(r.projection.expectedLeverageBps).toBeNull()
})

it('projects without a quote so the form can render before the first round lands', () => {
  const r = validateManualOpen({ ...BASE, quote: null })
  expect(r.ok).toBe(true)
})

describe('manualOpenErrorMessage', () => {
  it('names the shortfall and the borrow that would clear it', () => {
    const msg = manualOpenErrorMessage('SWAP_SHORTFALL', {
      marginSymbol: 'WETH', debtSymbol: 'USDC', collateralSymbol: 'WETH',
      marginBalance: '5.0', shortfall: '0.5', suggestedBorrow: '2,010',
    })
    expect(msg).toContain('0.5')
    expect(msg).toContain('2,010')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/lib/manualOpen.test.ts`
Expected: FAIL — cannot resolve `./manualOpen`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/manualOpen.ts`:

```ts
import { BPS, ceilDiv } from './strategies-sdk/sizing'
import type { MarginLocation } from './strategies-sdk/sizing'

/**
 * Validation for hand-entered open amounts.
 *
 * `sizeOpen` solves margin + leverage into amounts and so cannot produce a combination the
 * contract rejects. Typed amounts can, and the expensive failure is a revert the user pays gas
 * for. Every check here maps to a specific on-chain guard, named in its comment.
 */

export type ManualOpenError =
  | 'ZERO_FLASH'
  | 'ZERO_BORROW'
  | 'MARGIN_EXCEEDS_BALANCE'
  | 'RATCHET_NO_POSITION'
  | 'SWAP_SHORTFALL'
  | 'LTV_EXCEEDED'

/** A realized rate, taken from a live quote rather than the oracle. */
export interface ManualQuote {
  amountIn: bigint
  amountOut: bigint
}

export interface ManualOpenInput {
  marginIn: MarginLocation
  marginAmount: bigint
  borrowAmount: bigint
  /** Flash-borrowed from Morpho, always denominated in the COLLATERAL asset. */
  flashAmount: bigint
  marginBalance: bigint
  /** Aave market-reference price, 8 decimals. */
  collateralPriceUsd: bigint
  debtPriceUsd: bigint
  collateralDecimals: number
  debtDecimals: number
  ltvBps: bigint
  liquidationThresholdBps: bigint
  /** `getUserAccountData` totals, 8dp USD — the same scale the prices above produce. */
  existingCollateralUsd: bigint
  existingDebtUsd: bigint
  /** Null until the first quote round lands. */
  quote: ManualQuote | null
  slippageBps: bigint
}

export interface ManualProjection {
  expectedSwapOut: bigint
  expectedCollateral: bigint
  expectedDebt: bigint
  /** Null on the ratchet path: equity added is ~zero, so the ratio says nothing. */
  expectedLeverageBps: bigint | null
  expectedHealthFactorBps: bigint
  impliedLtvBps: bigint
}

export type ManualOpenResult =
  | { ok: true; projection: ManualProjection }
  | { ok: false; error: ManualOpenError; suggestedBorrow: bigint | null }

/** The contract swaps borrow PLUS margin on the debt path — AaveV3Strategies.sol:491. */
function swapInFor(p: ManualOpenInput): bigint {
  return p.borrowAmount + (p.marginIn === 'debt' ? p.marginAmount : 0n)
}

function usd(amount: bigint, priceUsd: bigint, decimals: number): bigint {
  return (amount * priceUsd) / 10n ** BigInt(decimals)
}

/**
 * The borrow that would clear the flash at the rate the quote actually realized — not the
 * oracle's. Using the quote's own rate means the suggestion clears on the next attempt rather
 * than landing just short again.
 */
function suggestBorrow(p: ManualOpenInput, q: ManualQuote): bigint | null {
  const neededIn = ceilDiv(p.flashAmount * q.amountIn, q.amountOut)
  const padded = ceilDiv(neededIn * (BPS + p.slippageBps), BPS)
  const borrow = padded - (p.marginIn === 'debt' ? p.marginAmount : 0n)
  return borrow > 0n ? borrow : null
}

function project(p: ManualOpenInput, expectedSwapOut: bigint): ManualProjection {
  // The collateral path supplies flash + margin and the output repays the flash, leaving the
  // surplus in the position. The debt path supplies the flash alone and the whole output lands
  // as collateral — the margin is already inside it. Mirrors AaveV3Strategies.sol:479-491, and
  // matches `sizeOpen`'s expectedCollateral for the same flows.
  const expectedCollateral = p.marginIn === 'debt' ? expectedSwapOut : p.marginAmount + expectedSwapOut

  const collUsd =
    usd(expectedCollateral, p.collateralPriceUsd, p.collateralDecimals) + p.existingCollateralUsd
  const debtUsd = usd(p.borrowAmount, p.debtPriceUsd, p.debtDecimals) + p.existingDebtUsd
  const equityUsd = collUsd - debtUsd

  return {
    expectedSwapOut,
    expectedCollateral,
    expectedDebt: p.borrowAmount,
    expectedLeverageBps:
      p.marginIn === 'none' || equityUsd <= 0n ? null : (collUsd * BPS) / equityUsd,
    expectedHealthFactorBps: debtUsd > 0n ? (collUsd * p.liquidationThresholdBps) / debtUsd : 0n,
    impliedLtvBps: collUsd > 0n ? (debtUsd * BPS) / collUsd : BPS,
  }
}

export function validateManualOpen(p: ManualOpenInput): ManualOpenResult {
  const fail = (error: ManualOpenError, suggestedBorrow: bigint | null = null): ManualOpenResult =>
    ({ ok: false, error, suggestedBorrow })

  // The contract's own ZeroAmount guards — AaveV3Strategies.sol:274 and :331.
  if (p.flashAmount <= 0n) return fail('ZERO_FLASH')
  if (p.borrowAmount <= 0n) return fail('ZERO_BORROW')
  if (p.marginAmount > p.marginBalance) return fail('MARGIN_EXCEEDS_BALANCE')

  // Ratchet adds no equity, so with nothing already supplied it opens a position the user has
  // no stake in — and the borrow would have no collateral to sit against.
  if (p.marginIn === 'none' && p.existingCollateralUsd <= 0n) return fail('RATCHET_NO_POSITION')

  // Before the first quote there is no rate to judge coverage against. Project the shape of the
  // position anyway so the preview renders, and let the quote round decide.
  if (!p.quote || p.quote.amountIn <= 0n || p.quote.amountOut <= 0n) {
    return { ok: true, projection: project(p, 0n) }
  }

  const expectedSwapOut = (swapInFor(p) * p.quote.amountOut) / p.quote.amountIn

  // The hard floor: the swap output must repay the flash, or the whole transaction reverts —
  // AaveV3Strategies.sol:502, which fires independently of the user's minOut.
  if (expectedSwapOut < p.flashAmount) {
    return fail('SWAP_SHORTFALL', suggestBorrow(p, p.quote))
  }

  const projection = project(p, expectedSwapOut)

  // Aave's `borrow` reverts at the LTV wall, so land strictly below it.
  if (projection.impliedLtvBps >= p.ltvBps) return fail('LTV_EXCEEDED')

  return { ok: true, projection }
}

/**
 * User-facing copy for a manual rejection. The enum members are internal names meant for logs;
 * showing them raw is the same mistake `sizeOpenErrorMessage` exists to avoid.
 *
 * Amounts arrive pre-formatted as strings — this module is bigint-only and has no business
 * knowing decimals or locale.
 */
export function manualOpenErrorMessage(
  error: ManualOpenError,
  ctx: {
    marginSymbol: string
    debtSymbol: string
    collateralSymbol: string
    marginBalance: string
    shortfall: string
    suggestedBorrow: string | null
  },
): string {
  switch (error) {
    case 'ZERO_FLASH':
      return 'Enter a flash amount'
    case 'ZERO_BORROW':
      return 'Enter a debt amount'
    case 'MARGIN_EXCEEDS_BALANCE':
      return `You have ${ctx.marginBalance} ${ctx.marginSymbol}`
    case 'RATCHET_NO_POSITION':
      return 'Ratchet needs collateral already supplied — post margin instead'
    case 'SWAP_SHORTFALL': {
      const fix = ctx.suggestedBorrow
        ? ` Raise debt to about ${ctx.suggestedBorrow} ${ctx.debtSymbol}, or lower the flash.`
        : ' Lower the flash amount.'
      return `The borrow is ${ctx.shortfall} ${ctx.collateralSymbol} short of repaying the flash.${fix}`
    }
    case 'LTV_EXCEEDED':
      return `Too much debt against this much ${ctx.collateralSymbol} — Aave would reject the borrow`
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/lib/manualOpen.test.ts && pnpm exec tsc -b`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/manualOpen.ts src/lib/manualOpen.test.ts
git commit -m "feat(lib): validate and project hand-entered open amounts

Every check maps to a specific on-chain guard. The suggested borrow comes
from the quote's realized rate, not the oracle, so it clears on retry."
```

---

### Task 4: `OpenInput.sizing` union and the manual quote path

The hook currently runs a quote → re-size → re-quote loop because `sizeOpen` needs a rate it does not have yet. Manual amounts fix `amountIn`, so that loop collapses to one round.

**Files:**
- Modify: `src/hooks/useStrategiesOpen.ts:54-94` (types), `:110-121` (`inputKey`), `:196-364` (the effect), `:394-430` (`execute`)
- Test: `src/hooks/useStrategiesOpen.test.tsx`

**Interfaces:**
- Consumes: `validateManualOpen`, `ManualOpenError`, `ManualProjection` from `../lib/manualOpen` (Task 3); `MarginLocation`, `OpenMode` from the SDK (Task 2).
- Produces:
  - `type OpenSizing = {kind:'derived'; marginAmount: bigint; leverageBps: bigint} | {kind:'manual'; marginAmount: bigint; borrowAmount: bigint; flashAmount: bigint}`
  - `OpenInput` with `sizing: OpenSizing`, plus new `marginBalance: bigint`, `existingCollateralUsd: bigint`, `existingDebtUsd: bigint`; `marginAmount` and `leverageBps` are **removed** from the top level
  - `OpenPreview.expectedLeverageBps: bigint | null`
  - `PreviewErrorKind` gains every `ManualOpenError` member

- [ ] **Step 1: Migrate the existing fixtures to the union**

Every existing test in `src/hooks/useStrategiesOpen.test.tsx` builds on `INPUT`, so it moves first or nothing compiles. Replace `INPUT` (`:41-45`):

```tsx
const INPUT = {
  contract: STRAT, mode: 1 as const, volatile: WETH, stable: USDC,
  sizing: {
    kind: 'derived' as const,
    marginAmount: 1_000_000_000_000_000_000n,
    leverageBps: 20_000n,
  },
  slippageBps: 50n,
  marginBalance: 10n ** 21n,
  existingCollateralUsd: 0n,
  existingDebtUsd: 0n,
  reserves: RESERVES,
}
```

In the debt-margin test (`:144`), the margin moves inside the union:

```tsx
  const debtMarginInput = {
    ...INPUT,
    mode: 2 as const,
    sizing: { kind: 'derived' as const, marginAmount: 1_000_000_000n, leverageBps: 20_000n }, // 1000 USDC
  }
```

and its assertion (`:152`) reads through it:

```tsx
  expect(quotedAmountIn).toBe(result.current.preview!.borrowAmount + debtMarginInput.sizing.marginAmount)
```

The sizing-rejection test (`:188-191`) passes a zero margin inline — move that into `sizing` the same way.

- [ ] **Step 2: Write the failing tests**

Append to `src/hooks/useStrategiesOpen.test.tsx`, using the file's existing `stubAdapter` and `mocks.getAdaptersForChain`:

```tsx
it('quotes exactly once on the manual path, with the amounts as typed', async () => {
  const adapter = stubAdapter(400_000_000n)
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  const { result } = renderHook(() => useStrategiesOpen({
    ...INPUT,
    sizing: {
      kind: 'manual' as const,
      marginAmount: 1_000_000_000_000_000_000n,
      borrowAmount: 3_000_000_000n,
      flashAmount: 1_000_000_000_000_000_000n,
    },
  }))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  // The derived path re-quotes as sizeOpen converges on a rate. Manual has nothing to converge
  // on: amountIn is whatever the user typed, so a second round could only re-ask the same
  // question.
  expect(vi.mocked(adapter.getQuote)).toHaveBeenCalledTimes(1)
  expect(vi.mocked(adapter.getQuote).mock.calls[0][2]).toBe('3000000000')
  expect(result.current.preview?.flashAmount).toBe(1_000_000_000_000_000_000n)
  expect(result.current.preview?.borrowAmount).toBe(3_000_000_000n)
})

it('surfaces a manual shortfall as a preview error rather than a preview', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])

  const { result } = renderHook(() => useStrategiesOpen({
    ...INPUT,
    sizing: {
      kind: 'manual' as const,
      marginAmount: 1_000_000_000_000_000_000n,
      borrowAmount: 1_000_000n,   // 1 USDC buys nowhere near the 1 WETH flash
      flashAmount: 1_000_000_000_000_000_000n,
    },
  }))

  await waitFor(() => expect(result.current.previewError?.kind).toBe('SWAP_SHORTFALL'))
  expect(result.current.preview).toBeNull()
})
```

At the stub's rate of 4e8 WETH wei per USDC wei, 3,000 USDC buys 1.2 WETH — clear of the 1 WETH flash, and at $2,500 WETH (the `RESERVES` price) the resulting LTV is well under the 7500 bps ceiling.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/hooks/useStrategiesOpen.test.tsx`
Expected: FAIL — `sizing` is not a known property of `OpenInput`.

- [ ] **Step 4: Reshape the types**

In `src/hooks/useStrategiesOpen.ts`, replace the `OpenInput` interface (`:54-63`):

```ts
/**
 * How the three contract amounts are arrived at. `derived` solves them from a margin and a
 * target leverage; `manual` takes them as typed. They are a union rather than optional fields
 * because a half-filled manual entry must never silently fall back to derived sizing.
 */
export type OpenSizing =
  | { kind: 'derived'; marginAmount: bigint; leverageBps: bigint }
  | { kind: 'manual'; marginAmount: bigint; borrowAmount: bigint; flashAmount: bigint }

export interface OpenInput {
  contract: Address
  mode: OpenMode
  volatile: Address
  stable: Address
  sizing: OpenSizing
  slippageBps: bigint
  reserves: { collateral: ReserveInfo; debt: ReserveInfo }
  /** Wallet balance of the margin asset. Manual validation rejects above it. */
  marginBalance: bigint
  /** `getUserAccountData` totals, 8dp USD. Folded into manual projections so the health factor
   *  reflects the whole account, which is what Aave liquidates against. */
  existingCollateralUsd: bigint
  existingDebtUsd: bigint
}
```

Extend the error kind (`:65`):

```ts
export type PreviewErrorKind =
  | SizeOpenError
  | ManualOpenError
  | 'paused' | 'no-route' | 'no-client' | 'quote-failed'
```

Widen the preview's leverage field (`:81`):

```ts
  /** Null on the ratchet path, where equity added is ~zero and the ratio says nothing. */
  expectedLeverageBps: bigint | null
```

Add the imports:

```ts
import { manualOpenErrorMessage, validateManualOpen } from '../lib/manualOpen'
import type { ManualOpenError } from '../lib/manualOpen'
```

- [ ] **Step 5: Extend `inputKey`**

Replace `inputKey` (`:115-121`):

```ts
function sizingKey(s: OpenSizing): string {
  return s.kind === 'derived'
    ? `d|${s.marginAmount}|${s.leverageBps}`
    : `m|${s.marginAmount}|${s.borrowAmount}|${s.flashAmount}`
}
function inputKey(input: OpenInput): string {
  return [
    input.contract, input.mode, input.volatile, input.stable,
    sizingKey(input.sizing), input.slippageBps,
    input.marginBalance, input.existingCollateralUsd, input.existingDebtUsd,
    reserveKey(input.reserves.collateral), reserveKey(input.reserves.debt),
  ].join('|')
}
```

- [ ] **Step 6: Branch the effect onto the manual path**

Inside the effect, immediately after the `paused` check and the `coll`/`debt` bindings (around `:210`), insert the manual branch. It reuses the existing adapter setup, so place it after `allowed`/`adapters`/`fromAsset`/`toAsset`/`slippagePercent` are computed and before the derived path's `sizeOpen` seed:

```ts
        // Manual sizing fixes amountIn, so there is nothing for the refine loop to converge on:
        // one round, then validate coverage against the rate it came back with.
        if (input.sizing.kind === 'manual') {
          const { marginAmount, borrowAmount, flashAmount } = input.sizing
          const manualBase = {
            marginIn, marginAmount, borrowAmount, flashAmount,
            marginBalance: input.marginBalance,
            collateralPriceUsd: coll.priceUsd, debtPriceUsd: debt.priceUsd,
            collateralDecimals: coll.decimals, debtDecimals: debt.decimals,
            ltvBps: coll.ltvBps, liquidationThresholdBps: coll.liquidationThresholdBps,
            existingCollateralUsd: input.existingCollateralUsd,
            existingDebtUsd: input.existingDebtUsd,
            slippageBps: input.slippageBps,
          }

          const rejectManual = (error: ManualOpenError, suggested: bigint | null, out: bigint) =>
            setPreviewError({
              kind: error,
              message: manualOpenErrorMessage(error, {
                marginSymbol: marginIn === 'debt' ? debt.symbol : coll.symbol,
                debtSymbol: debt.symbol,
                collateralSymbol: coll.symbol,
                marginBalance: formatUnits(input.marginBalance, marginIn === 'debt' ? debt.decimals : coll.decimals),
                shortfall: formatUnits(flashAmount > out ? flashAmount - out : 0n, coll.decimals),
                suggestedBorrow: suggested === null ? null : formatUnits(suggested, debt.decimals),
              }),
            })

          // Cheap checks first: no point spending a quote on amounts the contract rejects.
          const dry = validateManualOpen({ ...manualBase, quote: null })
          if (!dry.ok) { rejectManual(dry.error, dry.suggestedBorrow, 0n); return }

          const amountIn = (borrowAmount + (marginIn === 'debt' ? marginAmount : 0n)).toString()
          const results = await Promise.all(
            adapters.map(async (a) => {
              try {
                const q = await a.getQuote(fromAsset, toAsset, amountIn, slippagePercent, chainId)
                return q ? { a, q } : null
              } catch {
                return null
              }
            }),
          )
          if (cancelled) return

          const ranked = results
            .filter((r): r is Candidate => r !== null)
            .sort((x, y) => (BigInt(y.q.amountOut) > BigInt(x.q.amountOut) ? 1 : -1))
          if (ranked.length === 0) {
            setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
            return
          }

          const top = ranked[0]
          const checked = validateManualOpen({
            ...manualBase,
            quote: { amountIn: BigInt(top.q.amountIn), amountOut: BigInt(top.q.amountOut) },
          })
          if (!checked.ok) {
            const out = (BigInt(top.q.amountOut) * BigInt(amountIn)) / BigInt(top.q.amountIn)
            rejectManual(checked.error, checked.suggestedBorrow, out)
            return
          }

          const build = await selectBuildableRoute(ranked)
          if (!build) {
            setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
            return
          }

          setPreview({
            collateral, debtAsset,
            marginAsset: marginIn === 'debt' ? debtAsset : collateral,
            flashAmount, borrowAmount,
            minOut: minOutFromBuild({
              buildAmountOut: BigInt(build.built.amountOut ?? build.quote.amountOut),
              slippageBps: input.slippageBps,
              flashAmount,
            }),
            expectedCollateral: checked.projection.expectedCollateral,
            expectedDebt: checked.projection.expectedDebt,
            expectedLeverageBps: checked.projection.expectedLeverageBps,
            expectedHealthFactorBps: checked.projection.expectedHealthFactorBps,
            router: build.built.to as Address,
            swapData: build.built.data as Hex,
            aggregator: build.adapter.name,
            priceImpactPercent: routeCostPercent(build.quote.rawAmountInUsd, build.quote.rawAmountOutUsd),
          })
          return
        }
```

- [ ] **Step 7: Extract the route-selection loop both paths now need**

The build-and-validate loop currently at `:319-344` is used verbatim by the manual branch. Lift it to a closure defined just above the manual branch, and replace the derived path's inline copy with a call to it:

```ts
        // Every candidate was quoted at the same amountIn, so any of them may be built. Fall
        // through candidates that fail to build or fail validateSwapTx rather than erroring out
        // on the first pick.
        const selectBuildableRoute = async (
          candidates: Candidate[],
        ): Promise<{ quote: QuoteResponse; adapter: Adapter; built: TransactionPayload } | null> => {
          for (const cand of candidates) {
            let candBuilt: TransactionPayload
            try {
              candBuilt = await cand.a.buildTransaction(cand.q, slippagePercent, input.contract, chainId)
            } catch {
              continue
            }
            if (cancelled) return null
            const problem = validateSwapTx(
              { to: candBuilt.to, data: candBuilt.data, value: candBuilt.value, spender: candBuilt.spender },
              allowed.has(candBuilt.to.toLowerCase()),
            )
            if (problem) continue
            return { quote: cand.q, adapter: cand.a, built: candBuilt }
          }
          return null
        }
```

The `type Candidate` declaration must move above this closure. In the derived path, replace the inline loop and its `if (!quote || !adapter || !built)` guard with:

```ts
        const build = await selectBuildableRoute(rankedFinal)
        if (!build) {
          setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
          return
        }
```

and read `build.built` / `build.quote` / `build.adapter` in the `setPreview` call that follows.

- [ ] **Step 8: Update `execute` for the union**

At `:424` and `:427`, `input.marginAmount` no longer exists. Replace both references:

```ts
      if (allowance < input.sizing.marginAmount) {
        await deps.writeContract({
          address: effectivePreview.marginAsset, abi: ERC20_ABI, functionName: 'approve',
          args: [input.contract, input.sizing.marginAmount],
        })
      }
```

A zero margin needs no approval, and `allowance < 0n` is already false, so the ratchet path skips this branch without a special case.

- [ ] **Step 9: Update the derived path's `sizeArgs`**

`sizeArgs` reads `input.marginAmount` and `input.leverageBps`, which have moved. Narrow the union once, before the derived block:

```ts
        const derived = input.sizing
        if (derived.kind !== 'derived') throw new Error('unreachable: manual path returned above')
```

then use `derived.marginAmount` and `derived.leverageBps` in `sizeArgs` and in `swapInFor`.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/hooks/useStrategiesOpen.test.tsx && pnpm exec tsc -b`
Expected: PASS. `tsc` will still flag `LeverageActions.tsx`, which Task 6 fixes — that is expected at this point and no other file should error.

- [ ] **Step 11: Commit**

```bash
git add src/hooks/useStrategiesOpen.ts src/hooks/useStrategiesOpen.test.tsx
git commit -m "feat(hooks): accept hand-entered amounts via an OpenSizing union

Manual sizing fixes amountIn, so the quote/re-size refine loop collapses
to a single round. Route selection is shared by both paths."
```

---

### Task 5: `ManualAmounts` component

**Files:**
- Create: `src/components/ManualAmounts.tsx`
- Test: `src/components/ManualAmounts.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks — it is presentational and takes strings.
- Produces: `<ManualAmounts>` with props `{ borrowStr, onBorrowChange, flashStr, onFlashChange, debtSymbol, collateralSymbol, message, onApplySuggestion }`, where `message: string | null` and `onApplySuggestion: (() => void) | null`.

- [ ] **Step 1: Write the failing test**

Create `src/components/ManualAmounts.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ManualAmounts } from './ManualAmounts'

const PROPS = {
  borrowStr: '2000',
  onBorrowChange: vi.fn(),
  flashStr: '1.0',
  onFlashChange: vi.fn(),
  debtSymbol: 'USDC',
  collateralSymbol: 'WETH',
  message: null,
  onApplySuggestion: null,
}

it('labels the two fields by what they borrow from', () => {
  render(<ManualAmounts {...PROPS} />)
  expect(screen.getByLabelText('Debt amount')).toBeTruthy()
  expect(screen.getByLabelText('Flash amount')).toBeTruthy()
  expect(screen.getByText(/borrow from Aave/i)).toBeTruthy()
  expect(screen.getByText(/flash from Morpho/i)).toBeTruthy()
})

it('reports edits as raw strings so the parent owns parsing', () => {
  const onBorrowChange = vi.fn()
  render(<ManualAmounts {...PROPS} onBorrowChange={onBorrowChange} />)
  fireEvent.change(screen.getByLabelText('Debt amount'), { target: { value: '2500' } })
  expect(onBorrowChange).toHaveBeenCalledWith('2500')
})

it('shows the shortfall message when there is one', () => {
  render(<ManualAmounts {...PROPS} message="Short by 0.5 WETH." />)
  expect(screen.getByText('Short by 0.5 WETH.')).toBeTruthy()
})

it('offers a one-click fix only when a suggestion exists', () => {
  const onApplySuggestion = vi.fn()
  const { rerender } = render(<ManualAmounts {...PROPS} message="Short." />)
  expect(screen.queryByRole('button', { name: /use suggested/i })).toBeNull()

  rerender(<ManualAmounts {...PROPS} message="Short." onApplySuggestion={onApplySuggestion} />)
  fireEvent.click(screen.getByRole('button', { name: /use suggested/i }))
  expect(onApplySuggestion).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/components/ManualAmounts.test.tsx`
Expected: FAIL — cannot resolve `./ManualAmounts`.

- [ ] **Step 3: Write the component**

Create `src/components/ManualAmounts.tsx`:

```tsx
import { T } from '../styles/theme'

interface ManualAmountsProps {
  borrowStr: string
  onBorrowChange: (value: string) => void
  flashStr: string
  onFlashChange: (value: string) => void
  debtSymbol: string
  collateralSymbol: string
  /** Validation copy from `manualOpenErrorMessage`, already formatted. */
  message: string | null
  /** Set only when the rejection carried a suggested borrow that would clear it. */
  onApplySuggestion: (() => void) | null
}

/**
 * The two amounts the derived path normally solves for.
 *
 * Values stay strings all the way up to the parent: a half-typed "2." is not a bigint, and
 * parsing here would either throw on every keystroke or quietly round what the user meant.
 */
export function ManualAmounts(p: ManualAmountsProps) {
  const field = (
    label: string,
    hint: string,
    value: string,
    onChange: (v: string) => void,
    symbol: string,
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[1] }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm }}>
        <span style={{ color: T.textMuted }}>{label}</span>
        <span style={{ color: T.textMuted }}>{hint}</span>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: T.space[2],
        border: `1px solid ${T.border}`, borderRadius: T.radius.md, padding: T.space[2],
        background: T.surface,
      }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          aria-label={label}
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: T.fontSize.md, background: 'transparent' }}
        />
        <span style={{ fontWeight: 600 }}>{symbol}</span>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[3] }}>
      {field('Debt amount', 'borrow from Aave', p.borrowStr, p.onBorrowChange, p.debtSymbol)}
      {field('Flash amount', 'flash from Morpho', p.flashStr, p.onFlashChange, p.collateralSymbol)}

      {p.message && (
        <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>
          {p.message}
          {p.onApplySuggestion && (
            <>
              {' '}
              <button
                onClick={p.onApplySuggestion}
                style={{
                  border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                  color: T.primary, fontWeight: 600, fontSize: T.fontSize.sm,
                }}
              >
                Use suggested
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/components/ManualAmounts.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ManualAmounts.tsx src/components/ManualAmounts.test.tsx
git commit -m "feat(ui): add the manual debt and flash amount fields"
```

---

### Task 6: Wire the panel together

The last task: `marginIn` gains `'none'`, the slider becomes conditional, and `LeverageActions` assembles the `OpenSizing` union through a new `useOpenSizing` hook so the component does not grow another three state variables inline.

**Files:**
- Create: `src/hooks/useOpenSizing.ts`
- Modify: `src/components/OpenPositionForm.tsx:4-19,61-105`
- Modify: `src/components/LeverageActions.tsx:29-119,177-247`
- Modify: `src/components/PositionPreview.tsx:58-63`
- Modify: `src/hooks/useAavePositions.ts:436` (expose `collateralBase` / `debtBase`)
- Modify: `src/components/AavePosition.tsx:69-82,327,587`
- Test: `src/components/LeverageActions.test.tsx`

**Interfaces:**
- Consumes: `ManualAmounts` (Task 5), `OpenSizing`/`OpenInput` (Task 4), `MarginLocation`/`OpenMode` (Task 2).
- Produces: `useOpenSizing({marginIn, marginStr, marginDecimals, borrowStr, borrowDecimals, flashStr, flashDecimals, leverageBps, manualEnabled})` → `{sizing: OpenSizing | null, manual: boolean}`. Returns `null` when any active field fails to parse, so the caller passes `null` to `useStrategiesOpen` and no quote is attempted.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/LeverageActions.test.tsx`:

```tsx
it('hides the leverage slider and forces manual entry in ratchet mode', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  render(<LeverageActions {...PROPS} />)

  fireEvent.click(screen.getByRole('button', { name: /no margin/i }))

  expect(screen.queryByRole('slider')).toBeNull()
  expect(screen.queryByLabelText('Margin amount')).toBeNull()
  // Manual is not optional here — there is nothing to derive from.
  expect(screen.queryByLabelText(/enter amounts manually/i)).toBeNull()
  expect(screen.getByLabelText('Debt amount')).toBeTruthy()
  expect(screen.getByLabelText('Flash amount')).toBeTruthy()
})

it('keeps the slider and hides the manual fields until they are unlocked', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  render(<LeverageActions {...PROPS} />)

  expect(screen.getByRole('slider')).toBeTruthy()
  expect(screen.queryByLabelText('Debt amount')).toBeNull()

  fireEvent.click(screen.getByLabelText(/enter amounts manually/i))
  expect(screen.getByLabelText('Debt amount')).toBeTruthy()
  // The slider stays: it is what seeded the amounts now showing.
  expect(screen.getByRole('slider')).toBeTruthy()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/components/LeverageActions.test.tsx`
Expected: FAIL — no `no margin` button.

- [ ] **Step 3: Write `useOpenSizing`**

Create `src/hooks/useOpenSizing.ts`:

```ts
import { useMemo } from 'react'
import { parseUnits } from 'viem'
import type { MarginLocation } from '../lib/strategies-sdk/sizing'
import type { OpenSizing } from './useStrategiesOpen'

interface UseOpenSizingInput {
  marginIn: MarginLocation
  marginStr: string
  marginDecimals: number
  borrowStr: string
  borrowDecimals: number
  flashStr: string
  flashDecimals: number
  leverageBps: bigint
  manualEnabled: boolean
}

/** Parses a user-typed decimal, or null when it is not yet a number. */
function parse(value: string, decimals: number): bigint | null {
  try {
    return parseUnits(value || '0', decimals)
  } catch {
    return null
  }
}

/**
 * Turns the form's strings into the union `useStrategiesOpen` consumes.
 *
 * Returns `null` rather than a partial sizing whenever an active field does not parse, so the
 * caller passes `null` to the hook and nothing is quoted against a half-typed amount. Ratchet
 * is always manual: with no margin there is no base for leverage to multiply.
 */
export function useOpenSizing(p: UseOpenSizingInput): { sizing: OpenSizing | null; manual: boolean } {
  const manual = p.manualEnabled || p.marginIn === 'none'

  return useMemo(() => {
    const marginAmount = p.marginIn === 'none' ? 0n : parse(p.marginStr, p.marginDecimals)
    if (marginAmount === null) return { sizing: null, manual }

    if (!manual) {
      if (marginAmount <= 0n) return { sizing: null, manual }
      return { sizing: { kind: 'derived', marginAmount, leverageBps: p.leverageBps }, manual }
    }

    const borrowAmount = parse(p.borrowStr, p.borrowDecimals)
    const flashAmount = parse(p.flashStr, p.flashDecimals)
    if (borrowAmount === null || flashAmount === null) return { sizing: null, manual }

    return { sizing: { kind: 'manual', marginAmount, borrowAmount, flashAmount }, manual }
  }, [
    manual, p.marginIn, p.marginStr, p.marginDecimals, p.borrowStr, p.borrowDecimals,
    p.flashStr, p.flashDecimals, p.leverageBps,
  ])
}
```

- [ ] **Step 4: Give `OpenPositionForm` a third margin location and a conditional slider**

Replace the props interface and the margin/slider sections:

```tsx
interface OpenPositionFormProps {
  marginStr: string
  onMarginChange: (value: string) => void
  marginBalance: string
  marginSymbol: string
  marginIn: MarginLocation
  onMarginInChange: (value: MarginLocation) => void
  collateralSymbol: string
  debtSymbol: string
  leverageBps: bigint
  onLeverageChange: (value: bigint) => void
  ltvBps: bigint
  liquidationThresholdBps: bigint
  dangerEnabled: boolean
  onDangerToggle: (on: boolean) => void
  manualEnabled: boolean
  onManualToggle: (on: boolean) => void
}
```

with `import type { MarginLocation } from '../lib/strategies-sdk/sizing'` added.

Wrap the margin input and its label (the two blocks at `:40-59`) in `{p.marginIn !== 'none' && (...)}`.

Extend the "pay with" row to three choices:

```tsx
      <div style={{ display: 'flex', gap: T.space[2], alignItems: 'center', fontSize: T.fontSize.sm }}>
        <span style={{ color: T.textMuted }}>pay with</span>
        {(['collateral', 'debt', 'none'] as const).map((role) => (
          <button
            key={role}
            onClick={() => p.onMarginInChange(role)}
            style={{
              padding: `${T.space[1]} ${T.space[2]}`, borderRadius: T.radius.sm,
              border: `1px solid ${p.marginIn === role ? T.primary : T.border}`,
              background: p.marginIn === role ? T.primary : 'transparent',
              color: p.marginIn === role ? '#fff' : T.text,
              cursor: 'pointer', fontSize: T.fontSize.sm,
            }}
          >
            {role === 'collateral' ? p.collateralSymbol : role === 'debt' ? p.debtSymbol : 'No margin'}
          </button>
        ))}
      </div>
```

Wrap the leverage label, the `<input type="range">` and the danger-zone checkbox (`:80-105`) in `{p.marginIn !== 'none' && (<>...</>)}` — leverage is undefined without a margin base.

Add the unlock checkbox at the end of the component, shown only when the derived path exists:

```tsx
      {p.marginIn !== 'none' && (
        <label style={{ display: 'flex', gap: T.space[2], fontSize: T.fontSize.sm, color: T.textMuted }}>
          <input
            type="checkbox"
            checked={p.manualEnabled}
            onChange={(e) => p.onManualToggle(e.target.checked)}
            aria-label="Enter amounts manually"
          />
          Enter amounts manually
        </label>
      )}
```

- [ ] **Step 5: Wire `LeverageActions`**

State changes at `:34-40`:

```tsx
  const [marginIn, setMarginIn] = useState<MarginLocation>('collateral')
  const [manualEnabled, setManualEnabled] = useState(false)
  const [borrowStr, setBorrowStr] = useState('')
  const [flashStr, setFlashStr] = useState('')
```

`mode` at `:49` extends to the ratchet pair:

```tsx
  const mode: OpenMode = marginIn === 'none'
    ? (long ? 5 : 6)
    : long
      ? (marginIn === 'collateral' ? 1 : 2)
      : marginIn === 'debt' ? 3 : 4
```

`marginReserve` at `:51` must not be `undefined` for ratchet — the balance read is skipped there anyway:

```tsx
  const marginReserve = marginIn === 'debt' ? debtReserve : collateralReserve
```

Assemble the sizing and pass the new `OpenInput` fields:

```tsx
  const { sizing, manual } = useOpenSizing({
    marginIn,
    marginStr,
    marginDecimals: marginReserve?.raw.decimals ?? 18,
    borrowStr,
    borrowDecimals: debtReserve?.raw.decimals ?? 18,
    flashStr,
    flashDecimals: collateralReserve?.raw.decimals ?? 18,
    leverageBps,
    manualEnabled,
  })

  const input = useMemo(() => {
    if (!contract || !sizing) return null
    if (!volatileReserve || !stableReserve || !collateralReserve || !debtReserve) return null
    return {
      contract,
      mode,
      volatile: volatileReserve.underlyingAsset,
      stable: stableReserve.underlyingAsset,
      sizing,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      marginBalance: (marginWalletBalance as bigint | undefined) ?? 0n,
      existingCollateralUsd,
      existingDebtUsd,
      reserves: {
        collateral: { address: collateralReserve.underlyingAsset, symbol: collateralReserve.symbol, ...collateralReserve.raw },
        debt: { address: debtReserve.underlyingAsset, symbol: debtReserve.symbol, ...debtReserve.raw },
      },
    }
  }, [
    contract, mode, sizing, volatileReserve, stableReserve, collateralReserve, debtReserve,
    marginWalletBalance, existingCollateralUsd, existingDebtUsd,
  ])
```

`marginWalletBalance` is `useReadContract`'s `data`, which is not typed as `bigint` — the file already casts it at `:66`. Match that: `marginBalance: (marginWalletBalance as bigint | undefined) ?? 0n`.

**`useAavePositions` does not currently expose what this needs.** It reads `totalCollateralBase` / `totalDebtBase` (`:269-270`) but only returns them through `collateralUsd` / `debtUsd`, which are JS **numbers** (`:277-278`). Routing 8dp money through a float and back would violate this plan's bigint constraint and silently lose precision on large positions. So expose the raw values alongside the existing ones — in the returned object at `:436`:

```ts
  return {
    collateralUsd,
    debtUsd,
    /** The same totals as `collateralUsd`/`debtUsd`, unrounded: Aave base units, 8 decimals.
     *  Sizing math consumes these; the numbers above are for display. */
    collateralBase: totalCollateralBase,
    debtBase: totalDebtBase,
    availableBorrowsUsd,
```

`totalCollateralBase` and `totalDebtBase` are already destructured in scope at `:269-270`. Where the account data has not loaded, the existing default path supplies `0n`.

Then add `existingCollateralUsd: bigint` and `existingDebtUsd: bigint` to `LeverageActionsProps`, destructure `collateralBase` / `debtBase` from `useAavePositions` in `AavePosition.tsx` (`:69-82`), and pass them at both `<LeverageActions>` call sites (`:327` and `:587`).

Seed the manual fields from the last derived preview, so unlocking starts from what the slider produced rather than from empty:

```tsx
  // Unlocking manual entry pre-fills from whatever the derived path last priced — an empty form
  // would throw away the sizing the user just dialled in.
  const seedManual = (on: boolean) => {
    if (on && preview && !borrowStr && !flashStr) {
      setBorrowStr(formatUnits(preview.borrowAmount, debtReserve?.raw.decimals ?? 18))
      setFlashStr(formatUnits(preview.flashAmount, collateralReserve?.raw.decimals ?? 18))
    }
    setManualEnabled(on)
  }
```

Render `ManualAmounts` directly below `OpenPositionForm`, replacing the bare `sizingMessage` div at `:206-208`:

```tsx
          {manual ? (
            <ManualAmounts
              borrowStr={borrowStr}
              onBorrowChange={setBorrowStr}
              flashStr={flashStr}
              onFlashChange={setFlashStr}
              debtSymbol={debtReserve?.symbol ?? '—'}
              collateralSymbol={collateralReserve?.symbol ?? '—'}
              message={sizingMessage}
              onApplySuggestion={null}
            />
          ) : (
            sizingMessage && <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>{sizingMessage}</div>
          )}
```

Pass the two new props to `OpenPositionForm`: `manualEnabled={manualEnabled}` and `onManualToggle={seedManual}`.

- [ ] **Step 6: Handle a null leverage in `PositionPreview`**

`expectedLeverageBps` is now nullable. Replace the Leverage row in the `rows` array (`:61`):

```tsx
  const rows: Array<[string, string]> = [
    ['Collateral', `${fmt(preview.expectedCollateral, collateralDecimals, 4)} ${collateralSymbol}`],
    ['Debt', `${fmt(preview.expectedDebt, debtDecimals, 2)} ${debtSymbol}`],
    // Null on the ratchet path: equity added is ~zero, so a ratio would be noise.
    ['Leverage', preview.expectedLeverageBps === null
      ? '—'
      : `${(Number(preview.expectedLeverageBps) / 10000).toFixed(2)}x`],
    ['Route', preview.aggregator],
  ]
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `pnpm exec vitest run && pnpm exec tsc -b`
Expected: PASS with no type errors. Test count is 204 plus the tests added in Tasks 2, 3, 5 and 6.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useOpenSizing.ts src/components/LeverageActions.tsx \
        src/components/OpenPositionForm.tsx src/components/PositionPreview.tsx \
        src/components/LeverageActions.test.tsx src/components/AavePosition.tsx
git commit -m "feat(ui): manual amount entry and the no-margin ratchet mode

Ratchet drops the slider entirely rather than zeroing the margin field:
with no margin base, leverage is undefined, not merely unused."
```

---

## Verification

After Task 6, confirm the whole feature end to end:

- [ ] `pnpm exec vitest run` — all green
- [ ] `pnpm exec tsc -b` — no errors
- [ ] `pnpm run build` — production bundle builds
- [ ] Manual check against the local Base fork: unlock manual entry, lower the debt below what the flash needs, confirm Open disables and the shortfall names a suggested borrow.
