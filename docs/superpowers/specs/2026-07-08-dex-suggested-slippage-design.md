# DEX-Suggested Slippage Tolerance — Design

**Date:** 2026-07-08
**Component:** DEX Discovery (`src/components/DexDiscovery.tsx`) + swap adapters

## Problem

Slippage tolerance in DEX Discovery is a single fixed value defaulting to **1%**, chosen
entirely by the user via presets (0.1 / 0.5 / 1.0%) and a custom input. It is not informed
by the actual trade being routed. We want the slippage to be **suggested by the DEX** for the
current pair/amount, applied automatically, while still letting the user override it.

## Reality check: what the aggregator APIs expose

None of the five adapters' APIs return a literal "recommended slippage" field. They do return
enough to **derive** one from the DEX's own numbers:

| Aggregator | Signal in raw response | Source of price impact |
|---|---|---|
| OpenOcean | `price_impact` (e.g. `"-0.34%"`) | explicit field |
| KyberSwap | `amountInUsd` / `amountOutUsd` on `routeSummary` | `(inUsd - outUsd) / inUsd` |
| ParaSwap  | `srcUSD` / `destUSD` on `priceRoute` | `(srcUSD - destUSD) / srcUSD` |
| Odos (DefiLlama) | `priceImpact` when present | explicit field |
| CowSwap   | nothing usable | → fallback |

So "suggested by the DEX" = **each adapter reports its own price impact, converted into a
suggested slippage** (`impact + safety buffer`, clamped). This is genuinely the DEX's own data,
not an invented heuristic. Where a DEX returns no usable signal, we fall back to a default.

## Design

### 1. Data layer — suggestion travels with each quote

Add an optional field to `QuoteResponse` (`src/adapters/types.ts`):

```ts
export interface QuoteResponse {
  // ...existing...
  /** DEX-suggested slippage tolerance in percent (e.g. 0.3 = 0.3%). Undefined if the
   *  aggregator returned no usable price-impact signal. */
  suggestedSlippage?: number;
}
```

### 2. Shared helper — `src/utils/slippage.ts`

One place owns the impact→slippage math and the clamp, so all adapters agree.

```ts
export const FALLBACK_SLIPPAGE = 0.5;   // % — used when no DEX suggestion is available
const BUFFER = 0.1;                     // % added on top of observed price impact
const MIN_SUGGESTED = 0.1;              // % floor
const MAX_SUGGESTED = 5;                // % cap

/** Convert an observed price impact (%, always treated as its absolute value) into a
 *  suggested slippage tolerance. Returns undefined when impact is not a finite number. */
export function suggestedSlippageFromImpact(impactPercent: number | undefined): number | undefined;

/** Price impact (%) from input/output USD values. Returns undefined if inputs are unusable
 *  (missing, <= 0, or non-finite). Negative impact (positive slippage to user) clamps to 0. */
export function impactFromUsd(inUsd: number, outUsd: number): number | undefined;
```

- `suggestedSlippageFromImpact` rounds to a sensible step (2 decimal places) and clamps to
  `[MIN_SUGGESTED, MAX_SUGGESTED]`.
- Adapters that have an explicit `price_impact`/`priceImpact` string parse it (strip `%`,
  `Math.abs`) and call `suggestedSlippageFromImpact`.
- Adapters with only USD values call `impactFromUsd` then `suggestedSlippageFromImpact`.
- CowSwap leaves `suggestedSlippage` undefined.

### 3. Adapter changes

Each `getQuote` populates `suggestedSlippage` before returning:

- **OpenOcean:** parse `result.price_impact`.
- **KyberSwap:** `impactFromUsd(Number(routeSummary.amountInUsd), Number(routeSummary.amountOutUsd))`.
- **ParaSwap:** `impactFromUsd(Number(priceRoute.srcUSD), Number(priceRoute.destUSD))`.
- **Odos:** parse `json.priceImpact` if present, else leave undefined.
- **CowSwap:** unchanged (undefined).

No change to any `buildTransaction` — slippage still flows in the same way.

### 4. UI layer — `DexDiscovery.tsx`

Replace the bare `slippage` state with slippage + an `overridden` flag:

```ts
const [slippage, setSlippage] = useState<number>(FALLBACK_SLIPPAGE); // default now 0.5%, not 1%
const [slippageOverridden, setSlippageOverridden] = useState(false);
```

**Auto-follow behavior:**
- The best route is `validRoutes[0]` (already sorted by net return).
- An effect watches the best route's `suggestedSlippage`. While `!slippageOverridden`, it sets
  `slippage` to that suggestion (or `FALLBACK_SLIPPAGE` if the best route has none).
- The suggestion is re-applied as the best route changes during live streaming — but only while
  the user has not overridden.

**Override behavior:**
- Clicking any preset button or editing the custom input calls `setSlippageOverridden(true)`
  in addition to `setSlippage(...)`. From then on, auto-follow is disabled and the user's value
  sticks for the session.
- A **"reset to suggested"** affordance sets `slippageOverridden(false)`, which re-enables
  auto-follow (immediately snapping back to the current best-route suggestion).

**Display:**
- An **"Auto"** chip in the slippage row, visually active when `!slippageOverridden`.
- A hint line under the presets: *"Suggested by {bestRoute.aggregator}: {suggested}%"* when a
  suggestion exists; when overridden, show the "reset to suggested" link instead.
- Presets stay `[0.1, 0.5, 1.0]`.

## Data flow

```
getQuote (per adapter) --price impact--> suggestedSlippageFromImpact --> QuoteResponse.suggestedSlippage
                                                                              |
DexDiscovery: validRoutes[0].suggestedSlippage --(if !overridden)--> setSlippage
                                                                              |
user clicks preset / edits input --> setSlippageOverridden(true) (auto-follow off)
                                                                              |
slippage --> adapter.getQuote / adapter.buildTransaction / min-output display (unchanged)
```

## Error handling / edge cases

- Missing or non-finite USD / impact values → helper returns `undefined` → adapter omits the
  field → UI uses `FALLBACK_SLIPPAGE` (0.5%).
- Negative price impact (user gains) → treated as 0 impact → suggestion floors at 0.1%.
- Impact above cap (very illiquid) → suggestion clamps to 5%; user can still override higher.
- Best route changes mid-stream while not overridden → slippage updates to the new best route's
  suggestion (acceptable; keeps the shown min-output consistent with the leading quote).
- User overrides, then the pair/amount changes: override persists (matches "user's value sticks
  for the session"); they can hit "reset to suggested" to return to auto.

## Testing

- **Unit (helpers):** `impactFromUsd` and `suggestedSlippageFromImpact` — normal case, zero/negative
  impact, missing inputs, clamp at floor and cap, rounding.
- **Adapter parsing:** given a representative raw response fixture per adapter, `getQuote` yields the
  expected `suggestedSlippage` (and `undefined` for CowSwap).
- **UI behavior (manual walkthrough acceptable if no RTL harness):** default shows 0.5% before quotes;
  auto-follows best route suggestion; clicking a preset freezes it; "reset to suggested" re-enables
  auto-follow.

## Out of scope

- Per-aggregator independent slippage (the UI slippage stays a single global value).
- Changing preset values or the min-output math.
- Deleverage flow (`useDeleverageClose.ts`) slippage — unchanged.
