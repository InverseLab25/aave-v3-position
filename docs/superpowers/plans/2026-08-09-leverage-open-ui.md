# Leverage Open UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ACTIONS panel that lets a user open a leveraged Aave position in one transaction — pick a direction, post margin, choose leverage, review the resulting position, and sign.

**Architecture:** Six new files plus two additive changes to existing ones. Pure math lives in `src/lib/openPlan.ts` (no React, no fetch, fully unit-tested); orchestration lives in `src/hooks/useStrategiesOpen.ts`; the UI is three focused components. Direction-agnostic route helpers move out of `closePlan.ts` into a shared `src/lib/swapRoute.ts`, which `closePlan.ts` re-exports so the live close flow is untouched.

**Tech Stack:** React 19, wagmi v3, viem v2, TypeScript, Vite, vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-09-leverage-open-ui-design.md`

## Global Constraints

- **Package manager is pnpm.** Never npm or yarn. No new dependencies.
- **Never read, edit, or `git add` `.env`.** The contract address is read via `import.meta.env.VITE_STRATEGIES_ADDRESS_1` with a `''` fallback.
- **`src/lib/openPlan.ts` is pure** — no React, no `fetch`, no `import.meta.env`, no imports from `src/adapters/` or `src/config/`. All amounts are `bigint`; ratios are basis points as `bigint`.
- **The SDK is fixed.** Do not modify anything under `src/lib/strategies-sdk/` — it is complete, reviewed and tested. If you believe it is wrong, stop and report.
- **Existing file style:** `src/lib/`, `src/hooks/`, `src/components/` use **single-quoted** strings and no semicolons. Match each file's own surroundings. (Only `src/lib/strategies-sdk/` uses double quotes and semicolons — you are not editing it.)
- **Styling:** inline `style={{…}}` with tokens from `src/styles/theme.ts` (`import { T } from '../styles/theme'`), matching every other component in `src/components/`.
- **Per-task gate:** `pnpm exec tsc -b` clean AND `pnpm exec eslint <files this task changed>` clean. The repo carries a pre-existing eslint backlog in unrelated files — do NOT run a full `pnpm lint` and do not fix unrelated errors.
- **`pnpm exec vitest run` must be green before every commit.** The suite is at 158 tests; it only grows.
- **The contract is undeployed.** `getStrategiesAddress` returns `null` everywhere, so the panel hides itself. This is correct — do not work around it, and do not expect to click through the happy path.
- **Commit only files your task touches.** The repo has unrelated uncommitted changes under `contract/`, `src/hooks/useDeleverageClose.ts` and `src/utils/contract.ts`. Never `git add -A` or `git commit -a`.

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `src/lib/swapRoute.ts` | Direction-agnostic route helpers moved out of `closePlan.ts` |
| `src/lib/openPlan.ts` | Pure open math: swap-rate derivation, refine decision, minOut, leverage ceilings |
| `src/lib/strategiesErrors.ts` | Decodes `AaveV3Strategies` custom errors into user-facing remedies |
| `src/hooks/useStrategiesOpen.ts` | Preview + execute orchestration |
| `src/components/LeverageActions.tsx` | Panel shell, Open/Boost/Repay tabs, Long/Short sidebar |
| `src/components/OpenPositionForm.tsx` | Margin input, pay-with toggle, leverage slider |
| `src/components/PositionPreview.tsx` | Resulting collateral, debt, HF, liquidation price, route |

**Modified:** `src/lib/closePlan.ts` (re-export moved helpers), `src/hooks/useAavePositions.ts` (additive `raw` reserve data), `src/components/AavePosition.tsx` (mount the panel).

---

### Task 1: Extract `swapRoute.ts` from `closePlan.ts`

**Files:**
- Create: `src/lib/swapRoute.ts`
- Modify: `src/lib/closePlan.ts`
- Test: `src/lib/closePlan.test.ts` (existing — must keep passing unchanged)

**Interfaces:**
- Produces: from `src/lib/swapRoute.ts` — `MAX_OUTPUT_DEGRADATION_PERCENT`, `PRICE_IMPACT_HIGH_PERCENT`, `PRICE_IMPACT_BLOCK_PERCENT`, `routeCostPercent`, `isSlippageShapedFailure`, `suggestWiderSlippage`.

This is a **pure move**. No logic changes, no renames. `closePlan.ts` keeps re-exporting every name, so the close flow and its existing tests are untouched.

**Scope note — the signature helpers stay put.** `canReuseSignature`, `reuseBlocker`, `HeldSignature`, `SignatureNeed` and `MIN_SIGNATURE_REMAINING_S` are *not* moved. They are close-specific today: the open flow freezes its plan at signing (Task 7), so it never re-quotes underneath a held signature and has nothing to reuse. Moving them would mean renaming their `aToken` field for a consumer that does not exist — churn in a live code path for no benefit. Extract them if and when phase 3 needs them.

- [ ] **Step 1: Create the new module**

Create `src/lib/swapRoute.ts` containing, moved **verbatim** from `src/lib/closePlan.ts`:

- `MAX_OUTPUT_DEGRADATION_PERCENT`, `PRICE_IMPACT_HIGH_PERCENT`, `PRICE_IMPACT_BLOCK_PERCENT` (lines 309, 312, 315)
- `routeCostPercent` (line 324)
- `isSlippageShapedFailure` (line 338)
- `suggestWiderSlippage` (line 349)

Keep every doc comment with its function. Add this header at the top of the file:

```ts
/**
 * Route-quality helpers that do not depend on the direction of the trade.
 *
 * Extracted from closePlan.ts so the open flow can share them rather than growing a second
 * copy that drifts. closePlan.ts re-exports all of these, so its consumers are unaffected.
 */
```

The moved code needs no imports — every function here takes plain numbers and strings.

- [ ] **Step 2: Re-export from `closePlan.ts`**

Delete the moved declarations from `src/lib/closePlan.ts` and add this near the top of the file, after its existing imports:

```ts
// Moved to swapRoute.ts so the open flow can share them. Re-exported here so every existing
// consumer of closePlan keeps working against the same import path.
export {
  MAX_OUTPUT_DEGRADATION_PERCENT,
  PRICE_IMPACT_HIGH_PERCENT,
  PRICE_IMPACT_BLOCK_PERCENT,
  routeCostPercent,
  isSlippageShapedFailure,
  suggestWiderSlippage,
} from './swapRoute'
```

If any code remaining in `closePlan.ts` references one of these names internally, add a matching local import from `./swapRoute` as well — a re-export alone does not bring a name into the module's own scope. Import only what the file actually references; remove anything eslint flags as unused.

- [ ] **Step 3: Run the existing close tests**

Run: `pnpm exec vitest run src/lib/closePlan.test.ts`
Expected: PASS, same count as before the change. **If any assertion fails, you changed behaviour — revert and re-do the move verbatim.**

- [ ] **Step 4: Full gate**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/swapRoute.ts src/lib/closePlan.ts && pnpm exec vitest run`
Expected: all clean, 158 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/swapRoute.ts src/lib/closePlan.ts
git commit -m "refactor: extract direction-agnostic route helpers into swapRoute.ts"
```

---

### Task 2: Raw reserve data in `useAavePositions`

**Files:**
- Modify: `src/hooks/useAavePositions.ts`
- Test: `src/hooks/useAavePositions.test.tsx` (existing — extend)

**Interfaces:**
- Produces: `AvailableReserve.raw: { ltvBps: bigint; liquidationThresholdBps: bigint; priceUsd: bigint; decimals: number }`.

Background: `sizeOpen` takes `bigint` at native precision. `useAavePositions` currently converts reserve figures to lossy `Number`s (`priceInMarketReferenceCurrency / 1e8`, `reserveLiquidationThreshold / 10000`) and never extracts `baseLTVasCollateral` at all — though the field **is** returned by the UI Pool Data Provider and is present in `src/config/uiPoolDataProviderAbi.ts:49`.

The change is **additive**: existing display fields stay exactly as they are, so no current consumer changes.

- [ ] **Step 1: Write the failing test**

Append to `src/hooks/useAavePositions.test.tsx`. Follow the file's existing mock setup — reuse whatever fixture builder the file already uses for `globalReserves`; if it builds reserve objects inline, add `baseLTVasCollateral` and `reserveLiquidationThreshold` to that inline object.

```tsx
it('exposes raw reserve config at native precision for the sizing SDK', () => {
  // Aave returns LTV and liquidation threshold in bps, and price on an 8-decimal USD scale.
  // The display fields divide these down into lossy Numbers; `raw` must not.
  const { result } = renderHookWithReserves([
    makeReserve({
      symbol: 'WETH',
      underlyingAsset: WETH,
      decimals: 18n,
      baseLTVasCollateral: 8000n,
      reserveLiquidationThreshold: 8300n,
      priceInMarketReferenceCurrency: 250_000_000_000n,
    }),
  ])

  const weth = result.current.availableReserves.find((r) => r.symbol === 'WETH')
  expect(weth?.raw).toEqual({
    ltvBps: 8000n,
    liquidationThresholdBps: 8300n,
    priceUsd: 250_000_000_000n,
    decimals: 18,
  })
  // the lossy display fields are unchanged
  expect(weth?.liquidationThreshold).toBe(0.83)
  expect(weth?.priceInUsd).toBe('2500')
})
```

If the existing test file has no `renderHookWithReserves`/`makeReserve` helper, write the test using whatever pattern the file already uses to drive `mocks.useReadContracts` — do not invent a helper that conflicts with the file's conventions.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/hooks/useAavePositions.test.tsx`
Expected: FAIL — `weth.raw` is `undefined`.

- [ ] **Step 3: Add the field to the type**

In `src/hooks/useAavePositions.ts`, extend the `AvailableReserve` interface (line 105) by adding, after `liquidationThreshold`:

```ts
  /**
   * Reserve config at native on-chain precision, for the sizing SDK.
   *
   * The fields above are lossy Numbers for display; strategies-sdk's sizeOpen needs exact
   * bigints, and a float round-trip through a price is enough to misplace a wei.
   */
  raw: {
    ltvBps: bigint
    liquidationThresholdBps: bigint
    /** USD price on Aave's 8-decimal market-reference scale. */
    priceUsd: bigint
    decimals: number
  }
```

