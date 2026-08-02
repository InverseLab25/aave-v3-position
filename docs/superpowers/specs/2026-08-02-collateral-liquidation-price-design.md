# Collateral-side liquidation prices on the Aave dashboard

## Problem

For the overwhelmingly common position shape — volatile collateral (ETH), stablecoin debt
(USDC/USDT) — the dashboard shows no usable liquidation price.

The only liquidation figure on screen lives in the **Borrowed Assets** table
(`src/components/AavePosition.tsx:490`, `:500-505`, `:512`). It answers "what price must this
*debt* asset rise to for HF to reach 1?" For stablecoin debt that yields something like
`$1.40` — a number that will never occur and tells the user nothing.

The number that actually matters is absent: **the ETH price at which the position liquidates.**
Liquidation is driven by collateral price movement, and the collateral side has no liquidation
column at all.

A second, smaller defect in the existing code: when the debt is already fully covered by other
collateral, the formula falls through to the literal string `'At risk'` (`:512`). The truth in
that branch is the exact opposite — the position is *safe*.

## Approved decisions

| Question | Decision |
|---|---|
| How is liquidation risk expressed? | A headline block, not a per-row table column |
| Multi-collateral: which asset? | One row per volatile collateral |
| Row semantics | Isolated — other asset prices held fixed |
| Correlated view | One market-wide line, shown only when ≥2 volatile collaterals |
| Existing borrow-side column | Removed entirely |
| E-Mode calibration | **Not applied** — raw reserve thresholds used directly |
| Tests | Add Vitest; unit-test the pure math module only |

## The math

Collateral set **C** = supplied assets where `usageAsCollateralEnabledOnUser === true`.
A supply with the collateral toggle off carries zero liquidation weight and must be excluded —
including it would overstate safety.

```
Wᵢ = amountᵢ × priceᵢ × LTᵢ        weighted collateral for asset i
W  = Σ Wᵢ                          HF = W / debtUsd
```

`LTᵢ` is that reserve's own `reserveLiquidationThreshold`, not the account-level average.

### Isolated liquidation price for asset j

The price `pⱼ` at which HF reaches exactly 1, with every other asset's price frozen:

```
Rⱼ = debtUsd − (W − Wⱼ)            debt not covered by the other collateral
pⱼ = Rⱼ / (amountⱼ × LTⱼ)
buffer = pⱼ / priceⱼ − 1           negative, e.g. −0.320
```

**When `Rⱼ ≤ 0`** the remaining collateral already covers the debt on its own: asset *j* can fall
to zero without liquidating the position. Render `—` with the tooltip "can't liquidate you alone."
Never synthesise a price here, and never label it as risk.

### Market-wide correlated line

All volatile collateral scales by a common factor `f`; stablecoin collateral holds its value:

```
f    = (debtUsd − W_stable) / W_volatile
drop = f − 1
```

Hidden when `f ≤ 0` (stablecoin collateral alone covers the debt) or when the position holds
fewer than 2 volatile collaterals — with a single volatile collateral this line is
mathematically identical to that asset's own row, so it would be pure noise.

### Volatile detection

```
isVolatile = Math.abs(price − 1) > 0.02
```

Deliberately not a symbol allowlist: an allowlist rots on every new stablecoin listing and
silently mislabels a depegged asset as safe. A genuinely depegged stablecoin growing a
liquidation row is correct behaviour.

## E-Mode: known and accepted limitation

When E-Mode is active, Aave applies the E-Mode category's liquidation threshold to eligible
assets instead of the reserve's own. This spec uses **raw reserve thresholds unconditionally**.

Consequence, accepted deliberately: while E-Mode is ON, raw thresholds are lower than the ones
Aave is actually applying, so the block understates safety — quoted liquidation prices are too
pessimistic, and the HF implied by the block will not match the Health Factor in the header.

Mitigation (in scope, cheap): when `isEModeEnabled` is true, render a caveat line inside the
block noting that E-Mode is active and the prices shown are conservative. This labels the
discrepancy instead of leaving it unexplained.

Out of scope: `getEModes` per-reserve category membership, which would make the numbers exact.
See *Out of scope* below.

## Architecture

### `src/utils/liquidation.ts` (new) — pure, no React/wagmi deps

Mirrors the existing `src/utils/health.ts` shape: plain functions over plain numbers, so the
math is testable without mounting a component or mocking a chain.

```ts
export interface CollateralInput {
  symbol: string
  amount: number
  priceUsd: number
  liquidationThreshold: number   // reserve's own, 0–1
}

export interface LiquidationRow {
  symbol: string
  /** null when this asset cannot liquidate the position on its own. */
  liquidationPriceUsd: number | null
  currentPriceUsd: number
  /** Fractional, negative. null when liquidationPriceUsd is null. */
  bufferPct: number | null
  isVolatile: boolean
}

export interface LiquidationView {
  rows: LiquidationRow[]              // see sort order below; null-price rows last
  /** Fractional, negative. null when not applicable — see hiding rules. */
  marketWideDropPct: number | null
}

export function computeLiquidationView(
  collateral: CollateralInput[],
  debtUsd: number,
): LiquidationView
```

