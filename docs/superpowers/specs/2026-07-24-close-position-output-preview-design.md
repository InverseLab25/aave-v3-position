# Close Position Modal — Output Preview (Pre-Signature)

Date: 2026-07-24
Status: Approved (design)
Scope: Frontend only — `src/components/ClosePositionModal.tsx`

## Problem

The one-click close (cross-asset) path quotes swap routes in the background but
only surfaces the winning aggregator's **name** (`bestRoute`). The user cannot
see, before committing, how much collateral is consumed, how much debt is
repaid, or — most importantly — **how much comes back to their wallet**. The
permit signature is only requested when they click *Execute*, so all of this can
be shown up front, before any signature.

## Goal

Add an output-preview panel to the modal that clearly shows the result of the
close **before** the permit signature is requested. Frontend-only; no contract
or hook changes (approach #1).

## Non-Goals

- Removing the permit signature from the flow.
- Reading exact live on-chain balances for the preview (approach #2, rejected).
- Changing the same-asset `repayWithATokens` execution.

## Design

### State change

Replace the name-only quote state with the full quote:

```
- const [bestRoute, setBestRoute] = useState<string | null>(null)
+ const [bestQuote, setBestQuote] = useState<QuoteResponse | null>(null)
```

The existing `useEffect` already fetches quotes and calls `pickBestRoute`; store
the returned `QuoteResponse` instead of `best?.aggregator`. `isQuoting` is
unchanged. `bestRoute` display sites read `bestQuote?.aggregator`.

### Derived preview (cross-asset only)

Computed in the component from `bestQuote` + `borrowedAsset`, reusing the
existing `computeMinOut` helper from `src/lib/deleverage.ts`:

- `debtWei = parseUnits(borrowedAsset.amount.toFixed(borrowedAsset.decimals), borrowedAsset.decimals)`
- `amountOut = BigInt(bestQuote.amountOut)` (debt-token wei)
- `slippageBps = Math.round(slippage * 100)`
- `{ minOut, covered } = computeMinOut(amountOut, debtWei, slippageBps)`
- `expectedReturnWei = amountOut > debtWei ? amountOut - debtWei : 0n`
- `minReturnWei = minOut > debtWei ? minOut - debtWei : 0n`
- USD (best-effort, only when prices present):
  - `debtUsd = borrowedAsset.amount * Number(borrowedAsset.priceInUsd)`
  - `expectedReturnUsd = Number(bestQuote.amountOutUsd) - debtUsd`

All numbers are labeled **estimated** — execution re-reads the live balance, so
the preview uses the frontend collateral float.

### Panel rendering

Cross-asset, quote available and `covered`:

| Row | Value |
|-----|-------|
| Collateral to swap | `{selectedCollateral.amount} {symbol}` |
| Debt repaid | `{borrowedAsset.amount} {borrowedAsset.symbol}` |
| **You receive (est.)** | `{expectedReturnWei} {debtSymbol}` (+ `~$USD` when available) |
| Minimum received | `{minReturnWei} {debtSymbol}` |
| Route | `{bestQuote.aggregator}` |

Cross-asset, quote available and **not** `covered`: replace the panel body with
a warning — "Collateral won't cover the debt at this slippage (position
underwater)" — and disable *Execute*.

Cross-asset, still quoting / no quote yet: show the existing "Finding best
route…" affordance; *Execute* disabled until a covered quote exists.

Same-asset: simple line — "Repaying `{amountStr || borrowedAsset.amount} {symbol}`
directly with your aTokens. No swap, no signature, no fees."

### Execute gating

Extend `canExecute` for the cross-asset path to additionally require a quote
that covers the debt:

```
canExecute = isSameAsset
  ? !!amountStr && parseFloat(amountStr) > 0
  : deleveragerAvailable && !isQuoting && preview?.covered === true
```

This blocks underwater closes before the signature, matching the guard the hook
already enforces at step 5.

## Testing / Verification

- `pnpm run build` (or typecheck) passes.
- Manual: open modal on a cross-asset position → preview shows collateral, debt,
  estimated return, minimum, route, with no wallet signature prompt until
  *Execute*.
- Underwater case (high debt / low slippage) → warning shown, *Execute*
  disabled.
- Same-asset case → plain repay summary, no swap rows.
