# Collateral-Side Liquidation Prices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the collateral prices at which an Aave position liquidates (e.g. "WETH $2,543.32"), replacing the useless borrow-side liquidation column that quotes stablecoin debt at ~$1.40.

**Architecture:** A new pure math module `src/utils/liquidation.ts` computes, per collateral asset, the price it must fall to for the health factor to reach 1 with all other prices held fixed — plus one market-wide "all collateral falls together" figure. A new presentational component `src/components/LiquidationPriceBlock.tsx` renders it as a bordered section beneath the stats grid. The hook gains one passthrough field; the borrow-side column is deleted.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Vitest 4 (added by this plan), wagmi/viem (untouched).

**Spec:** `docs/superpowers/specs/2026-08-02-collateral-liquidation-price-design.md`

## Global Constraints

- **Package manager is pnpm.** Use `pnpm add -D`, `pnpm run`. Never create npm/yarn lockfiles.
- **`verbatimModuleSyntax: true`** in `tsconfig.app.json` — every type-only import MUST use `import type { X } from '...'`. A plain `import { SomeInterface }` fails the build.
- **`types: ["vite/client"]`** in `tsconfig.app.json` — Vitest globals are NOT available. Every test file MUST explicitly `import { describe, it, expect } from 'vitest'`. Do not enable `globals: true`.
- **`noUnusedLocals` and `noUnusedParameters` are on** — an unused import or variable fails `pnpm build`.
- **`erasableSyntaxOnly: true`** — no TypeScript `enum`, no constructor parameter properties.
- **Prices come from the Aave oracle.** Use `Number(asset.priceInUsd)`. Do NOT use the `apiEthPrice` prop — that is a display-only CoinGecko price used for P&L. Aave liquidates on its own oracle, so mixing the two would produce a liquidation price that disagrees with the protocol.
- **Liquidation thresholds are raw per-reserve values.** No E-Mode calibration — this is a deliberate, documented decision in the spec. When E-Mode is on the numbers are conservative and a caveat line is rendered.
- **Styling:** import `T` from `../styles/theme` for inline styles; use existing global classes `text-danger` / `text-success` / `text-muted` from `src/index.css` where they apply.
- Verification commands for every task: `pnpm test run`, `pnpm build`, `pnpm lint`.

---

### Task 1: Pure liquidation math — per-asset isolated prices

**Files:**
- Create: `vitest.config.ts`
- Create: `src/utils/liquidation.ts`
- Test: `src/utils/liquidation.test.ts`
- Modify: `package.json` (add `test` script + `vitest` devDependency)

**Interfaces:**
- Consumes: nothing (leaf module, no React/wagmi imports)
- Produces:
  - `interface CollateralInput { symbol: string; amount: number; priceUsd: number; liquidationThreshold: number }`
  - `interface LiquidationRow { symbol: string; liquidationPriceUsd: number | null; currentPriceUsd: number; bufferPct: number | null; isVolatile: boolean }`
  - `interface LiquidationView { rows: LiquidationRow[]; marketWideDropPct: number | null }`
  - `function computeLiquidationView(collateral: CollateralInput[], debtUsd: number): LiquidationView`
  - `function isVolatilePrice(priceUsd: number): boolean`
  - `const STABLE_BAND = 0.02`

**Background for the implementer:** Aave liquidates when the health factor drops below 1. `HF = Σ(amountᵢ × priceᵢ × LTᵢ) / debtUsd`, where `LTᵢ` is the reserve's liquidation threshold (a fraction, e.g. `0.825`). To find the price at which asset *j* alone triggers liquidation, solve that equation for `priceⱼ` with every other price frozen. In this task `marketWideDropPct` is always `null`; Task 2 implements it.

- [ ] **Step 1: Install Vitest and add the test script**

```bash
pnpm add -D vitest
```

Then edit `package.json` so the `scripts` block reads:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "test": "vitest"
  },
```

- [ ] **Step 2: Create the Vitest config**

Standalone config so the Vite build config stays untouched. The math is pure, so `node` environment — no jsdom needed.

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 3: Write the failing test for the motivating single-collateral case**

Create `src/utils/liquidation.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeLiquidationView } from './liquidation'