**Sort order: closest to liquidation first** — that is, the asset needing the *smallest* price
drop leads, regardless of position size. Because `bufferPct` is negative, this is `bufferPct`
**descending**: `−25%` sorts above `−32%`, since a 25% fall arrives before a 32% fall.
Rows with a `null` price sort last.

### `src/components/LiquidationPriceBlock.tsx` (new) — presentation only

Consumes `LiquidationView` plus `isEModeEnabled`. No math beyond formatting.

Its own bordered section directly beneath the stats grid, visually anchored near Health Factor.
It does not fit the uniform `.stat` tile grid — the tiles hold one scalar each, this holds a
variable-length list.

```
┌─ Liquidation price ──────────────── each assumes other prices hold ─┐
│   wstETH    $3,105.40      now $4,140.00      −25.0%   ██████░░░░   │
│   WETH      $2,543.10      now $3,740.00      −32.0%   ████████░░   │
│   USDC          —          collateral, can't liquidate you alone    │
│  ─────────────────────────────────────────────────────────────────  │
│   Market-wide: all collateral falling together liquidates at −18.4% │
└─────────────────────────────────────────────────────────────────────┘
```

Follows existing conventions in `AavePosition.tsx`: `T` theme tokens for spacing/type,
`text-danger` / `text-success` for sentiment, `data-label` attributes on cells for the
mobile-stacked layout.

### `src/hooks/useAavePositions.ts` (changed)

Add one field to each `suppliedAssets.push()` (~line 262), matching what `availableReserves`
already does at line 221:

```ts
liquidationThreshold: Number(reserve.reserveLiquidationThreshold) / 10000,
```

No new contract reads — `reserveLiquidationThreshold` is already present on the
`globalReserves` entry in scope at that point.

### `src/components/AavePosition.tsx` (changed)

- Render `<LiquidationPriceBlock>` beneath the stats grid.
- Delete the borrow-side liquidation column: header `:490`, computation `:500-505`, cell `:512`.
- No other borrowed-table columns move.

## Edge cases

| Condition | Behaviour |
|---|---|
| `debtUsd === 0` | Whole block hidden — HF is ∞, nothing to liquidate |
| No collateral with `usageAsCollateralEnabledOnUser` | Block hidden |
| `Rⱼ ≤ 0` for asset *j* | Row shows `—`, "can't liquidate you alone"; never `'At risk'` |
| All collateral is stablecoins | Rows still render; market-wide line hidden |
| Exactly 1 volatile collateral | Market-wide line hidden (identical to that row) |
| `amountⱼ === 0` | Asset skipped entirely |
| `priceⱼ === 0` or missing | Row skipped; cannot compute a meaningful buffer |
| `liquidationThresholdⱼ === 0` | Row shows `—` — asset carries no liquidation weight |
| E-Mode active | Numbers conservative; caveat line rendered |

## Testing

The repo has no frontend test runner — `package.json` exposes only `dev`, `build`, `lint`
(contract tests are Foundry, separate). This spec **adds Vitest** as a dev dependency with a
`test` script, scoped to unit-testing `src/utils/liquidation.ts`. No component tests, no
harness for hooks, no change to how anything ships.

Justification for taking on the dependency: this is pure money math whose failure mode is a
user trusting a wrong liquidation price. The edge-case table above is precisely what unit tests
are for, and several branches (`Rⱼ ≤ 0`, all-stable collateral, single volatile collateral) are
tedious to reach by hand in a browser.

Cases to cover, one per row of the edge-case table, plus:

- Single collateral / single stablecoin debt — the motivating ETH/USDC case, verified against a
  hand-computed figure
- Two volatile collaterals — isolated rows differ from the market-wide figure, and the
  market-wide scenario requires a *smaller* price drop than any individual row (a correlated
  crash liquidates the position before any single asset falling alone would)
- Mixed volatile + stablecoin collateral — stablecoin weight correctly excluded from `W_volatile`
- Row ordering — closest-to-liquidation first, `null` rows last

Additionally: `pnpm build` must pass (`tsc -b` catches the removed borrow-column references),
and `pnpm lint` must pass.

## Out of scope / open items

- **Exact E-Mode thresholds.** Wiring `getEModes` from the UI pool data provider for per-reserve
  category membership would make the numbers exact under E-Mode. Deferred by explicit decision;
  revisit if mixed E-Mode-eligible and ineligible collateral becomes common in practice.
- **Price alerts / notifications** on the liquidation price. Display only.
- **Historical liquidation-price charting.**
- **Borrow-side liquidation prices for volatile debt** (e.g. shorting ETH against USDC
  collateral). The column is being removed outright; if this case matters later it belongs in
  the same block as a distinct row type, not as a resurrected table column.