- [ ] **Step 4: Populate it**

In the `availableReserves` mapping (around line 285), add after `liquidationThreshold`:

```ts
    raw: {
      ltvBps: BigInt(reserve.baseLTVasCollateral),
      liquidationThresholdBps: BigInt(reserve.reserveLiquidationThreshold),
      priceUsd: BigInt(reserve.priceInMarketReferenceCurrency),
      decimals: Number(reserve.decimals),
    },
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `pnpm exec vitest run src/hooks/useAavePositions.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full gate and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint src/hooks/useAavePositions.ts src/hooks/useAavePositions.test.tsx && pnpm exec vitest run`

```bash
git add src/hooks/useAavePositions.ts src/hooks/useAavePositions.test.tsx
git commit -m "feat(aave): expose raw reserve config at native precision"
```

---

### Task 3: Swap-rate derivation

**Files:**
- Create: `src/lib/openPlan.ts`
- Test: `src/lib/openPlan.test.ts`

**Interfaces:**
- Produces: `rateFromOracle(p: OracleRateInput): bigint`, `rateFromQuote(p: { amountIn: bigint; amountOut: bigint }): bigint`. Both return `rateWad` — collateral wei obtained per 1 debt wei, scaled by `WAD` — which is exactly what `sizeOpen`'s `rateWad` parameter takes.

Background: `sizeOpen` cannot quote a DEX, so the caller supplies the rate. It comes from two places: the Aave oracle (a free seed, mid-market and therefore optimistic) and a real aggregator quote (authoritative for the size actually being traded).

```
rateFromOracle = (debtPriceUsd * 10**collateralDecimals * WAD)
               / (collateralPriceUsd * 10**debtDecimals)

rateFromQuote  = amountOut * WAD / amountIn
```

The expected values below were computed and verified numerically before being written down. If a test fails, the bug is in your transcription — do not adjust an expected value.

- [ ] **Step 1: Write the failing test**

Create `src/lib/openPlan.test.ts`:

```ts
import { expect, it } from 'vitest'
import { rateFromOracle, rateFromQuote } from './openPlan'

// Aave prices are on an 8-decimal USD scale: WETH $2500, USDC $1.
const WETH_USD = 250_000_000_000n
const USDC_USD = 100_000_000n

it('derives the oracle rate for an 18-decimal collateral against a 6-decimal debt', () => {
  // Long WETH: collateral WETH (18dp), debt USDC (6dp). One USDC wei buys 4e8 WETH wei.
  expect(
    rateFromOracle({
      collateralPriceUsd: WETH_USD, debtPriceUsd: USDC_USD,
      collateralDecimals: 18, debtDecimals: 6,
    }),
  ).toBe(400000000000000000000000000n)
})

it('derives the oracle rate in the inverted direction', () => {
  // Short WETH: collateral USDC (6dp), debt WETH (18dp).
  expect(
    rateFromOracle({
      collateralPriceUsd: USDC_USD, debtPriceUsd: WETH_USD,
      collateralDecimals: 6, debtDecimals: 18,
    }),
  ).toBe(2_500_000_000n)
})

it('returns 0 when a price is missing, so sizeOpen rejects rather than dividing by zero', () => {
  expect(
    rateFromOracle({
      collateralPriceUsd: 0n, debtPriceUsd: USDC_USD,
      collateralDecimals: 18, debtDecimals: 6,
    }),
  ).toBe(0n)
})

it('derives the real rate from a quote', () => {
  // 2512.562815 USDC in, 1.004102773 WETH out — slightly worse than the oracle's 4e26.
  const rate = rateFromQuote({ amountIn: 2_512_562_815n, amountOut: 1_004_102_773_000_000_000n })
  expect(rate).toBe(399632903506135825702729744n)
  expect(rate).toBeLessThan(400000000000000000000000000n)
})