describe('computeLiquidationView — single volatile collateral, stablecoin debt', () => {
  // 100 WETH @ $3,740 with LT 0.825 backing $209,824 of USDC debt.
  // Weighted collateral = 100 * 3740 * 0.825 = 308,550  ->  HF = 1.4706
  // Liquidation when 100 * p * 0.825 = 209,824  ->  p = 209824 / 82.5 = 2543.3212
  const collateral = [
    { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
  ]

  it('returns the price WETH must fall to for HF to reach 1', () => {
    const view = computeLiquidationView(collateral, 209824)
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0].symbol).toBe('WETH')
    expect(view.rows[0].liquidationPriceUsd).toBeCloseTo(2543.3212, 3)
  })

  it('reports the buffer as a negative fraction of the current price', () => {
    const view = computeLiquidationView(collateral, 209824)
    expect(view.rows[0].bufferPct).toBeCloseTo(-0.3199676, 6)
    expect(view.rows[0].currentPriceUsd).toBe(3740)
  })

  it('marks WETH as volatile', () => {
    const view = computeLiquidationView(collateral, 209824)
    expect(view.rows[0].isVolatile).toBe(true)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test run src/utils/liquidation.test.ts`
Expected: FAIL — `Failed to resolve import "./liquidation"`

- [ ] **Step 5: Write the minimal implementation**

Create `src/utils/liquidation.ts`:

```ts
/**
 * liquidation — collateral-side liquidation prices for an Aave position.
 *
 * Aave liquidates when the health factor falls below 1:
 *   HF = Σ(amountᵢ × priceᵢ × LTᵢ) / debtUsd
 *
 * For each collateral asset this module solves that equation for that asset's
 * price, holding every other asset's price fixed — the "isolated" liquidation
 * price that Aave's own UI and DeFi Saver quote.
 *
 * Thresholds are each reserve's raw `reserveLiquidationThreshold`. E-Mode
 * overrides are deliberately NOT applied; see the spec at
 * docs/superpowers/specs/2026-08-02-collateral-liquidation-price-design.md.
 */

export interface CollateralInput {
  symbol: string
  amount: number
  priceUsd: number
  /** Reserve's own liquidation threshold as a fraction, e.g. 0.825. */
  liquidationThreshold: number
}

export interface LiquidationRow {
  symbol: string
  /** null when this asset cannot liquidate the position on its own. */
  liquidationPriceUsd: number | null
  currentPriceUsd: number
  /** Fractional and normally negative (-0.32 = a 32% fall). null when price is null. */
  bufferPct: number | null
  isVolatile: boolean
}

export interface LiquidationView {
  rows: LiquidationRow[]
  /** Fractional and normally negative. null when not applicable. */
  marketWideDropPct: number | null
}

/** Half-width of the band around $1.00 within which an asset counts as a stablecoin. */
export const STABLE_BAND = 0.02

/**
 * A symbol allowlist rots on every new stablecoin listing and silently
 * mislabels a depegged asset as safe, so classify on price instead.
 */
export function isVolatilePrice(priceUsd: number): boolean {
  return Math.abs(priceUsd - 1) > STABLE_BAND
}

export function computeLiquidationView(
  collateral: CollateralInput[],
  debtUsd: number,
): LiquidationView {
  if (!(debtUsd > 0)) return { rows: [], marketWideDropPct: null }

  const usable = collateral.filter(c => c.amount > 0 && c.priceUsd > 0)
  if (usable.length === 0) return { rows: [], marketWideDropPct: null }

  // Total liquidation-threshold-weighted collateral. HF = totalWeighted / debtUsd.
  const totalWeighted = usable.reduce(
    (sum, c) => sum + c.amount * c.priceUsd * c.liquidationThreshold,
    0,
  )

  const rows: LiquidationRow[] = usable.map(c => {
    const weighted = c.amount * c.priceUsd * c.liquidationThreshold
    // Debt left uncovered once every OTHER asset's weighted collateral is applied.
    const uncovered = debtUsd - (totalWeighted - weighted)
    const denominator = c.amount * c.liquidationThreshold

    // denominator === 0 -> the asset carries no liquidation weight at all.
    // uncovered <= 0     -> the other collateral already covers the debt, so this
    //                       asset could fall to zero without liquidating anything.
    const canLiquidate = denominator > 0 && uncovered > 0
    const liquidationPriceUsd = canLiquidate ? uncovered / denominator : null

    return {
      symbol: c.symbol,
      liquidationPriceUsd,
      currentPriceUsd: c.priceUsd,
      bufferPct: liquidationPriceUsd === null ? null : liquidationPriceUsd / c.priceUsd - 1,
      isVolatile: isVolatilePrice(c.priceUsd),
    }
  })

  return { rows, marketWideDropPct: null }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test run src/utils/liquidation.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 7: Write the failing tests for the null-price and skip branches**

Append to `src/utils/liquidation.test.ts`:

```ts
describe('computeLiquidationView — assets that cannot liquidate the position', () => {
  it('returns null when the other collateral already covers the debt', () => {
    // WETH weighted = 308,550; USDC weighted = 320,000; total = 628,550 vs $100k debt.
    // Either asset alone could fall to zero and the other would still cover it.
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'USDC', amount: 400000, priceUsd: 1, liquidationThreshold: 0.8 },
      ],
      100000,
    )
    expect(view.rows.map(r => r.liquidationPriceUsd)).toEqual([null, null])
    expect(view.rows.map(r => r.bufferPct)).toEqual([null, null])
  })

  it('returns null for an asset with a zero liquidation threshold', () => {
    // WETH carries no liquidation weight, so no WETH price can save or sink the position.
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0 },
        { symbol: 'USDC', amount: 400000, priceUsd: 1, liquidationThreshold: 0.8 },
      ],
      400000,
    )
    const weth = view.rows.find(r => r.symbol === 'WETH')
    expect(weth?.liquidationPriceUsd).toBeNull()
  })

  it('skips assets with a zero balance or a missing price', () => {
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'GHOST', amount: 0, priceUsd: 500, liquidationThreshold: 0.7 },
        { symbol: 'NOPRICE', amount: 10, priceUsd: 0, liquidationThreshold: 0.7 },
      ],
      209824,
    )
    expect(view.rows.map(r => r.symbol)).toEqual(['WETH'])
  })

  it('returns an empty view when there is no debt', () => {
    const view = computeLiquidationView(
      [{ symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 }],
      0,
    )
    expect(view.rows).toEqual([])
    expect(view.marketWideDropPct).toBeNull()
  })

  it('returns an empty view when there is no usable collateral', () => {
    expect(computeLiquidationView([], 100000).rows).toEqual([])
  })
})
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test run src/utils/liquidation.test.ts`
Expected: PASS — 8 tests. The Step 5 implementation already handles these branches; this step proves it rather than driving new code. If any fail, fix `liquidation.ts` before continuing.

- [ ] **Step 9: Write the failing test for row ordering**

Append to `src/utils/liquidation.test.ts`:

```ts
describe('computeLiquidationView — row ordering', () => {
  it('puts the asset needing the smallest price drop first, nulls last', () => {
    // Weighted: WETH 308,550 + USDC 800 + cbBTC 336,000 = 645,350 vs $400k debt.
    // WETH  liq price = (400000 - 336800) / 82.5 = 766.06  -> buffer -0.7952
    // cbBTC liq price = (400000 - 309350) / 3.5  = 25900.00 -> buffer -0.7302
    // cbBTC needs the smaller fall, so it must lead. USDC cannot liquidate -> last.
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'USDC', amount: 1000, priceUsd: 1, liquidationThreshold: 0.8 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
      ],
      400000,
    )
    expect(view.rows.map(r => r.symbol)).toEqual(['cbBTC', 'WETH', 'USDC'])
  })
})
```

- [ ] **Step 10: Run the test to verify it fails**

Run: `pnpm test run src/utils/liquidation.test.ts`
Expected: FAIL — received `['WETH', 'USDC', 'cbBTC']` (input order, unsorted)

- [ ] **Step 11: Implement the sort**

In `src/utils/liquidation.ts`, replace the final `return` statement of `computeLiquidationView` with:

```ts
  // Closest to liquidation first: the asset needing the SMALLEST fall leads.
  // bufferPct is negative, so that is descending order (-0.25 sorts above -0.32).
  // Assets that cannot liquidate the position have no buffer and sort last.
  rows.sort((a, b) => {
    if (a.bufferPct === null && b.bufferPct === null) return 0
    if (a.bufferPct === null) return 1
    if (b.bufferPct === null) return -1
    return b.bufferPct - a.bufferPct
  })

  return { rows, marketWideDropPct: null }
```

- [ ] **Step 12: Run the full suite and the build**

Run: `pnpm test run && pnpm build && pnpm lint`
Expected: 9 tests PASS, build succeeds, lint clean.

- [ ] **Step 13: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts src/utils/liquidation.ts src/utils/liquidation.test.ts
git commit -m "feat(frontend): add pure collateral liquidation-price math with Vitest"
```

---

### Task 2: Market-wide correlated drop

**Files:**
- Modify: `src/utils/liquidation.ts` (the `return` at the end of `computeLiquidationView`)
- Test: `src/utils/liquidation.test.ts` (append)

**Interfaces:**
- Consumes: `computeLiquidationView`, `isVolatilePrice`, `CollateralInput` from Task 1
- Produces: `LiquidationView.marketWideDropPct` now populated (was always `null`)

**Background:** Isolated per-asset prices understate risk when you hold two or more volatile collaterals, because a real crash hits them all at once. This computes the single factor `f` by which all volatile collateral would have to fall together to reach HF = 1, with stablecoin collateral holding its value:

```
f    = (debtUsd − weightedStable) / weightedVolatile
drop = f − 1
```

It is deliberately hidden below 2 volatile collaterals — with exactly one, the figure is mathematically identical to that asset's own row and would be pure noise.

- [ ] **Step 1: Write the failing tests**

Append to `src/utils/liquidation.test.ts`:

```ts
describe('computeLiquidationView — market-wide correlated drop', () => {
  it('is null with a single volatile collateral (identical to that row)', () => {
    const view = computeLiquidationView(
      [{ symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 }],
      209824,
    )
    expect(view.marketWideDropPct).toBeNull()
  })

  it('is null when all collateral is stablecoins', () => {
    const view = computeLiquidationView(
      [
        { symbol: 'USDC', amount: 400000, priceUsd: 1, liquidationThreshold: 0.8 },
        { symbol: 'USDT', amount: 100000, priceUsd: 1, liquidationThreshold: 0.75 },
      ],
      100000,
    )
    expect(view.marketWideDropPct).toBeNull()
  })

  it('computes the shared fall across two volatile collaterals', () => {
    // weightedVolatile = 308,550 + 336,000 = 644,550 ; no stables ; debt 400,000
    // f = 400000 / 644550 = 0.6205880  ->  drop = -0.3794120
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
      ],
      400000,
    )
    expect(view.marketWideDropPct).toBeCloseTo(-0.3794120, 6)
  })

  it('excludes stablecoin collateral from the volatile weight', () => {
    // weightedStable = 80,000 ; weightedVolatile = 644,550 ; debt 500,000
    // f = (500000 - 80000) / 644550 = 0.6516174  ->  drop = -0.3483826
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
        { symbol: 'USDC', amount: 100000, priceUsd: 1, liquidationThreshold: 0.8 },
      ],
      500000,
    )
    expect(view.marketWideDropPct).toBeCloseTo(-0.3483826, 6)
  })

  it('is null when stablecoin collateral alone already covers the debt', () => {
    // weightedStable = 320,000 > debt 100,000, so no fall in volatile prices liquidates.
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
        { symbol: 'USDC', amount: 400000, priceUsd: 1, liquidationThreshold: 0.8 },
      ],
      100000,
    )
    expect(view.marketWideDropPct).toBeNull()
  })

  it('requires a smaller fall than any single asset falling alone', () => {
    const view = computeLiquidationView(
      [
        { symbol: 'WETH', amount: 100, priceUsd: 3740, liquidationThreshold: 0.825 },
        { symbol: 'cbBTC', amount: 5, priceUsd: 96000, liquidationThreshold: 0.7 },
      ],
      400000,
    )
    const worstSingle = Math.min(...view.rows.map(r => Math.abs(r.bufferPct as number)))
    expect(Math.abs(view.marketWideDropPct as number)).toBeLessThan(worstSingle)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test run src/utils/liquidation.test.ts`
Expected: FAIL — 3 of the 6 fail with `expected null to be close to -0.379...` etc. (the three `toBeNull` cases pass trivially, since `marketWideDropPct` is currently hardcoded `null`).

- [ ] **Step 3: Implement the market-wide calculation**

In `src/utils/liquidation.ts`, replace the sort-and-return block from Task 1 Step 11 with:

```ts
  // Closest to liquidation first: the asset needing the SMALLEST fall leads.
  // bufferPct is negative, so that is descending order (-0.25 sorts above -0.32).
  // Assets that cannot liquidate the position have no buffer and sort last.
  rows.sort((a, b) => {
    if (a.bufferPct === null && b.bufferPct === null) return 0
    if (a.bufferPct === null) return 1
    if (b.bufferPct === null) return -1
    return b.bufferPct - a.bufferPct
  })

  return { rows, marketWideDropPct: marketWideDrop(usable, totalWeighted, debtUsd) }
}

/**
 * The single factor by which every volatile collateral would have to fall
 * *together* to reach HF = 1, with stablecoin collateral holding its value.
 *
 * Returns null when the figure would be noise or meaningless:
 *  - fewer than 2 volatile collaterals (identical to that one asset's own row)
 *  - no volatile weight at all
 *  - stablecoin collateral alone already covers the debt
 */
function marketWideDrop(
  usable: CollateralInput[],
  totalWeighted: number,
  debtUsd: number,
): number | null {
  const volatile = usable.filter(c => isVolatilePrice(c.priceUsd))
  if (volatile.length < 2) return null

  const weightedVolatile = volatile.reduce(
    (sum, c) => sum + c.amount * c.priceUsd * c.liquidationThreshold,
    0,
  )
  if (!(weightedVolatile > 0)) return null

  const weightedStable = totalWeighted - weightedVolatile
  const factor = (debtUsd - weightedStable) / weightedVolatile
  if (!(factor > 0)) return null

  return factor - 1
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test run`
Expected: PASS — 15 tests

- [ ] **Step 5: Verify the build and lint**

Run: `pnpm build && pnpm lint`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/utils/liquidation.ts src/utils/liquidation.test.ts
git commit -m "feat(frontend): add market-wide correlated liquidation drop"
```

---

### Task 3: Expose each reserve's liquidation threshold on supplied assets

**Files:**
- Modify: `src/hooks/useAavePositions.ts` (the `suppliedAssets.push({...})` call, around line 262)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: every object in the `suppliedAssets` array gains `liquidationThreshold: number` (a fraction, e.g. `0.825`). Task 5 reads it.

**Background:** The component currently receives only the *account-level* `liquidationThreshold` — a weighted average across all collateral. That is correct as an aggregate but cannot split risk per asset. Each reserve's own threshold is already in scope at the push site as `reserve.reserveLiquidationThreshold` (basis points, e.g. `8250`), and `availableReserves` already converts it the same way at line 221. No new contract reads are needed.

- [ ] **Step 1: Add the field**

In `src/hooks/useAavePositions.ts`, find the `suppliedAssets.push({` call (around line 262). Add this line immediately after `usageAsCollateralEnabledOnUser: uRes.usageAsCollateralEnabledOnUser,`:

```ts
        liquidationThreshold: Number(reserve.reserveLiquidationThreshold) / 10000,
```

Leave `borrowedAssets.push` untouched — debt has no liquidation threshold.

- [ ] **Step 2: Verify the value reaches the component**

Run: `pnpm dev`, open the dashboard with a wallet holding Aave collateral, and in the browser console confirm the field is a sensible fraction. Temporarily add this line just before the `return` in `AavePosition.tsx` (around line 327):

```tsx
  console.log('LT check', suppliedAssets.map((a: any) => [a.symbol, a.liquidationThreshold]))
```

Expected: values between 0 and 1, e.g. `[['WETH', 0.83], ['USDC', 0.78]]`. **Not** `8250`, and **not** `undefined`.

- [ ] **Step 3: Remove the temporary logging**

Delete the `console.log` line added in Step 2. `noUnusedLocals` will not catch this — remove it manually.

- [ ] **Step 4: Verify the build**

Run: `pnpm build && pnpm lint`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useAavePositions.ts
git commit -m "feat(frontend): expose per-reserve liquidation threshold on supplied assets"
```

---

### Task 4: The LiquidationPriceBlock component

**Files:**
- Create: `src/components/LiquidationPriceBlock.tsx`

**Interfaces:**
- Consumes: `LiquidationView` type from `src/utils/liquidation.ts` (Task 1)
- Produces: `export function LiquidationPriceBlock(props: { view: LiquidationView; isEModeEnabled: boolean }): JSX.Element | null`

**Background:** Presentation only — no math beyond formatting. It does not use the `.stat` tile grid, because each tile holds one scalar while this holds a variable-length list. It renders as a bordered section. Returns `null` when there are no rows, so the caller does not need a guard.

- [ ] **Step 1: Create the component**

Create `src/components/LiquidationPriceBlock.tsx`:

```tsx
import type { LiquidationRow, LiquidationView } from '../utils/liquidation'
import { T } from '../styles/theme'

interface LiquidationPriceBlockProps {
  view: LiquidationView
  isEModeEnabled: boolean
}

/** Fraction of the bar filled: closer to liquidation renders fuller. */
function fillFraction(bufferPct: number): number {
  return Math.min(1, Math.max(0, 1 - Math.abs(bufferPct)))
}

/** Under a 15% cushion is danger, under 30% is warning, otherwise calm. */
function bufferColor(bufferPct: number): string {
  const cushion = Math.abs(bufferPct)
  if (cushion < 0.15) return T.danger
  if (cushion < 0.30) return T.warning
  return T.textMuted
}

function Row({ row }: { row: LiquidationRow }) {
  const isUnliquidatable = row.liquidationPriceUsd === null

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(60px, 1fr) minmax(90px, 1.2fr) minmax(90px, 1.2fr) auto',
        gap: T.space[3],
        alignItems: 'center',
        padding: `${T.space[2]} 0`,
        fontSize: T.fontSize.base,
      }}
    >
      <span style={{ fontWeight: 600 }}>{row.symbol}</span>

      {isUnliquidatable ? (
        <span
          className="text-muted"
          style={{ gridColumn: '2 / -1', fontSize: T.fontSize.sm }}
          title="Your other collateral already covers the debt, so this asset could fall to zero without liquidating you."
        >
          — can't liquidate you alone
        </span>
      ) : (
        <>
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            ${row.liquidationPriceUsd!.toFixed(2)}
          </span>
          <span className="text-muted" style={{ fontSize: T.fontSize.sm, fontVariantNumeric: 'tabular-nums' }}>
            now ${row.currentPriceUsd.toFixed(2)}
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: T.space[2],
              color: bufferColor(row.bufferPct!),
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {(row.bufferPct! * 100).toFixed(1)}%
            <span
              aria-hidden="true"
              style={{
                width: '56px',
                height: '4px',
                borderRadius: T.radius.sm,
                background: T.surfaceAlt,
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  display: 'block',
                  width: `${fillFraction(row.bufferPct!) * 100}%`,
                  height: '100%',
                  background: bufferColor(row.bufferPct!),
                }}
              />
            </span>
          </span>
        </>
      )}
    </div>
  )
}

