# Leverage Open UI — Design

**Date:** 2026-08-09
**Status:** Approved, ready for implementation planning
**Scope:** Phase 2 of the AaveV3Strategies FE integration — the UI and orchestration for opening a
leveraged position with fresh margin.

**Depends on:** `docs/superpowers/specs/2026-08-08-strategies-sdk-design.md` (phase 1, shipped)

## Goal

Let a user open a leveraged Aave position in one transaction: pick a direction, post margin, choose
leverage, review the resulting position, and sign. Built entirely on the phase-1 SDK
(`src/lib/strategies-sdk/`), which is complete and tested.

## Context

The contract `AaveV3Strategies.sol` exposes two open entry points, selected by which asset the
margin arrives in. The phase-1 SDK already provides `resolveMode`, `sizeOpen`, `planOpen`, the
EIP-712 builders, and the on-chain reads. What is missing is the swap-rate derivation, the
orchestration, and the UI.

The contract is **not deployed**. `getStrategiesAddress(chainId)` returns `null` on every chain, so
the UI hides itself. That is the intended state, not a bug.

## Non-goals

- **Boost** (increase leverage on an existing position via the zero-margin ratchet). The contract
  supports it; `sizeOpen` does not — it solves against fresh margin, not existing collateral and
  debt. Needs a `sizeRatchet` first.
- **Repay / deleverage** (partial close). Needs partial-close sizing, which was deliberately
  removed in phase 1 (`maxSafeCollateralWithdraw`) and must be rebuilt.
- Migrating the existing close flow off `AaveV3Deleverager`.
- Restyling the existing modals. That ships separately and first, as its own change, so any visual
  regression in Supply/Borrow/Withdraw/Repay/Close is not entangled with this feature.

Boost and Repay render as visible but disabled tabs, so the panel's final shape is established now
and phase 3 slots in without relayout.

## Layout

An **ACTIONS panel** on the Aave Portfolio tab, below the portfolio, modelled on the reference UI
the user supplied. It is always reachable, including with an empty portfolio — a user with no
position is exactly the user most likely to want to open one. The "Leverage" buttons on position
rows scroll to the panel and pre-select that asset.

```
ACTIONS   [ Open ]  Boost   Repay
┌─────────────────────┬─────────────────────────────────────┐
│ △ Long              │  Long WETH                          │
│   Collateralize     │  Supply WETH → Borrow USDC → Swap   │
│   WETH, borrow      │  → Supply WETH, in one transaction. │
│   USDC.             │                                     │
│                     │  Margin              (max 4.2 WETH) │
│ ▽ Short             │  ┌────────────────┬────────┬───────┐│
│   Collateralize     │  │ 1.0            │ WETH ▾ │ USDC ▾││
│   USDC, borrow      │  └────────────────┴────────┴───────┘│
│   WETH.             │  pay with  [● WETH] [○ USDC]        │
│                     │                                     │
│                     │  Leverage ────●──────── 2.0x        │
│                     │  1x                        3.92x    │
│                     │  ▸ approve · sign · send            │
│                     │           [   Open position   ]     │
└─────────────────────┴─────────────────────────────────────┘
```

The sidebar carries the **directional bet** — the decision that actually matters. Which asset the
margin arrives in is a secondary segmented toggle on the margin input, defaulted to whichever asset
the wallet holds. `resolveMode` turns the (direction, margin asset) pair into the contract's mode,
so the UI never hand-derives the role mapping.

**Leverage slider** runs from 1x to the soft ceiling from `maxLeverageForHealthFactorBps`, evaluated
at an exported constant `OPEN_TARGET_HF_BPS = 15000n` (HF 1.5) — a fixed value in this phase, not a
user setting. For WETH at LT 80% that is 2.14x. A clearly-marked danger zone extends to the hard
wall from `maxLeverageForLtvBps` (3.92x after the 0.98 haircut) and requires an explicit opt-in
toggle. Approaching liquidation should be a deliberate act, not a slider overshoot.