it('returns 0 for a zero-input quote rather than throwing', () => {
  expect(rateFromQuote({ amountIn: 0n, amountOut: 1n })).toBe(0n)
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/openPlan.test.ts`
Expected: FAIL — cannot resolve `./openPlan`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/openPlan.ts`:

```ts
/**
 * Pure math for opening a leveraged position.
 *
 * Everything strategies-sdk's sizeOpen needs that the SDK deliberately does not do itself:
 * turning prices and quotes into a swap rate, deciding whether a re-quote is warranted, and
 * bounding the leverage slider. No React, no network, no config.
 */
import { BPS, WAD, LTV_CEILING_FACTOR_BPS, maxLeverageForHealthFactorBps, maxLeverageForLtvBps } from './strategies-sdk'

export interface OracleRateInput {
  /** Aave oracle prices, both on the same fixed-point scale. */
  collateralPriceUsd: bigint
  debtPriceUsd: bigint
  collateralDecimals: number
  debtDecimals: number
}

/**
 * A seed rate from oracle prices, in collateral wei per debt wei scaled by WAD.
 *
 * Free — costs no network call. But oracle prices are mid-market: they know nothing about the
 * DEX spread or this trade's price impact, so a size derived from this alone runs optimistic
 * and must be verified against a real quote before it is signed.
 *
 * Returns 0 when either price is missing, so sizeOpen rejects with ZERO_RATE instead of the
 * caller dividing by zero here.
 */
export function rateFromOracle(p: OracleRateInput): bigint {
  if (p.collateralPriceUsd <= 0n || p.debtPriceUsd <= 0n) return 0n
  return (
    (p.debtPriceUsd * 10n ** BigInt(p.collateralDecimals) * WAD) /
    (p.collateralPriceUsd * 10n ** BigInt(p.debtDecimals))
  )
}

/**
 * The rate an aggregator actually offered, in collateral wei per debt wei scaled by WAD.
 *
 * Authoritative for the size it was quoted at and no other — pricing is non-linear, so a rate
 * measured at one amount understates the impact of a materially larger one.
 */
export function rateFromQuote(p: { amountIn: bigint; amountOut: bigint }): bigint {
  if (p.amountIn <= 0n) return 0n
  return (p.amountOut * WAD) / p.amountIn
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/openPlan.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full gate and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/openPlan.ts src/lib/openPlan.test.ts && pnpm exec vitest run`

```bash
git add src/lib/openPlan.ts src/lib/openPlan.test.ts
git commit -m "feat(open): swap-rate derivation from oracle prices and quotes"
```

---

### Task 4: Refine decision, minOut, and leverage ceilings

**Files:**
- Modify: `src/lib/openPlan.ts` (append)
- Modify: `src/lib/openPlan.test.ts` (append)

**Interfaces:**
- Consumes: `BPS`, `WAD`, `LTV_CEILING_FACTOR_BPS`, `maxLeverageForLtvBps`, `maxLeverageForHealthFactorBps` from `./strategies-sdk` (already imported in Task 3).
- Produces: `MAX_REFINE_ROUNDS`, `OPEN_TARGET_HF_BPS`, `needsRequote(quotedAmountIn, resizedAmountIn): boolean`, `minOutFromBuild(p): bigint`, `leverageCeilingBps(p): { soft: bigint | null; hard: bigint | null }`.

Background on each:

**`needsRequote`** — after re-sizing against the quoted rate, the borrow moves. Re-quote **only if it grew**: a larger trade takes more price impact than the quote measured, so its rate is optimistic. A smaller trade prices at least as well, so proceeding on the existing quote is safe and saves a round-trip.

**`minOutFromBuild`** — `sizeOpen` computes a `minOut` from its own expectation, but `buildTransaction` re-simulates the route and returns an authoritative `amountOut` (see `TransactionPayload.amountOut`'s doc comment in `src/adapters/types.ts`). Recompute the floor from that, and never let it fall below `flashAmount` — the contract enforces both, and an output short of the flash reverts the whole transaction.

**`leverageCeilingBps`** — the slider needs two bounds. `hard` is the LTV wall with the SDK's 0.98 haircut applied; exceed it and Aave's borrow reverts. `soft` is the leverage that holds `OPEN_TARGET_HF_BPS`. `soft` is `null` when the target HF is at or below the reserve's liquidation threshold (unreachable at any finite leverage) — the slider then runs to `hard`. `hard` is `null` for an LTV at or above 100%, which is not a valid reserve.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/openPlan.test.ts`, extending the existing `./openPlan` import rather than adding a second one:

```ts
import {
  MAX_REFINE_ROUNDS,
  OPEN_TARGET_HF_BPS,
  leverageCeilingBps,
  minOutFromBuild,
  needsRequote,
} from './openPlan'

it('re-quotes only when the re-sized borrow grew past what was priced', () => {
  // Bigger trade than the quote measured — its rate is optimistic, so re-price it.
  expect(needsRequote(2_512_562_815n, 2_514_875_291n)).toBe(true)
  // Smaller trade prices at least as well; the existing quote is a safe floor.
  expect(needsRequote(2_512_562_815n, 2_500_000_000n)).toBe(false)
  expect(needsRequote(2_512_562_815n, 2_512_562_815n)).toBe(false)
})

it('caps refinement at two rounds', () => {
  expect(MAX_REFINE_ROUNDS).toBe(2)
})

it('floors minOut at the flash amount when slippage would drop below it', () => {
  // 1.004 WETH out at 0.5% slippage is 0.99908 WETH — short of the 1.0 WETH flash repayment.
  expect(
    minOutFromBuild({
      buildAmountOut: 1_004_102_773_000_000_000n,
      slippageBps: 50n,
      flashAmount: 1_000_000_000_000_000_000n,
    }),
  ).toBe(1_000_000_000_000_000_000n)
})

it('uses the slippage floor when it clears the flash amount', () => {
  expect(
    minOutFromBuild({
      buildAmountOut: 1_050_000_000_000_000_000n,
      slippageBps: 50n,
      flashAmount: 1_000_000_000_000_000_000n,
    }),
  ).toBe(1_044_750_000_000_000_000n)
})

it('bounds the leverage slider with a soft HF ceiling below the hard LTV wall', () => {
  // WETH: LTV 75%, LT 80%. Hard wall 4.00x, haircut to 3.92x. HF 1.5 holds at 2.14x.
  expect(OPEN_TARGET_HF_BPS).toBe(15_000n)
  expect(leverageCeilingBps({ ltvBps: 7500n, liquidationThresholdBps: 8000n })).toEqual({
    soft: 21_428n,
    hard: 39_200n,
  })
})

it('drops the soft ceiling when the target HF is unreachable at any leverage', () => {
  // HF decays toward LT as leverage rises, so a target at or below LT has no finite solution.
  expect(leverageCeilingBps({ ltvBps: 7500n, liquidationThresholdBps: 15_000n })).toEqual({
    soft: null,
    hard: 39_200n,
  })
})

it('reports no hard wall for an LTV at or above 100%', () => {
  expect(leverageCeilingBps({ ltvBps: 10_000n, liquidationThresholdBps: 8000n }).hard).toBeNull()
})

it('never lets the soft ceiling exceed the hard wall', () => {
  // A very permissive LT against a restrictive LTV would otherwise put soft above hard.
  const { soft, hard } = leverageCeilingBps({ ltvBps: 2000n, liquidationThresholdBps: 9500n })
  expect(hard).toBe(12_250n)
  expect(soft).toBe(12_250n)
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/openPlan.test.ts`
Expected: FAIL — `needsRequote` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/openPlan.ts`:

```ts
/** Quote, re-size, and at most one re-quote. Pricing is non-linear; a third round buys nothing. */
export const MAX_REFINE_ROUNDS = 2

/**
 * The health factor the leverage slider's safe range is built around.
 *
 * Fixed in this phase rather than user-configurable: the danger zone past it is an explicit
 * opt-in, which is a clearer control than letting the boundary itself be dragged.
 */
export const OPEN_TARGET_HF_BPS = 15_000n

/**
 * Whether the re-sized borrow warrants a fresh quote.
 *
 * Only growth does. A larger trade eats more price impact than the quote measured, so its rate
 * is optimistic and re-pricing is the honest move. A smaller trade prices at least as well —
 * the quote is a conservative floor for it, and re-quoting would only cost a round-trip.
 */
export function needsRequote(quotedAmountIn: bigint, resizedAmountIn: bigint): boolean {
  return resizedAmountIn > quotedAmountIn
}

/**
 * The swap-output floor to send on-chain, derived from the BUILT route.
 *
 * Built from `buildTransaction`'s amountOut rather than the quote's, because the build is
 * re-simulated and therefore authoritative — see TransactionPayload.amountOut.
 *
 * Never drops below `flashAmount`: the contract enforces both floors, and an output short of
 * the flash repayment reverts the whole transaction rather than merely disappointing.
 */
export function minOutFromBuild(p: {
  buildAmountOut: bigint
  slippageBps: bigint
  flashAmount: bigint
}): bigint {
  const slippageFloor = (p.buildAmountOut * (BPS - p.slippageBps)) / BPS
  return slippageFloor > p.flashAmount ? slippageFloor : p.flashAmount
}

/**
 * The two bounds the leverage slider needs.
 *
 * `hard` is Aave's LTV wall with the SDK's haircut applied — past it the borrow itself
 * reverts. `soft` is the leverage that still holds OPEN_TARGET_HF_BPS, and is the end of the
 * slider's safe range; the stretch between soft and hard is the opt-in danger zone.
 *
 * `soft` is null when the target HF is unreachable at any finite leverage, and `hard` is null
 * for an LTV at or above 100% — neither is a valid Aave reserve, but neither should throw.
 */
export function leverageCeilingBps(p: {
  ltvBps: bigint
  liquidationThresholdBps: bigint
}): { soft: bigint | null; hard: bigint | null } {
  const wall = maxLeverageForLtvBps(p.ltvBps)
  if (wall === null) return { soft: null, hard: null }

  const hard = (wall * LTV_CEILING_FACTOR_BPS) / BPS
  const target = maxLeverageForHealthFactorBps(p.liquidationThresholdBps, OPEN_TARGET_HF_BPS)
  if (target === null) return { soft: null, hard }

  return { soft: target > hard ? hard : target, hard }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/openPlan.test.ts`
Expected: PASS (13 tests total).

- [ ] **Step 5: Full gate and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/openPlan.ts src/lib/openPlan.test.ts && pnpm exec vitest run`

```bash
git add src/lib/openPlan.ts src/lib/openPlan.test.ts
git commit -m "feat(open): refine decision, minOut from build, leverage ceilings"
```

---

### Task 5: Decode the contract's custom errors

**Files:**
- Create: `src/lib/strategiesErrors.ts`
- Test: `src/lib/strategiesErrors.test.ts`

**Interfaces:**
- Produces: `type StrategiesFailure = { error: string; message: string; remedy: 'widen-slippage' | 'requote' | 'refresh' | 'none' }`, `decodeStrategiesError(err: unknown): StrategiesFailure | null`.

Background — this exists because two of the contract's errors mean different things and have **different remedies**, which is exactly why the contract splits them:

| Custom error | Meaning | Remedy |
| --- | --- | --- |
| `InsufficientOutputFromRouter` | The swap returned less than `minOut` | `widen-slippage` |
| `InsufficientOutputForFlashLoanRepayment` | Output didn't cover `flashAmount` — the borrow was undersized because the rate moved | `requote` |
| `RouterNotAllowed`, `Paused` | The owner changed config mid-flight | `refresh` |
| `ZeroAmount`, `SameAsset`, `ZeroAddress`, `NoDebt` | Caller-side mistakes that shouldn't reach a user | `none` |

Telling a user to raise slippage on a flash-repayment shortfall is wrong advice — the swap did clear their tolerance; the borrow was simply too small.

`src/utils/errors.ts` only extracts generic revert text, so this is new. The four-byte selectors are decoded via viem's `decodeErrorResult` against the SDK's ABI, so no selector needs hardcoding.

- [ ] **Step 1: Write the failing test**

Create `src/lib/strategiesErrors.test.ts`:

```ts
import { expect, it } from 'vitest'
import { toFunctionSelector } from 'viem'
import { decodeStrategiesError } from './strategiesErrors'

/** viem surfaces a revert with the raw error data hung off the error chain. */
function revertWith(signature: string) {
  return { cause: { data: toFunctionSelector(signature) } }
}

it('maps a router shortfall to widening slippage', () => {
  const failure = decodeStrategiesError(revertWith('InsufficientOutputFromRouter()'))
  expect(failure?.error).toBe('InsufficientOutputFromRouter')
  expect(failure?.remedy).toBe('widen-slippage')
})

it('maps a flash-repayment shortfall to re-quoting, NOT to widening slippage', () => {
  // The swap cleared minOut; the borrow was undersized because the rate moved. Telling the
  // user to raise their slippage here would be wrong advice.
  const failure = decodeStrategiesError(revertWith('InsufficientOutputForFlashLoanRepayment()'))
  expect(failure?.error).toBe('InsufficientOutputForFlashLoanRepayment')
  expect(failure?.remedy).toBe('requote')
})

it('maps owner config changes to a refresh', () => {
  expect(decodeStrategiesError(revertWith('Paused()'))?.remedy).toBe('refresh')
  expect(decodeStrategiesError(revertWith('RouterNotAllowed()'))?.remedy).toBe('refresh')
})

it('maps caller-side mistakes to no remedy', () => {
  expect(decodeStrategiesError(revertWith('ZeroAmount()'))?.remedy).toBe('none')
})

it('returns null for anything that is not a Strategies revert', () => {
  expect(decodeStrategiesError(new Error('user rejected the request'))).toBeNull()
  expect(decodeStrategiesError(revertWith('SomeOtherError()'))).toBeNull()
  expect(decodeStrategiesError(undefined)).toBeNull()
})

it('gives every mapped error a non-empty human message', () => {
  for (const sig of [
    'InsufficientOutputFromRouter()',
    'InsufficientOutputForFlashLoanRepayment()',
    'Paused()',
    'RouterNotAllowed()',
    'ZeroAmount()',
  ]) {
    expect(decodeStrategiesError(revertWith(sig))?.message.length).toBeGreaterThan(0)
  }
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/lib/strategiesErrors.test.ts`
Expected: FAIL — cannot resolve `./strategiesErrors`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/strategiesErrors.ts`:

```ts
/**
 * Turns an AaveV3Strategies revert into something a user can act on.
 *
 * The distinction that earns this module its existence: a router shortfall and a flash-repayment
 * shortfall look identical in a wallet, but the first means the swap missed the user's slippage
 * tolerance and the second means the borrow was sized too small for a rate that moved. Offering
 * "increase slippage" for the second would send the user round the same loop again.
 */
import { decodeErrorResult, parseAbi, type Hex } from 'viem'

export type StrategiesRemedy = 'widen-slippage' | 'requote' | 'refresh' | 'none'

export interface StrategiesFailure {
  /** The Solidity error name, for logs. */
  error: string
  /** What to show the user. */
  message: string
  remedy: StrategiesRemedy
}

/** Only the errors a user can actually trip; the callback-guard errors are unreachable from here. */
const errorAbi = parseAbi([
  'error InsufficientOutputFromRouter()',
  'error InsufficientOutputForFlashLoanRepayment()',
  'error RouterNotAllowed()',
  'error Paused()',
  'error ZeroAmount()',
  'error SameAsset()',
  'error ZeroAddress()',
  'error NoDebt()',
] as const)

const FAILURES: Record<string, { message: string; remedy: StrategiesRemedy }> = {
  InsufficientOutputFromRouter: {
    message: 'The swap returned less than your slippage tolerance allowed. Try a wider slippage.',
    remedy: 'widen-slippage',
  },
  InsufficientOutputForFlashLoanRepayment: {
    message: 'The price moved and the borrow no longer covers the flash loan. Refresh the quote.',
    remedy: 'requote',
  },
  RouterNotAllowed: {
    message: 'That router is no longer allowlisted. Refresh to pick another route.',
    remedy: 'refresh',
  },
  Paused: { message: 'The contract is paused. Try again later.', remedy: 'refresh' },
  ZeroAmount: { message: 'One of the amounts was zero.', remedy: 'none' },
  SameAsset: { message: 'Collateral and debt must be different assets.', remedy: 'none' },
  ZeroAddress: { message: 'An address was missing.', remedy: 'none' },
  NoDebt: { message: 'This position has no debt.', remedy: 'none' },
}

/** Walks the error chain for the 4-byte revert data viem hangs off `cause`. */
function revertData(err: unknown): Hex | null {
  let node: unknown = err
  for (let depth = 0; node && typeof node === 'object' && depth < 5; depth++) {
    const data = (node as { data?: unknown }).data
    if (typeof data === 'string' && data.startsWith('0x')) return data as Hex
    node = (node as { cause?: unknown }).cause
  }
  return null
}

/** The mapped failure, or null when this is not a Strategies revert we recognise. */
export function decodeStrategiesError(err: unknown): StrategiesFailure | null {
  const data = revertData(err)
  if (!data) return null

  try {
    const { errorName } = decodeErrorResult({ abi: errorAbi, data })
    const mapped = FAILURES[errorName]
    return mapped ? { error: errorName, ...mapped } : null
  } catch {
    // Not one of ours — an unrelated revert, or data too short to decode.
    return null
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/lib/strategiesErrors.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full gate and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint src/lib/strategiesErrors.ts src/lib/strategiesErrors.test.ts && pnpm exec vitest run`

```bash
git add src/lib/strategiesErrors.ts src/lib/strategiesErrors.test.ts
git commit -m "feat(open): decode Strategies custom errors into actionable remedies"
```

---

### Task 6: `useStrategiesOpen` — preview

**Files:**
- Create: `src/hooks/useStrategiesOpen.ts`
- Test: `src/hooks/useStrategiesOpen.test.tsx`

**Interfaces:**
- Consumes: `resolveMode`, `sizeOpen`, `getAllowedRouters`, `getPauseState` from `../lib/strategies-sdk`; `rateFromOracle`, `rateFromQuote`, `needsRequote`, `minOutFromBuild`, `MAX_REFINE_ROUNDS` from `../lib/openPlan`; `getAdaptersForChain` from `../adapters`; `getChainConfig` from `../config/chains`.
- Produces: `interface OpenInput`, `interface OpenPreview`, `useStrategiesOpen(): { preview, previewError, isQuoting, refresh, … }`. Task 7 adds execute to this same hook — do not rename anything here.

Background: the preview runs the seed → quote → re-size → maybe-re-quote → build sequence from the spec. It is debounced, abortable, and never throws — every failure lands in `previewError` as a typed kind.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useStrategiesOpen.test.tsx`, following the mock style of `src/hooks/useAavePositions.test.tsx` (`vi.hoisted` + `vi.mock`, then import the hook):

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  getAllowedRouters: vi.fn(),
  getPauseState: vi.fn(),
  getAdaptersForChain: vi.fn(),
  usePublicClient: vi.fn(),
  useChainId: vi.fn(),
  useConnection: vi.fn(),
}))

vi.mock('wagmi', () => ({
  usePublicClient: mocks.usePublicClient,
  useChainId: mocks.useChainId,
  useConnection: mocks.useConnection,
}))
vi.mock('../adapters', () => ({ getAdaptersForChain: mocks.getAdaptersForChain }))

import { useStrategiesOpen } from './useStrategiesOpen'

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as const
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const
const KYBER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as const
const STRAT = '0x000000000000000000000000000000000000BEEF' as const

const RESERVES = {
  collateral: { address: WETH, decimals: 18, priceUsd: 250_000_000_000n, ltvBps: 7500n, liquidationThresholdBps: 8000n },
  debt: { address: USDC, decimals: 6, priceUsd: 100_000_000n, ltvBps: 8700n, liquidationThresholdBps: 8900n },
}

const INPUT = {
  contract: STRAT, mode: 1 as const, volatile: WETH, stable: USDC,
  marginAmount: 1_000_000_000_000_000_000n, leverageBps: 20_000n, slippageBps: 50n,
  reserves: RESERVES,
}

/** A stub adapter whose quote is a fixed rate, and whose build re-simulates a shade worse. */
function stubAdapter(rateNumeratorPerWei: bigint) {
  return {
    name: 'KyberSwap',
    supportsExecution: true,
    routerAddress: KYBER,
    getQuote: vi.fn(async (_f: unknown, _t: unknown, amountIn: string) => ({
      aggregator: 'KyberSwap',
      amountIn,
      amountOut: (BigInt(amountIn) * rateNumeratorPerWei).toString(),
      amountOutUsd: '0', gasUsd: '0', netReturnUsd: 0,
      routeDetails: { type: 'kyber' as const, totalAmountIn: BigInt(amountIn), paths: [] },
      rawQuote: {},
    })),
    buildTransaction: vi.fn(async (q: { amountIn: string }) => ({
      to: KYBER, data: '0xdeadbeef', value: '0', spender: KYBER,
      amountOut: (BigInt(q.amountIn) * rateNumeratorPerWei).toString(),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.useConnection.mockReturnValue({ address: '0x1111111111111111111111111111111111111111' })
  mocks.usePublicClient.mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'paused') return 0n
      if (functionName === 'getAllowedRouters') return [KYBER]
      return 0n
    }),
  })
})

it('previews a 2x open, sizing against the quoted rate rather than the oracle', async () => {
  // 4e8 WETH wei per USDC wei is exactly the oracle rate, so the sizes are the pinned ones.
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  expect(result.current.preview?.flashAmount).toBe(1_000_000_000_000_000_000n)
  expect(result.current.preview?.borrowAmount).toBe(2_512_562_815n)
  expect(result.current.preview?.expectedLeverageBps).toBe(20_050n)
  expect(result.current.preview?.router).toBe(KYBER)
  expect(result.current.previewError).toBeNull()
})

it('re-quotes once when the re-sized borrow grew, and stops there', async () => {
  // A rate worse than the oracle's makes the second sizing ask for more than was quoted.
  const adapter = stubAdapter(399_000_000n)
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  expect(adapter.getQuote).toHaveBeenCalledTimes(2)
})

it('blocks when the contract is paused', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])
  mocks.usePublicClient.mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'paused' ? 1n : [KYBER],
    ),
  })

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.previewError).not.toBeNull())
  expect(result.current.previewError?.kind).toBe('paused')
})