/**
 * LiquidationPriceBlock — the collateral prices at which this position liquidates.
 *
 * Each row assumes every OTHER asset's price holds, which is the convention Aave's
 * own UI uses. The market-wide line covers the correlated case that per-asset rows
 * understate, and only appears when it says something the rows do not.
 */
export function LiquidationPriceBlock({ view, isEModeEnabled }: LiquidationPriceBlockProps) {
  if (view.rows.length === 0) return null

  return (
    <div
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: T.radius.lg,
        padding: `${T.space[3]} ${T.space[4]}`,
        marginTop: T.space[4],
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: T.space[3],
          flexWrap: 'wrap',
          marginBottom: T.space[2],
        }}
      >
        <span style={{ fontSize: T.fontSize.xs, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: T.textMuted }}>
          Liquidation price
        </span>
        <span className="text-muted" style={{ fontSize: T.fontSize.xs }}>
          each assumes other prices hold
        </span>
      </div>

      {view.rows.map(row => <Row key={row.symbol} row={row} />)}

      {view.marketWideDropPct !== null && (
        <div
          style={{
            borderTop: `1px solid ${T.border}`,
            marginTop: T.space[2],
            paddingTop: T.space[2],
            fontSize: T.fontSize.sm,
            color: T.textMuted,
          }}
        >
          Market-wide: all collateral falling together liquidates you at{' '}
          <strong style={{ color: bufferColor(view.marketWideDropPct) }}>
            {(view.marketWideDropPct * 100).toFixed(1)}%
          </strong>
        </div>
      )}

      {isEModeEnabled && (
        <div
          style={{
            marginTop: T.space[2],
            fontSize: T.fontSize.xs,
            color: T.warning,
          }}
        >
          E-Mode is on — these prices use standard thresholds, so they are conservative
          and will not line up exactly with your health factor.
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm build && pnpm lint`
Expected: both succeed. The component is not yet rendered anywhere — that is Task 5.

If the build fails on `JSX.Element` or on the `import type` line, confirm the type import uses `import type` (required by `verbatimModuleSyntax`).

- [ ] **Step 3: Commit**

```bash
git add src/components/LiquidationPriceBlock.tsx
git commit -m "feat(frontend): add LiquidationPriceBlock component"
```

---

### Task 5: Wire into the dashboard and delete the borrow-side column

**Files:**
- Modify: `src/components/AavePosition.tsx` — add import, compute view, render block, delete borrow column

**Interfaces:**
- Consumes: `computeLiquidationView` + `CollateralInput` (Task 1/2), `suppliedAssets[].liquidationThreshold` (Task 3), `LiquidationPriceBlock` (Task 4)
- Produces: the finished feature

**Background:** Only supplies with `usageAsCollateralEnabledOnUser === true` count — a supply with the collateral toggle off carries zero liquidation weight, and including it would overstate safety. Use the Aave oracle price `Number(a.priceInUsd)`, never the `apiEthPrice` prop.

- [ ] **Step 1: Add the imports**

In `src/components/AavePosition.tsx`, after the existing import of `getChainConfig` (line 11), add:

```tsx
import { LiquidationPriceBlock } from './LiquidationPriceBlock'
import { computeLiquidationView } from '../utils/liquidation'
import type { CollateralInput } from '../utils/liquidation'
```

- [ ] **Step 2: Compute the view**

In `src/components/AavePosition.tsx`, find the line `const netInterestUsd = totalInterestEarnedUsd - totalInterestPaidUsd` (around line 321). Immediately after it, add:

```tsx
  // Only collateral-enabled supplies carry liquidation weight. Prices come from the
  // Aave oracle (`priceInUsd`), never `apiEthPrice` — Aave liquidates on its own oracle.
  const liquidationView = computeLiquidationView(
    suppliedAssets
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((a: any) => a.usageAsCollateralEnabledOnUser)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((a: any): CollateralInput => ({
        symbol: a.symbol,
        amount: a.amount,
        priceUsd: Number(a.priceInUsd),
        liquidationThreshold: a.liquidationThreshold,
      })),
    debtUsd,
  )
```

- [ ] **Step 3: Render the block**

In `src/components/AavePosition.tsx`, find the two closing `</div>` tags that end the stats grid and the portfolio card (around lines 392-393):

```tsx
          </div>
        </div>
      </div>

      <div className="asset-tables">
```

Insert the block between them so it sits inside the portfolio card, directly beneath the stats grid:

```tsx
          </div>
        </div>

        <LiquidationPriceBlock view={liquidationView} isEModeEnabled={isEModeEnabled} />
      </div>

      <div className="asset-tables">
```

- [ ] **Step 4: Delete the borrow-side liquidation column header**

In the Borrowed Assets table (around line 490), delete this line:

```tsx
                    <th>Liquidation Price</th>
```

- [ ] **Step 5: Delete the borrow-side liquidation computation**

Around lines 500-505, delete these six lines:

```tsx
                    // Liquidation for a borrowed (debt) asset: the price it would have to RISE
                    // to for the growing debt to push HF to 1, holding collateral and other
                    // debts fixed. Mirror of the collateral-side formula.
                    const otherDebtUsd = debtUsd - a.valueUsd;
                    const allowedThisDebtUsd = collateralUsd * liquidationThreshold - otherDebtUsd;
                    const liquidationPrice = a.amount > 0 && allowedThisDebtUsd > 0 ? allowedThisDebtUsd / a.amount : 0;
```

- [ ] **Step 6: Delete the borrow-side liquidation cell**

Around line 512, delete this line:

```tsx
                        <td className="number" data-label="Liquidation Price">{liquidationPrice > 0 ? `$${liquidationPrice.toFixed(2)}` : 'At risk'}</td>
```

- [ ] **Step 7: Verify the build catches nothing left behind**

Run: `pnpm build && pnpm lint`
Expected: both succeed. `noUnusedLocals` will flag any leftover reference to the deleted `liquidationPrice`, `otherDebtUsd`, or `allowedThisDebtUsd`. Do not silence it — delete the leftover instead.

`collateralUsd` and `liquidationThreshold` remain used by the modals further down the file, so they should NOT be removed from the destructured hook result.

- [ ] **Step 8: Verify in the running app**

Run: `pnpm dev` and open the dashboard with a wallet holding a real position.

Confirm each of these:
- Beneath the stats grid, a "Liquidation price" section shows a row for the volatile collateral (e.g. WETH) with a plausible price *below* the current price and a negative percentage.
- The Borrowed Assets table no longer has a "Liquidation Price" column, and no column is misaligned.
- Cross-check the number: liquidation price ÷ current price should roughly equal `1 / healthFactor` for a single-collateral position. With HF 1.47, expect a buffer near −32%.
- On a wallet with no debt, the whole block is absent.

- [ ] **Step 9: Run the full suite**

Run: `pnpm test run && pnpm build && pnpm lint`
Expected: 15 tests PASS, build succeeds, lint clean.

- [ ] **Step 10: Commit**

```bash
git add src/components/AavePosition.tsx
git commit -m "feat(frontend): show collateral-side liquidation prices, drop borrow-side column"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Isolated per-asset formula, `Rⱼ ≤ 0` → `—` | Task 1 (Steps 3-8) |
| Market-wide correlated line + hiding rules | Task 2 |
| Volatile detection (±2% band, not an allowlist) | Task 1 (`isVolatilePrice`) |
| E-Mode: raw thresholds, caveat line | Global Constraints; Task 4 (caveat) |
| `liquidation.ts` pure module + exact interfaces | Task 1 |
| `LiquidationPriceBlock.tsx` presentation | Task 4 |
| Hook passthrough of `reserveLiquidationThreshold` | Task 3 |
| Delete borrow column (`:490`, `:500-505`, `:512`) | Task 5 (Steps 4-6) |
| Sort closest-to-liquidation first, nulls last | Task 1 (Steps 9-11) |
| Exclude non-collateral supplies | Task 5 (Step 2) |
| All 9 edge-case rows | Task 1 Steps 7-8, Task 2 Step 1 |
| Vitest added, scoped to the math module | Task 1 (Steps 1-2) |

Every spec requirement maps to a task. No gaps.

**Placeholder scan:** No TBD/TODO, no "add error handling", no "similar to Task N". Every code step carries the literal code.

**Type consistency:** `CollateralInput`, `LiquidationRow`, `LiquidationView`, `computeLiquidationView`, `isVolatilePrice`, `STABLE_BAND` are defined in Task 1 and used with identical names and shapes in Tasks 2, 4, and 5. `marketWideDrop` is a private helper introduced in Task 2 and referenced nowhere else. The `liquidationThreshold` field added in Task 3 matches the `CollateralInput.liquidationThreshold` consumed in Task 5.

**One deliberate deviation from strict TDD**, flagged so a reviewer does not read it as an error: Task 1 Steps 7-8 write tests that pass immediately against the Step 5 implementation, because the null-branch guards fall naturally out of the single-collateral formula. They are characterization tests for edge cases the spec calls out, not red-green cycles. Steps 3-6 and 9-11, and all of Task 2, are genuine red-green.