`maxLeverageForHealthFactorBps` returns `null` when the target HF is at or below the reserve's
liquidation threshold — unreachable at any finite leverage. In that case the soft ceiling is
skipped and the slider runs to the hard wall directly.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/lib/swapRoute.ts` | **Moved** out of `closePlan.ts`: `routeCostPercent`, `PRICE_IMPACT_HIGH_PERCENT`, `PRICE_IMPACT_BLOCK_PERCENT`, `MAX_OUTPUT_DEGRADATION_PERCENT`, `isSlippageShapedFailure`, `suggestWiderSlippage`, `canReuseSignature`, `reuseBlocker`, `HeldSignature`, `SignatureNeed` |
| `src/lib/openPlan.ts` | **New**, pure — no React, no fetch: `rateFromOracle`, `rateFromQuote`, the refine-round decision, preview assembly |
| `src/hooks/useStrategiesOpen.ts` | **New** — orchestration only: preview, and approve → sign → send |
| `src/components/LeverageActions.tsx` | **New** — panel shell, Open/Boost/Repay tabs, Long/Short sidebar |
| `src/components/OpenPositionForm.tsx` | **New** — asset pair, margin input + pay-with toggle, leverage slider |
| `src/components/PositionPreview.tsx` | **New** — collateral, debt, HF, liquidation price, route, price impact |

`closePlan.ts` re-exports everything moved to `swapRoute.ts`, so the live close flow is behaviourally
untouched and its existing tests keep passing against the same import path.

Six focused files rather than two large ones. This is deliberate: `ClosePositionModal.tsx` is 860
lines and `useDeleverageClose.ts` is 889, and repeating that shape would put the riskiest logic
inside an untestable React component.

### Reused, not rebuilt

- **Liquidation price** — `sizeOpen` returns `expectedCollateral`/`expectedDebt`; `PositionPreview`
  feeds those to `computeLiquidationView` (`src/utils/liquidation.ts`) and renders through the
  existing `LiquidationPriceBlock`.
- **Health factor thresholds** — `evaluateHf`, `HF_WARN`, `HF_BLOCK` from `src/utils/health.ts`.
- **Reserve token addresses** — `getReserveTokens` from `src/lib/aaveStatics.ts`, already cached.
- **Quoting** — the existing adapters in `src/adapters/`.

### The reserve-data seam

`useAavePositions` currently exposes reserve figures as lossy `Number`s
(`priceInMarketReferenceCurrency / 1e8`, `reserveLiquidationThreshold / 10000`) and does not extract
`baseLTVasCollateral` at all — though the field *is* returned by the UI Pool Data Provider and is
present in `uiPoolDataProviderAbi.ts`.

`sizeOpen` needs `bigint` at native precision. So `useAavePositions` gains an additive `raw` field
per reserve carrying `ltvBps`, `liquidationThresholdBps`, `priceUsd` (8 decimals) and `decimals`.
Additive means every existing consumer of the display values is unaffected. This is the only change
to an existing hook.

## Data flow

### Preview (debounced on every input change)

1. `resolveMode({ mode, volatile, stable })` → `{ collateral, debtAsset, marginIn }`
2. `rateFromOracle(prices, decimals)` → seed `rateWad`
3. `sizeOpen(...)` → seed `borrowAmount`
4. Quote that amount across adapters whose router is in `getAllowedRouters()` **and** whose
   `supportsExecution` is true — this excludes CowSwap structurally rather than by hardcoded name
5. `rateFromQuote(quote)` → measured `rateWad` → `sizeOpen` again → final amounts
6. Re-quote **once** if and only if the re-sized borrow is *larger* than the amount that was quoted.
   A larger trade takes more price impact than the quote measured, so its rate is optimistic. A
   smaller trade prices at least as well, so it is safe to proceed on the existing quote. Hard cap
   of two rounds total, mirroring the seed → verify → refine loop in `src/lib/sizing.ts`.
7. `buildTransaction(quote, slippage, STRATEGIES_ADDRESS, chainId)` — the swap recipient is the
   **contract**, not the user. The build always uses the final `borrowAmount`, whether or not a
   re-quote happened, since calldata is amount-specific.
8. `minOut` derives from the build's `amountOut`, not the quote's. `TransactionPayload.amountOut`'s
   own doc comment states the build figure is re-simulated and therefore authoritative

`rateWad` is collateral wei obtained per 1 debt wei, scaled by `WAD`:

```
rateFromOracle = (debtPriceUsd * 10**collateralDecimals * WAD)
               / (collateralPriceUsd * 10**debtDecimals)