it('reports a sizing rejection rather than throwing', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])

  const { result } = renderHook(() =>
    useStrategiesOpen({ ...INPUT, leverageBps: 39_200n }), // == the LTV ceiling
  )
  await waitFor(() => expect(result.current.previewError).not.toBeNull())
  expect(result.current.previewError?.kind).toBe('LEVERAGE_ABOVE_LTV')
})

it('reports when no allowlisted router can price the pair', async () => {
  const adapter = stubAdapter(400_000_000n)
  adapter.getQuote = vi.fn(async () => null)
  mocks.getAdaptersForChain.mockReturnValue([adapter])

  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.previewError).not.toBeNull())
  expect(result.current.previewError?.kind).toBe('no-route')
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/hooks/useStrategiesOpen.test.tsx`
Expected: FAIL — cannot resolve `./useStrategiesOpen`.

- [ ] **Step 3: Write the implementation**

Create `src/hooks/useStrategiesOpen.ts`:

```ts
/**
 * Orchestrates opening a leveraged position: preview here, execute in the same hook.
 *
 * The preview is the seed → quote → re-size → maybe-re-quote → build loop. It exists because
 * sizeOpen needs a swap rate it cannot fetch, and the oracle's rate is mid-market — good enough
 * to size a first quote, not good enough to sign.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useChainId, useConnection, usePublicClient } from 'wagmi'
import type { Address, Hex } from 'viem'
import {
  getAllowedRouters,
  getPauseState,
  resolveMode,
  sizeOpen,
  type OpenMode,
  type SizeOpenError,
} from '../lib/strategies-sdk'
import {
  MAX_REFINE_ROUNDS,
  minOutFromBuild,
  needsRequote,
  rateFromOracle,
  rateFromQuote,
} from '../lib/openPlan'
import { getAdaptersForChain } from '../adapters'
import { getChainConfig } from '../config/chains'

export interface ReserveInfo {
  address: Address
  decimals: number
  priceUsd: bigint
  ltvBps: bigint
  liquidationThresholdBps: bigint
}

export interface OpenInput {
  contract: Address
  mode: OpenMode
  volatile: Address
  stable: Address
  marginAmount: bigint
  leverageBps: bigint
  slippageBps: bigint
  reserves: { collateral: ReserveInfo; debt: ReserveInfo }
}

export type PreviewErrorKind = SizeOpenError | 'paused' | 'no-route' | 'no-client' | 'quote-failed'

export interface PreviewError {
  kind: PreviewErrorKind
  message: string
}

export interface OpenPreview {
  collateral: Address
  debtAsset: Address
  marginAsset: Address
  flashAmount: bigint
  borrowAmount: bigint
  minOut: bigint
  expectedCollateral: bigint
  expectedDebt: bigint
  expectedLeverageBps: bigint
  expectedHealthFactorBps: bigint
  router: Address
  swapData: Hex
  /** Aggregator name, for display. */
  aggregator: string
}

const DEBOUNCE_MS = 400