rateFromQuote  = amountOut * WAD / amountIn
```

### Execute

| Step | Wallet prompt | Skipped when |
| --- | --- | --- |
| Approve `marginAsset` (from `planOpen`) for the contract | 1 | existing allowance ≥ margin |
| Sign credit delegation over the exact `borrowAmount` | 2 | `getDelegationAllowance` ≥ `borrowAmount` → ship `ZERO_STRATEGIES_SIG` |
| `writeContract(planOpen(...))` | 3 | never |

**The plan freezes at signature time.** The delegation signature commits to an exact
`borrowAmount` — the contract borrows precisely the signed value. So the preview timer stops once
signing begins, and any input change afterwards discards the held signature and restarts the
preview. `canReuseSignature` covers deadline freshness; an exact-amount match is an additional
required check. A preview refresh landing between signing and sending would otherwise send a
transaction whose borrow does not match its signature.

### Gating

- `getStrategiesAddress(chainId) === null` → panel hidden entirely
- View mode (`viewAddress` set) → panel hidden, matching how the DEX tab already behaves
- `getPauseState().paused` → panel visible but disabled, with a banner

## Error handling

### Sizing rejections

Inline field messages, not toasts:

| `SizeOpenError` | Message |
| --- | --- |
| `ZERO_MARGIN` | Enter a margin amount |
| `LEVERAGE_TOO_LOW` | Leverage must be above 1x |
| `LEVERAGE_ABOVE_LTV` | Max leverage for {asset} is {n}x — a backstop; the slider already clamps |
| `ZERO_RATE` / `ZERO_PRICE` | Price data unavailable — retry |
| `INVALID_LTV` | This asset can't be used as collateral |

### Routing

Adapters are filtered to those whose router is on-chain allowlisted and supports execution. If none
can price the pair: *No allowlisted router can price this pair.* Price impact reuses the existing
thresholds — warn at `PRICE_IMPACT_HIGH_PERCENT` (2%), block at `PRICE_IMPACT_BLOCK_PERCENT` (10%).

### Revert decoding

`src/utils/errors.ts` has only generic revert-message extraction. Decoding the contract's custom
errors is new work, and it matters because the two a user will actually hit mean different things
and have **different remedies** — which is precisely why phase 1 split them into distinct errors:

| Custom error | Meaning | Remedy offered |
| --- | --- | --- |
| `InsufficientOutputFromRouter` | Swap returned less than `minOut` | Widen slippage — feeds `suggestWiderSlippage` |
| `InsufficientOutputForFlashLoanRepayment` | Output didn't cover `flashAmount`; the borrow was undersized because the rate moved | Re-quote, or widen the rate buffer. Telling the user to raise slippage here would be wrong advice |
| `RouterNotAllowed`, `Paused` | Owner changed config mid-flight | Refresh and retry |

`isSlippageShapedFailure` currently matches on message text; it gains selector matching for these.

### Rejections

A rejected approve, signature or send returns the flow to idle with inputs intact. Per the freezing
rule above, any input change after signing discards the held signature.

## Testing

- **`openPlan.ts`** carries the weight, as pure vitest units: `rateFromOracle` in both directions
  with 6↔18 decimal pairs; `rateFromQuote`; the refine-round decision and its two-round cap; and
  that `minOut` derives from the build's `amountOut` rather than the quote's.
- **`useStrategiesOpen`** — hook tests with a stubbed client and stubbed adapters, following the
  existing `useAavePositions.test.tsx` pattern under jsdom. Covers: signature skipped when an
  existing delegation already covers the borrow; signature discarded on input change; the two-round
  refine cap; paused blocks execution.
- **Components** — gating only. Hidden when the address is `null`, disabled when paused, slider
  clamped to the soft ceiling until the danger toggle is on.
- **`swapRoute.ts` extraction** — the relevant existing `closePlan.test.ts` cases move with the
  functions, demonstrating the close flow's behaviour is unchanged.

Per-task gate: `pnpm exec tsc -b` clean, `pnpm exec vitest run` green, and no new eslint errors in
touched files. The repo carries a pre-existing eslint backlog in unrelated files, so a clean full
`pnpm lint` is not the bar.

### Manual verification is blocked, and deliberately so

The contract is undeployed, so the panel hides itself and the happy path cannot be clicked through.
The chosen approach is to deploy `AaveV3Strategies` to a **local anvil mainnet fork** and point
`VITE_STRATEGIES_ADDRESS_1` at it, exercising the real flow against real Aave reserves and real
router liquidity. This flow's first real click should not be with real money.

`.env` is never read, edited, or staged; the address is supplied by the developer locally.

## Phase 3 preview (not in this spec)

Boost (`sizeRatchet` — solve leverage-up against existing collateral and debt) and Repay (restore
partial-close sizing, then wire `planClose`). Both slot into the disabled tabs this design
establishes.