export function useStrategiesOpen(input: OpenInput | null) {
  const client = usePublicClient()
  const chainId = useChainId()
  const { address: owner } = useConnection()

  const [preview, setPreview] = useState<OpenPreview | null>(null)
  const [previewError, setPreviewError] = useState<PreviewError | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)
  const [tick, setTick] = useState(0)

  /** Set while a signature is held, to stop the preview moving underneath it (Task 7). */
  const frozen = useRef(false)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!input || !client || frozen.current) return
    let cancelled = false

    const timer = setTimeout(async () => {
      setIsQuoting(true)
      setPreviewError(null)
      try {
        const { collateral, debtAsset, marginIn } = resolveMode({
          mode: input.mode, volatile: input.volatile, stable: input.stable,
        })

        const [{ paused }, routers] = await Promise.all([
          getPauseState(client, input.contract),
          getAllowedRouters(client, input.contract),
        ])
        if (cancelled) return
        if (paused) {
          setPreviewError({ kind: 'paused', message: 'Leverage is paused.' })
          return
        }

        const coll = input.reserves.collateral
        const debt = input.reserves.debt
        const sizeArgs = {
          marginIn,
          marginAmount: input.marginAmount,
          leverageBps: input.leverageBps,
          collateralPriceUsd: coll.priceUsd,
          debtPriceUsd: debt.priceUsd,
          collateralDecimals: coll.decimals,
          debtDecimals: debt.decimals,
          ltvBps: coll.ltvBps,
          liquidationThresholdBps: coll.liquidationThresholdBps,
          rateBufferBps: input.slippageBps,
          slippageBps: input.slippageBps,
        }

        // Seed off the oracle so the first quote is asked for a plausible size.
        let sized = sizeOpen({ ...sizeArgs, rateWad: rateFromOracle({
          collateralPriceUsd: coll.priceUsd, debtPriceUsd: debt.priceUsd,
          collateralDecimals: coll.decimals, debtDecimals: debt.decimals,
        }) })
        if (!sized.ok) {
          setPreviewError({ kind: sized.error, message: sized.error })
          return
        }

        const allowed = new Set(routers.map((r) => r.toLowerCase()))
        const adapters = getAdaptersForChain(getChainConfig(chainId)?.adapters ?? [])
          .filter((a) => a.supportsExecution)

        const fromAsset = { underlyingAsset: debtAsset, symbol: '', decimals: debt.decimals }
        const toAsset = { underlyingAsset: collateral, symbol: '', decimals: coll.decimals }
        const slippagePercent = Number(input.slippageBps) / 100

        let quote = null
        let adapter = null
        for (let round = 0; round < MAX_REFINE_ROUNDS; round++) {
          const amountIn = sized.size.borrowAmount.toString()
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

          const best = results
            .filter((r): r is NonNullable<typeof r> => r !== null)
            .sort((x, y) => (BigInt(y.q.amountOut) > BigInt(x.q.amountOut) ? 1 : -1))[0]
          if (!best) break

          quote = best.q
          adapter = best.a

          const resized = sizeOpen({ ...sizeArgs, rateWad: rateFromQuote({
            amountIn: BigInt(quote.amountIn), amountOut: BigInt(quote.amountOut),
          }) })
          if (!resized.ok) {
            setPreviewError({ kind: resized.error, message: resized.error })
            return
          }

          const grew = needsRequote(BigInt(quote.amountIn), resized.size.borrowAmount)
          sized = resized
          if (!grew) break
        }

        if (!quote || !adapter) {
          setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
          return
        }

        const built = await adapter.buildTransaction(quote, slippagePercent, input.contract, chainId)
        if (cancelled) return
        if (!allowed.has(built.to.toLowerCase())) {
          setPreviewError({ kind: 'no-route', message: 'No allowlisted router can price this pair.' })
          return
        }

        setPreview({
          collateral, debtAsset,
          marginAsset: marginIn === 'collateral' ? collateral : debtAsset,
          flashAmount: sized.size.flashAmount,
          borrowAmount: sized.size.borrowAmount,
          minOut: minOutFromBuild({
            buildAmountOut: BigInt(built.amountOut ?? quote.amountOut),
            slippageBps: input.slippageBps,
            flashAmount: sized.size.flashAmount,
          }),
          expectedCollateral: sized.size.expectedCollateral,
          expectedDebt: sized.size.expectedDebt,
          expectedLeverageBps: sized.size.expectedLeverageBps,
          expectedHealthFactorBps: sized.size.expectedHealthFactorBps,
          router: built.to as Address,
          swapData: built.data as Hex,
          aggregator: adapter.name,
        })
      } catch {
        if (!cancelled) {
          setPreviewError({ kind: 'quote-failed', message: 'Could not price this position.' })
        }
      } finally {
        if (!cancelled) setIsQuoting(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [input, client, chainId, owner, tick])

  return { preview, previewError, isQuoting, refresh, frozen }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/hooks/useStrategiesOpen.test.tsx`
Expected: PASS (5 tests). The tests use fake-timer-free `waitFor`, so the 400 ms debounce simply elapses.

- [ ] **Step 5: Full gate and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint src/hooks/useStrategiesOpen.ts src/hooks/useStrategiesOpen.test.tsx && pnpm exec vitest run`

```bash
git add src/hooks/useStrategiesOpen.ts src/hooks/useStrategiesOpen.test.tsx
git commit -m "feat(open): preview loop — seed, quote, re-size, build"
```

---

### Task 7: `useStrategiesOpen` — execute

**Files:**
- Modify: `src/hooks/useStrategiesOpen.ts`
- Modify: `src/hooks/useStrategiesOpen.test.tsx`

**Interfaces:**
- Consumes: everything from Task 6, plus `getDelegationAllowance`, `getPermitContext`, `planOpen`, `buildCreditDelegation`, `toStrategiesSig`, `ZERO_STRATEGIES_SIG`, `aaveV3StrategiesAbi` from `../lib/strategies-sdk`; `getReserveTokens` from `../lib/aaveStatics`; `decodeStrategiesError` from `../lib/strategiesErrors`.
- Produces: added to the hook's return — `execute(): Promise<void>`, `step: OpenStep`, `txHash`, `execError`. `type OpenStep = 'idle' | 'approving' | 'signing' | 'sending' | 'done' | 'error'`.

Background — three wallet interactions, two of them skippable:

| Step | Skipped when |
| --- | --- |
| Approve `marginAsset` for the contract | existing allowance ≥ margin |
| Sign credit delegation over the exact `borrowAmount` | `getDelegationAllowance` ≥ borrowAmount → ship `ZERO_STRATEGIES_SIG` |
| `writeContract(planOpen(…))` | never |

**The freezing rule is the load-bearing part.** The delegation signature commits to an exact `borrowAmount` — the contract borrows precisely the signed value. So `frozen.current` is set to `true` before the first prompt and cleared when the flow ends. While frozen, the preview effect returns early, so a debounce landing mid-flow cannot re-size underneath a signature that has already been given.

- [ ] **Step 1: Write the failing test**

Append to `src/hooks/useStrategiesOpen.test.tsx`:

```tsx
it('skips the signature prompt when an existing delegation already covers the borrow', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])
  const signTypedData = vi.fn()
  mocks.usePublicClient.mockReturnValue({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'paused') return 0n
      if (functionName === 'getAllowedRouters') return [KYBER]
      if (functionName === 'borrowAllowance') return 10_000_000_000n // covers 2512.56 USDC
      if (functionName === 'allowance') return 10n ** 30n // margin already approved
      return 0n
    }),
  })

  const { result } = renderHook(() => useStrategiesOpen(INPUT, { signTypedData }))
  await waitFor(() => expect(result.current.preview).not.toBeNull())
  await result.current.execute()

  expect(signTypedData).not.toHaveBeenCalled()
})

it('freezes the preview while a signature is held', async () => {
  mocks.getAdaptersForChain.mockReturnValue([stubAdapter(400_000_000n)])
  const { result } = renderHook(() => useStrategiesOpen(INPUT))
  await waitFor(() => expect(result.current.preview).not.toBeNull())

  const before = result.current.preview
  result.current.frozen.current = true
  result.current.refresh()
  // A refresh while frozen must not replace the plan the signature commits to.
  await waitFor(() => expect(result.current.preview).toBe(before))
})
```

Wire the write path through an injected dependency object (second argument) rather than importing wagmi's write hooks directly, so the test can drive it. Default it to the real wagmi calls.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/hooks/useStrategiesOpen.test.tsx`
Expected: FAIL — `result.current.execute` is not a function.

- [ ] **Step 3: Write the implementation**

Add to `src/hooks/useStrategiesOpen.ts`. Extend the imports, add the step state, and add `execute`:

```ts
export type OpenStep = 'idle' | 'approving' | 'signing' | 'sending' | 'done' | 'error'

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const)

/** How long a delegation signature stays valid. Long enough to survive a build and inclusion. */
const SIGNATURE_TTL_S = 1800n
```

Inside the hook, after the preview effect:

```ts
  const [step, setStep] = useState<OpenStep>('idle')
  const [txHash, setTxHash] = useState<Hex | undefined>()
  const [execError, setExecError] = useState<string | null>(null)

  const execute = useCallback(async () => {
    if (!input || !preview || !client || !owner) return

    // The delegation signs an exact borrowAmount, so the plan must not move once we start.
    frozen.current = true
    setExecError(null)
    try {
      const { variableDebtToken } = await getReserveTokens(client, chainId, preview.debtAsset)

      // 1. Approve the margin, unless the allowance already covers it.
      setStep('approving')
      const allowance = (await client.readContract({
        address: preview.marginAsset, abi: ERC20_ABI, functionName: 'allowance',
        args: [owner, input.contract],
      })) as bigint
      if (allowance < input.marginAmount) {
        await deps.writeContract({
          address: preview.marginAsset, abi: ERC20_ABI, functionName: 'approve',
          args: [input.contract, input.marginAmount],
        })
      }

      // 2. Delegate credit, unless a standing delegation already covers this borrow.
      setStep('signing')
      const standing = await getDelegationAllowance(client, variableDebtToken, owner, input.contract)
      let delegation = ZERO_STRATEGIES_SIG
      if (standing < preview.borrowAmount) {
        const ctx = await getPermitContext(client, variableDebtToken, owner)
        const deadline = BigInt(Math.floor(Date.now() / 1000)) + SIGNATURE_TTL_S
        const signature = await deps.signTypedData(
          buildCreditDelegation({
            chainId, debtToken: variableDebtToken, debtTokenName: ctx.name,
            delegatee: input.contract, value: preview.borrowAmount,
            nonce: ctx.nonce, deadline,
          }),
        )
        delegation = toStrategiesSig(signature, deadline)
      }

      // 3. Send.
      setStep('sending')
      const plan = planOpen({
        mode: input.mode, volatile: input.volatile, stable: input.stable,
        flashAmount: preview.flashAmount, borrowAmount: preview.borrowAmount,
        marginAmount: input.marginAmount, minOut: preview.minOut,
        router: preview.router, swapData: preview.swapData, delegation,
      })
      const hash = await deps.writeContract({
        address: input.contract, abi: aaveV3StrategiesAbi,
        functionName: plan.functionName, args: plan.args,
      })
      setTxHash(hash)
      setStep('done')
    } catch (err) {
      const decoded = decodeStrategiesError(err)
      setExecError(decoded?.message ?? extractRevertMessage(err))
      setStep('error')
    } finally {
      frozen.current = false
    }
  }, [input, preview, client, owner, chainId, deps])
```

Add `step`, `txHash`, `execError`, `execute` to the returned object.

The write path goes through an injected `deps` object — the hook's optional second argument — so the tests can drive it without a wallet. Add this above the hook, and the default wiring inside it:

```ts
export interface OpenDeps {
  writeContract: (args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }) => Promise<Hex>
  signTypedData: (payload: unknown) => Promise<Hex>
}
```

Inside the hook, before `execute`:

```ts
  // wagmi's hooks must be called unconditionally, so they run even when deps are injected —
  // the injected object simply wins.
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()

  const deps: OpenDeps = injected ?? {
    writeContract: (args) => writeContractAsync(args as Parameters<typeof writeContractAsync>[0]),
    signTypedData: (payload) => signTypedDataAsync(payload as Parameters<typeof signTypedDataAsync>[0]),
  }
```

and change the hook's signature to `useStrategiesOpen(input: OpenInput | null, injected?: OpenDeps)`. Add `useSignTypedData` and `useWriteContract` to the `wagmi` import, and `parseAbi` to the `viem` import.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/hooks/useStrategiesOpen.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Full gate and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint src/hooks/useStrategiesOpen.ts src/hooks/useStrategiesOpen.test.tsx && pnpm exec vitest run`

```bash
git add src/hooks/useStrategiesOpen.ts src/hooks/useStrategiesOpen.test.tsx
git commit -m "feat(open): execute — approve, delegate, send, with the plan frozen at signing"
```

---

### Task 8: `PositionPreview` component

**Files:**
- Create: `src/components/PositionPreview.tsx`
- Test: `src/components/PositionPreview.test.tsx`

**Interfaces:**
- Consumes: `OpenPreview` from `../hooks/useStrategiesOpen`; `computeLiquidationView` from `../utils/liquidation`; `evaluateHf` from `../utils/health`; `LiquidationPriceBlock` from `./LiquidationPriceBlock`.
- Produces: `<PositionPreview preview={…} collateralSymbol={…} debtSymbol={…} collateralDecimals={…} debtDecimals={…} />`.

Liquidation price and health-factor colouring are **not** recomputed here — `src/utils/liquidation.ts` and `src/utils/health.ts` already own them, and duplicating either would let the two drift.

- [ ] **Step 1: Write the failing test**

Create `src/components/PositionPreview.test.tsx`:

```tsx
import { expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PositionPreview } from './PositionPreview'

const PREVIEW = {
  collateral: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  debtAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  marginAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  flashAmount: 1_000_000_000_000_000_000n,
  borrowAmount: 2_512_562_815n,
  minOut: 1_000_000_000_370_000_000n,
  expectedCollateral: 2_005_025_126_000_000_000n,
  expectedDebt: 2_512_562_815n,
  expectedLeverageBps: 20_050n,
  expectedHealthFactorBps: 15_959n,
  router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  swapData: '0x',
  aggregator: 'KyberSwap',
} as const

it('shows the resulting position, not the inputs', () => {
  render(
    <PositionPreview
      preview={PREVIEW} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
    />,
  )
  expect(screen.getByText(/2\.005/)).toBeTruthy()      // collateral
  expect(screen.getByText(/2,512\.56/)).toBeTruthy()   // debt
  expect(screen.getByText(/1\.60/)).toBeTruthy()       // health factor
  expect(screen.getByText(/2\.00x/)).toBeTruthy()      // realized leverage
  expect(screen.getByText(/KyberSwap/)).toBeTruthy()
})

it('renders nothing when there is no preview yet', () => {
  const { container } = render(
    <PositionPreview
      preview={null} collateralSymbol="WETH" debtSymbol="USDC"
      collateralDecimals={18} debtDecimals={6}
      collateralPriceUsd={2500} debtPriceUsd={1} liquidationThreshold={0.8}
    />,
  )
  expect(container.firstChild).toBeNull()
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/components/PositionPreview.test.tsx`
Expected: FAIL — cannot resolve `./PositionPreview`.

- [ ] **Step 3: Write the implementation**

Create `src/components/PositionPreview.tsx`:

```tsx
import { formatUnits } from 'viem'
import type { OpenPreview } from '../hooks/useStrategiesOpen'
import { evaluateHf } from '../utils/health'
import { computeLiquidationView } from '../utils/liquidation'
import { LiquidationPriceBlock } from './LiquidationPriceBlock'
import { T } from '../styles/theme'

interface PositionPreviewProps {
  preview: OpenPreview | null
  collateralSymbol: string
  debtSymbol: string
  collateralDecimals: number
  debtDecimals: number
  collateralPriceUsd: number
  debtPriceUsd: number
  /** The collateral reserve's liquidation threshold as a FRACTION, e.g. 0.83 — not bps. */
  liquidationThreshold: number
}

function fmt(amount: bigint, decimals: number, places: number): string {
  return Number(formatUnits(amount, decimals)).toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
}

/**
 * What the position becomes if this opens.
 *
 * Liquidation price and health-factor colouring come from the shared utils rather than being
 * recomputed — one owner each, so the portfolio and this preview can never disagree.
 */
export function PositionPreview({
  preview, collateralSymbol, debtSymbol,
  collateralDecimals, debtDecimals, collateralPriceUsd, debtPriceUsd, liquidationThreshold,
}: PositionPreviewProps) {
  if (!preview) return null

  const collateralAmount = Number(formatUnits(preview.expectedCollateral, collateralDecimals))
  const debtAmount = Number(formatUnits(preview.expectedDebt, debtDecimals))
  const hf = Number(preview.expectedHealthFactorBps) / 10000
  const hfLevel = evaluateHf(hf)

  // computeLiquidationView takes POSITIONAL args — a collateral array and the debt in USD.
  // `liquidationThreshold` is load-bearing here: it is what turns collateral into the weighted
  // value the liquidation price solves against, so it must be the reserve's real fraction.
  const liquidationView = computeLiquidationView(
    [{
      symbol: collateralSymbol,
      amount: collateralAmount,
      priceUsd: collateralPriceUsd,
      liquidationThreshold,
    }],
    debtAmount * debtPriceUsd,
  )

  const rows: Array<[string, string]> = [
    ['Collateral', `${fmt(preview.expectedCollateral, collateralDecimals, 4)} ${collateralSymbol}`],
    ['Debt', `${fmt(preview.expectedDebt, debtDecimals, 2)} ${debtSymbol}`],
    ['Leverage', `${(Number(preview.expectedLeverageBps) / 10000).toFixed(2)}x`],
    ['Route', preview.aggregator],
  ]

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: T.space[2],
      padding: T.space[3], background: T.bg,
      border: `1px solid ${T.border}`, borderRadius: T.radius.lg,
      fontSize: T.fontSize.base,
    }}>
      <div style={{ fontSize: T.fontSize.xs, color: T.textSecondary, textTransform: 'uppercase' }}>
        You will end up with
      </div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: T.textSecondary }}>{label}</span>
          <span style={{ fontWeight: 600 }}>{value}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: T.textSecondary }}>Health factor</span>
        <span style={{ fontWeight: 600, color: hfLevel.level === 'ok' ? T.success : hfLevel.level === 'warn' ? T.warning : T.danger }}>
          {hf.toFixed(2)}
        </span>
      </div>
      <LiquidationPriceBlock view={liquidationView} isModal />
    </div>
  )
}
```

Both utility signatures were read from source when this plan was written: `computeLiquidationView(collateral: CollateralInput[], debtUsd: number)` and `evaluateHf(projectedHf: string | number): { level, message? }`. Do not modify either module.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/components/PositionPreview.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Full gate and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint src/components/PositionPreview.tsx src/components/PositionPreview.test.tsx && pnpm exec vitest run`

```bash
git add src/components/PositionPreview.tsx src/components/PositionPreview.test.tsx
git commit -m "feat(open): position preview with shared HF and liquidation rendering"
```

---

### Task 9: `OpenPositionForm` component

**Files:**
- Create: `src/components/OpenPositionForm.tsx`
- Test: `src/components/OpenPositionForm.test.tsx`

**Interfaces:**
- Consumes: `leverageCeilingBps`, `OPEN_TARGET_HF_BPS` from `../lib/openPlan`.
- Produces: `<OpenPositionForm … />` with props `{ marginStr, onMarginChange, marginBalance, marginSymbol, marginIn, onMarginInChange, collateralSymbol, debtSymbol, leverageBps, onLeverageChange, ltvBps, liquidationThresholdBps, dangerEnabled, onDangerToggle }`.

Background: the slider's default maximum is the **soft** ceiling from `leverageCeilingBps`. The stretch from soft to hard is the danger zone and requires the explicit `dangerEnabled` toggle. When `soft` is `null` the slider runs to `hard`; when `hard` is `null` the whole control is disabled, because the reserve is not usable as collateral.

- [ ] **Step 1: Write the failing test**

Create `src/components/OpenPositionForm.test.tsx`:

```tsx
import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { OpenPositionForm } from './OpenPositionForm'

const BASE = {
  marginStr: '1.0', onMarginChange: vi.fn(), marginBalance: '4.2', marginSymbol: 'WETH',
  marginIn: 'collateral' as const, onMarginInChange: vi.fn(),
  collateralSymbol: 'WETH', debtSymbol: 'USDC',
  leverageBps: 20_000n, onLeverageChange: vi.fn(),
  ltvBps: 7500n, liquidationThresholdBps: 8000n,
  dangerEnabled: false, onDangerToggle: vi.fn(),
}

it('caps the slider at the soft health-factor ceiling by default', () => {
  render(<OpenPositionForm {...BASE} />)
  // WETH at LT 80% holds HF 1.5 up to 2.14x.
  expect(screen.getByRole('slider').getAttribute('max')).toBe('21428')
})

it('extends the slider to the hard LTV wall once the danger zone is enabled', () => {
  render(<OpenPositionForm {...BASE} dangerEnabled />)
  expect(screen.getByRole('slider').getAttribute('max')).toBe('39200')
})

it('disables the control entirely when the reserve has no valid LTV', () => {
  render(<OpenPositionForm {...BASE} ltvBps={10_000n} />)
  expect(screen.getByRole('slider').hasAttribute('disabled')).toBe(true)
})

it('shows the margin balance as the ceiling for the amount', () => {
  render(<OpenPositionForm {...BASE} />)
  expect(screen.getByText(/max 4\.2 WETH/i)).toBeTruthy()
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/components/OpenPositionForm.test.tsx`
Expected: FAIL — cannot resolve `./OpenPositionForm`.

- [ ] **Step 3: Write the implementation**

Create `src/components/OpenPositionForm.tsx`:

```tsx
import { leverageCeilingBps } from '../lib/openPlan'
import { T } from '../styles/theme'

interface OpenPositionFormProps {
  marginStr: string
  onMarginChange: (value: string) => void
  marginBalance: string
  marginSymbol: string
  marginIn: 'collateral' | 'debt'
  onMarginInChange: (value: 'collateral' | 'debt') => void
  collateralSymbol: string
  debtSymbol: string
  leverageBps: bigint
  onLeverageChange: (value: bigint) => void
  ltvBps: bigint
  liquidationThresholdBps: bigint
  dangerEnabled: boolean
  onDangerToggle: (on: boolean) => void
}

const MIN_LEVERAGE_BPS = 10_100n

/**
 * Margin amount, which asset it is posted in, and how much leverage.
 *
 * The slider stops at the health-factor ceiling by default. Past it is the stretch where a
 * modest adverse move liquidates, so reaching it takes an explicit toggle rather than a drag.
 */
export function OpenPositionForm(p: OpenPositionFormProps) {
  const { soft, hard } = leverageCeilingBps({
    ltvBps: p.ltvBps,
    liquidationThresholdBps: p.liquidationThresholdBps,
  })
  const usable = hard !== null
  const max = !usable ? MIN_LEVERAGE_BPS : p.dangerEnabled || soft === null ? hard : soft
  const leverage = (Number(p.leverageBps) / 10000).toFixed(2)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: T.space[3] }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm }}>
        <span style={{ color: T.textSecondary }}>Margin</span>
        <span style={{ color: T.textSecondary }}>max {p.marginBalance} {p.marginSymbol}</span>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: T.space[2],
        border: `1px solid ${T.border}`, borderRadius: T.radius.md, padding: T.space[2],
        background: T.surface,
      }}>
        <input
          value={p.marginStr}
          onChange={(e) => p.onMarginChange(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          aria-label="Margin amount"
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: T.fontSize.md, background: 'transparent' }}
        />
        <span style={{ fontWeight: 600 }}>{p.marginSymbol}</span>
      </div>

      <div style={{ display: 'flex', gap: T.space[2], alignItems: 'center', fontSize: T.fontSize.sm }}>
        <span style={{ color: T.textSecondary }}>pay with</span>
        {(['collateral', 'debt'] as const).map((role) => (
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
            {role === 'collateral' ? p.collateralSymbol : p.debtSymbol}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: T.fontSize.sm }}>
        <span style={{ color: T.textSecondary }}>Leverage</span>
        <span style={{ fontWeight: 600 }}>{leverage}x</span>
      </div>
      <input
        type="range"
        role="slider"
        min={Number(MIN_LEVERAGE_BPS)}
        max={Number(max)}
        step={100}
        value={Number(p.leverageBps)}
        disabled={!usable}
        onChange={(e) => p.onLeverageChange(BigInt(e.target.value))}
        aria-label="Leverage"
      />

      {usable && soft !== null && hard > soft && (
        <label style={{ display: 'flex', gap: T.space[2], fontSize: T.fontSize.sm, color: T.textSecondary }}>
          <input
            type="checkbox"
            checked={p.dangerEnabled}
            onChange={(e) => p.onDangerToggle(e.target.checked)}
          />
          Allow leverage above {(Number(soft) / 10000).toFixed(2)}x — closer to liquidation
        </label>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/components/OpenPositionForm.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Full gate and commit**

Run: `pnpm exec tsc -b && pnpm exec eslint src/components/OpenPositionForm.tsx src/components/OpenPositionForm.test.tsx && pnpm exec vitest run`

```bash
git add src/components/OpenPositionForm.tsx src/components/OpenPositionForm.test.tsx
git commit -m "feat(open): margin and leverage form with a health-factor capped slider"
```

---

### Task 10: `LeverageActions` panel and mount

**Files:**
- Create: `src/components/LeverageActions.tsx`
- Test: `src/components/LeverageActions.test.tsx`
- Modify: `src/components/AavePosition.tsx`

**Interfaces:**
- Consumes: `getStrategiesAddress` from `../config/chains`; `useStrategiesOpen` from `../hooks/useStrategiesOpen`; `OpenPositionForm`, `PositionPreview`.
- Produces: `<LeverageActions suppliedAssets={…} availableReserves={…} viewAddress={…} />`.

Background — the gating rules, all three of which are visible behaviour a reviewer can check:

- `getStrategiesAddress(chainId) === null` → render nothing at all
- `viewAddress` set (viewing someone else's portfolio) → render nothing, matching how the DEX tab already behaves
- `previewError.kind === 'paused'` → render the panel, disabled, with a banner

Boost and Repay are visible but disabled tabs, so phase 3 slots in without relayout.

- [ ] **Step 1: Write the failing test**

Create `src/components/LeverageActions.test.tsx`:

```tsx
import { expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  getStrategiesAddress: vi.fn(),
  useStrategiesOpen: vi.fn(),
  useChainId: vi.fn(),
}))

vi.mock('../config/chains', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStrategiesAddress: mocks.getStrategiesAddress,
}))
vi.mock('../hooks/useStrategiesOpen', () => ({ useStrategiesOpen: mocks.useStrategiesOpen }))
vi.mock('wagmi', () => ({ useChainId: mocks.useChainId, useConnection: () => ({ address: undefined }) }))

import { LeverageActions } from './LeverageActions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useChainId.mockReturnValue(1)
  mocks.useStrategiesOpen.mockReturnValue({
    preview: null, previewError: null, isQuoting: false,
    refresh: vi.fn(), frozen: { current: false },
    execute: vi.fn(), step: 'idle', txHash: undefined, execError: null,
  })
})

const PROPS = { suppliedAssets: [], availableReserves: [], viewAddress: undefined }

it('renders nothing while the contract is undeployed', () => {
  mocks.getStrategiesAddress.mockReturnValue(null)
  const { container } = render(<LeverageActions {...PROPS} />)
  expect(container.firstChild).toBeNull()
})

it('renders nothing while viewing another address', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  const { container } = render(<LeverageActions {...PROPS} viewAddress="0xabc" />)
  expect(container.firstChild).toBeNull()
})

it('shows Long and Short, with Boost and Repay present but disabled', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  render(<LeverageActions {...PROPS} />)
  expect(screen.getByText('Long')).toBeTruthy()
  expect(screen.getByText('Short')).toBeTruthy()
  expect(screen.getByRole('tab', { name: /boost/i }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('tab', { name: /repay/i }).hasAttribute('disabled')).toBe(true)
})

it('disables the action and explains when the contract is paused', () => {
  mocks.getStrategiesAddress.mockReturnValue('0x000000000000000000000000000000000000BEEF')
  mocks.useStrategiesOpen.mockReturnValue({
    preview: null, previewError: { kind: 'paused', message: 'Leverage is paused.' },
    isQuoting: false, refresh: vi.fn(), frozen: { current: false },
    execute: vi.fn(), step: 'idle', txHash: undefined, execError: null,
  })
  render(<LeverageActions {...PROPS} />)
  expect(screen.getByText(/paused/i)).toBeTruthy()
  expect(screen.getByRole('button', { name: /open position/i }).hasAttribute('disabled')).toBe(true)
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run src/components/LeverageActions.test.tsx`
Expected: FAIL — cannot resolve `./LeverageActions`.

- [ ] **Step 3: Write the implementation**

Create `src/components/LeverageActions.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { parseUnits } from 'viem'
import { useChainId } from 'wagmi'
import type { AvailableReserve, SuppliedAsset } from '../hooks/useAavePositions'
import { useStrategiesOpen } from '../hooks/useStrategiesOpen'
import { getStrategiesAddress } from '../config/chains'
import { OpenPositionForm } from './OpenPositionForm'
import { PositionPreview } from './PositionPreview'
import { T } from '../styles/theme'

interface LeverageActionsProps {
  suppliedAssets: SuppliedAsset[]
  availableReserves: AvailableReserve[]
  viewAddress?: `0x${string}`
}

type Direction = 'long' | 'short'

const SIDEBAR: Array<{ key: Direction; title: string; blurb: (v: string, s: string) => string }> = [
  { key: 'long', title: 'Long', blurb: (v, s) => `Collateralize ${v}, borrow ${s}.` },
  { key: 'short', title: 'Short', blurb: (v, s) => `Collateralize ${s}, borrow ${v}.` },
]

const DEFAULT_SLIPPAGE_BPS = 50n

export function LeverageActions({ suppliedAssets, availableReserves, viewAddress }: LeverageActionsProps) {
  const chainId = useChainId()
  const contract = getStrategiesAddress(chainId)

  const [direction, setDirection] = useState<Direction>('long')
  const [marginIn, setMarginIn] = useState<'collateral' | 'debt'>('collateral')
  const [marginStr, setMarginStr] = useState('')
  const [leverageBps, setLeverageBps] = useState(20_000n)
  const [dangerEnabled, setDangerEnabled] = useState(false)

  // Default pair: the first volatile reserve against the first stable one.
  const volatileReserve = availableReserves.find((r) => Number(r.priceInUsd) > 1.02) ?? availableReserves[0]
  const stableReserve = availableReserves.find((r) => Math.abs(Number(r.priceInUsd) - 1) <= 0.02)

  const long = direction === 'long'
  const collateralReserve = long ? volatileReserve : stableReserve
  const debtReserve = long ? stableReserve : volatileReserve
  const mode = long ? (marginIn === 'collateral' ? 1 : 2) : marginIn === 'debt' ? 3 : 4

  const marginReserve = marginIn === 'collateral' ? collateralReserve : debtReserve
  const marginBalance = suppliedAssets.find((a) => a.symbol === marginReserve?.symbol)?.amount ?? 0

  const input = useMemo(() => {
    if (!contract || !volatileReserve || !stableReserve || !collateralReserve || !debtReserve) return null
    let marginAmount: bigint
    try {
      marginAmount = parseUnits(marginStr || '0', marginReserve?.raw.decimals ?? 18)
    } catch {
      return null
    }
    if (marginAmount <= 0n) return null
    return {
      contract,
      mode: mode as 1 | 2 | 3 | 4,
      volatile: volatileReserve.underlyingAsset,
      stable: stableReserve.underlyingAsset,
      marginAmount,
      leverageBps,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
      reserves: {
        collateral: { address: collateralReserve.underlyingAsset, ...collateralReserve.raw },
        debt: { address: debtReserve.underlyingAsset, ...debtReserve.raw },
      },
    }
  }, [contract, mode, volatileReserve, stableReserve, collateralReserve, debtReserve, marginReserve, marginStr, leverageBps])

  const { preview, previewError, isQuoting, execute, step } = useStrategiesOpen(input)

  // The contract is undeployed, or we are looking at someone else's portfolio.
  if (!contract || viewAddress) return null

  const paused = previewError?.kind === 'paused'
  const sizingMessage = previewError && !paused ? previewError.message : null
  const busy = step === 'approving' || step === 'signing' || step === 'sending'

  return (
    <div style={{
      marginTop: T.space[4], background: T.surface,
      border: `1px solid ${T.border}`, borderRadius: T.radius.lg, boxShadow: T.shadow.card,
    }}>
      <div style={{ display: 'flex', gap: T.space[2], padding: T.space[3], borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: T.fontSize.xs, color: T.textSecondary, textTransform: 'uppercase', alignSelf: 'center' }}>
          Actions
        </span>
        <button role="tab" aria-selected style={{ padding: `${T.space[1]} ${T.space[3]}`, borderRadius: T.radius.md, border: 'none', background: T.text, color: '#fff', cursor: 'pointer' }}>
          Open
        </button>
        <button role="tab" disabled title="Coming soon" style={{ padding: `${T.space[1]} ${T.space[3]}`, borderRadius: T.radius.md, border: 'none', background: 'transparent', color: T.textSecondary }}>
          Boost
        </button>
        <button role="tab" disabled title="Coming soon" style={{ padding: `${T.space[1]} ${T.space[3]}`, borderRadius: T.radius.md, border: 'none', background: 'transparent', color: T.textSecondary }}>
          Repay
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 220px', borderRight: `1px solid ${T.border}`, padding: T.space[3] }}>
          {SIDEBAR.map((item) => (
            <button
              key={item.key}
              onClick={() => setDirection(item.key)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                padding: T.space[3], marginBottom: T.space[2],
                borderRadius: T.radius.md,
                border: `1px solid ${direction === item.key ? T.primary : 'transparent'}`,
                background: direction === item.key ? T.bg : 'transparent',
              }}
            >
              <div style={{ fontWeight: 600 }}>{item.title}</div>
              <div style={{ fontSize: T.fontSize.sm, color: T.textSecondary }}>
                {item.blurb(volatileReserve?.symbol ?? '—', stableReserve?.symbol ?? '—')}
              </div>
            </button>
          ))}
        </div>

        <div style={{ flex: '1 1 320px', padding: T.space[3], display: 'flex', flexDirection: 'column', gap: T.space[3] }}>
          <div style={{ fontSize: T.fontSize.sm, color: T.textSecondary }}>
            Supply {collateralReserve?.symbol} → Borrow {debtReserve?.symbol} → Swap → Supply{' '}
            {collateralReserve?.symbol}, in one transaction.
          </div>

          {paused && (
            <div style={{ padding: T.space[2], borderRadius: T.radius.md, background: '#fef3c7', color: '#92400e', fontSize: T.fontSize.sm }}>
              Leverage is paused.
            </div>
          )}

          <OpenPositionForm
            marginStr={marginStr}
            onMarginChange={setMarginStr}
            marginBalance={marginBalance.toString()}
            marginSymbol={marginReserve?.symbol ?? '—'}
            marginIn={marginIn}
            onMarginInChange={setMarginIn}
            collateralSymbol={collateralReserve?.symbol ?? '—'}
            debtSymbol={debtReserve?.symbol ?? '—'}
            leverageBps={leverageBps}
            onLeverageChange={setLeverageBps}
            ltvBps={collateralReserve?.raw.ltvBps ?? 0n}
            liquidationThresholdBps={collateralReserve?.raw.liquidationThresholdBps ?? 0n}
            dangerEnabled={dangerEnabled}
            onDangerToggle={setDangerEnabled}
          />

          {sizingMessage && (
            <div style={{ fontSize: T.fontSize.sm, color: T.danger }}>{sizingMessage}</div>
          )}

          <PositionPreview
            preview={preview}
            collateralSymbol={collateralReserve?.symbol ?? '—'}
            debtSymbol={debtReserve?.symbol ?? '—'}
            collateralDecimals={collateralReserve?.raw.decimals ?? 18}
            debtDecimals={debtReserve?.raw.decimals ?? 18}
            collateralPriceUsd={Number(collateralReserve?.priceInUsd ?? 0)}
            debtPriceUsd={Number(debtReserve?.priceInUsd ?? 0)}
            liquidationThreshold={collateralReserve?.liquidationThreshold ?? 0}
          />

          <div style={{ fontSize: T.fontSize.sm, color: T.textSecondary }}>
            {(['approving', 'signing', 'sending'] as const).map((s, i) => (
              <span key={s} style={{ fontWeight: step === s ? 700 : 400, color: step === s ? T.text : T.textSecondary }}>
                {i > 0 && ' · '}
                {s === 'approving' ? 'approve' : s === 'signing' ? 'sign' : 'send'}
              </span>
            ))}
          </div>

          <button
            onClick={() => void execute()}
            disabled={!preview || isQuoting || paused || busy}
            style={{
              padding: T.space[3], borderRadius: T.radius.md, border: 'none', cursor: 'pointer',
              background: !preview || isQuoting || paused || busy ? T.border : T.primary,
              color: '#fff', fontWeight: 600,
            }}
          >
            Open position
          </button>
        </div>
      </div>
    </div>
  )
}
```

If a field name on `SuppliedAsset` or `AvailableReserve` differs from what is used above, read `src/hooks/useAavePositions.ts` and use the real name — do not add fields to that hook beyond the `raw` block from Task 2.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm exec vitest run src/components/LeverageActions.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Mount it in the portfolio**

In `src/components/AavePosition.tsx`, add the lazy import beside the existing `ClosePositionModal` one (around line 21):

```tsx
const LeverageActions = lazyModal(() => import('./LeverageActions').then((m) => m.LeverageActions))
```

Render it after the borrowed-assets section and before the closing element of the component's main container:

```tsx
<LeverageActions
  suppliedAssets={suppliedAssets}
  availableReserves={availableReserves}
  viewAddress={viewAddress}
/>
```

Use the same prop names the component's test uses. If `availableReserves` is not already in scope in `AavePosition.tsx`, pull it from the existing `useAavePositions` call rather than adding a second call.

- [ ] **Step 6: Verify the app still builds and the panel stays hidden**

Run: `pnpm exec tsc -b && pnpm exec vitest run`
Expected: clean, all tests passing.

Run: `pnpm dev`, open the Aave tab, and confirm the portfolio renders exactly as before — the panel is correctly absent, because `getStrategiesAddress` returns `null` while the contract is undeployed.

- [ ] **Step 7: Full gate and commit**

Run: `pnpm exec eslint src/components/LeverageActions.tsx src/components/LeverageActions.test.tsx src/components/AavePosition.tsx`

```bash
git add src/components/LeverageActions.tsx src/components/LeverageActions.test.tsx src/components/AavePosition.tsx
git commit -m "feat(open): ACTIONS panel with Long/Short sidebar, mounted on the Aave tab"
```

---

## Done criteria

- `pnpm exec tsc -b` clean, `pnpm exec vitest run` green.
- `src/lib/closePlan.test.ts` passes unchanged — the close flow's behaviour is untouched by the `swapRoute.ts` extraction.
- The Aave tab renders exactly as it did before, because `getStrategiesAddress` returns `null`.
- Setting `VITE_STRATEGIES_ADDRESS_1` to a deployed address reveals the panel.

## Manual verification is blocked until deployment

The happy path cannot be clicked through: the contract is undeployed, so the panel hides itself. Per the spec, the intended route is to deploy `AaveV3Strategies` to a local anvil mainnet fork and point `VITE_STRATEGIES_ADDRESS_1` at it, which exercises the real flow against real Aave reserves and real router liquidity. That deployment is **not** part of this plan — it is a prerequisite for manual verification, not for the code landing.

Do not read, edit, or stage `.env` at any point; the address is supplied locally by the developer.
