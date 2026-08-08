# AaveV3Strategies SDK — Design

**Date:** 2026-08-08
**Status:** Approved, ready for implementation planning
**Scope:** Phase 1 of FE integration — the pure TypeScript SDK layer only. No UI, no React hooks.

## Goal

Replace the orphaned, half-migrated `src/lib/leverage-sdk/` with `src/lib/strategies-sdk/`, a pure
TypeScript layer targeting `contract/src/AaveV3Strategies.sol` exclusively. When this phase lands,
the open-position UI (phase 2) can be built on a fully unit-tested foundation with no contract
arithmetic left inside React.

## Context

`AaveV3Strategies.sol` is complete and fork-tested but undeployed. Three older contracts share the
branch: `AaveV3Leverage.sol` and `AaveV3Leverager.sol` (superseded, to be deleted) and
`AaveV3Deleverager.sol` (deployed at `0x834796774eb472e571b5c21da438069225c2b162`, still serving the
app's live close flow — its source stays until that flow migrates).

The existing `src/lib/leverage-sdk/` is imported by nothing in the app. Its `abi.ts`, `params.ts`
and `reads.ts` target the superseded `AaveV3Leverage`; only `strategies.ts` matches the current
contract. Replacing the directory outright is therefore free of migration risk.

## Non-goals

- Any UI, React hook, or wallet interaction.
- Quote orchestration or adapter integration (`src/adapters/`).
- Migrating the close flow off `AaveV3Deleverager`.
- Sizing the zero-margin **ratchet** path (`marginAmount = 0` on an existing position). The
  contract supports it; sizing it means solving against existing collateral and debt rather than
  fresh margin, which is a different function and has no UI yet.

## Architecture

New directory `src/lib/strategies-sdk/`, pure TypeScript — no React, no `fetch`, no imports from
`src/adapters/`.

| File | Responsibility |
| --- | --- |
| `abi.ts` | Strategies ABI, `Permit`/`Sig` types, `ZERO_*` sentinels, `FULL_CLOSE` |
| `signatures.ts` | EIP-712 typed-data builders + Strategies-shaped signature converters |
| `plan.ts` | `planOpen` (4 modes) + `planClose` → `{ functionName, args }` for `writeContract` |
| `reads.ts` | On-chain reads: pause, router allowlist, balances, nonces, delegation allowance |
| `sizing.ts` | Pure open-sizing math + leverage guardrails |
| `index.ts` | Barrel re-export |
| `*.test.ts` | Vitest, one per module |

`src/lib/leverage-sdk/` (11 files) is deleted in full.

### Boundaries

Three responsibilities stay outside the SDK, each because a single owner already exists:

- **Reserve-token lookup.** `src/lib/aaveStatics.ts` resolves and caches aToken and
  variable-debt-token addresses per reserve. `reads.ts` takes token addresses as parameters rather
  than re-deriving them, so there is one cache rather than two.
- **Liquidation price.** `src/utils/liquidation.ts` and `src/utils/health.ts` compute it, and
  `LiquidationPriceBlock.tsx` renders it. `sizeOpen` returns resulting collateral and debt amounts
  plus a health factor; the UI feeds those into the existing utils.
- **Quoting.** `sizeOpen` accepts a rate as an argument. The phase-2 hook runs the
  seed → quote → re-size loop, mirroring the shape `src/lib/sizing.ts` already uses on the close
  side.

## Sizing (`sizing.ts`)

The user supplies margin `M` and target leverage `L`. There are two flow shapes, not four — the
open mode only decides which asset plays which role.

Notation: `rate` = collateral units per debt unit (decimal-adjusted); `Pcoll`/`Pdebt` = Aave oracle
prices; `buffer` = rate safety margin; `slippage` = user-facing slippage tolerance.

### Flow A — margin in the collateral asset

Modes 1 and 4, entry point `openWithCollateralMargin`. The contract supplies `flashAmount + M`,
borrows `B`, swaps `B` into collateral, and the output must clear `flashAmount`.

```
flashAmount  = M · (L − 1)
expectedOut  = flashAmount / (1 − buffer)
borrowAmount = ceil( flashAmount / (rate · (1 − buffer)) )
minOut       = max( flashAmount, expectedOut · (1 − slippage) )
```

### Flow B — margin in the debt asset

Modes 2 and 3, entry point `openWithDebtMargin`. The contract supplies `supplyAmount`, borrows `B`,
swaps `B + M` into collateral, and the output must clear `supplyAmount`.

```
supplyAmount = L · M · Pdebt / Pcoll              (decimal-adjusted)
expectedOut  = supplyAmount / (1 − buffer)
borrowAmount = ceil( supplyAmount / (rate · (1 − buffer)) ) − M
minOut       = max( supplyAmount, expectedOut · (1 − slippage) )
```

All arithmetic is `bigint` and ceil-divided, so rounding always errs toward *more* borrow.
Under-borrowing reverts the transaction; over-borrowing folds surplus back into the position.

### Guardrails

Two distinct Aave parameters govern the ceiling, and conflating them is the classic error: Aave's
`borrow` is gated by **LTV**, while the health factor and liquidation are computed from the
**liquidation threshold**.

```
maxLeverageForLtv(ltvBps)                     = 1 / (1 − LTV)      hard ceiling — borrow reverts above it
maxLeverageForHealthFactor(ltBps, targetHfBps) = HF / (HF − LT)    soft ceiling for the UI slider
```

At LTV 75% / LT 80%: the hard wall is 4.0x, and holding HF 1.5 means 2.14x.

`sizeOpen` rejects, as a typed error union rather than a thrown exception:

- `L ≤ 1` (yields a zero flash — the contract reverts `ZeroAmount`)
- a non-positive `borrowAmount` in Flow B. This fires when the quoted rate beats the
  oracle-implied one by enough that the margin alone covers the swap input — a stale oracle
  against a favorable market, not merely low leverage. At the oracle rate the borrow works out
  to `(L − 1) · M`, which stays positive for any `L > 1`.
- `L ≥ LTV_CEILING_FACTOR · maxLeverageForLtv(ltv)`, where `LTV_CEILING_FACTOR` is an exported
  constant defaulting to `0.98`. The margin exists because the LTV wall is exact and the borrow
  reverts *at* it; sizing must land strictly below.
- zero margin
- zero or missing rate

### Return shape

Requested leverage is a **floor, never the exact outcome**: the contract folds swap surplus back
into the position, so the realized position is at or above target.

```ts
{
  flashAmount, borrowAmount, minOut,
  expectedSwapOut, expectedCollateral, expectedDebt,
  expectedLeverageBps,        // ≥ requested; buffer surplus lands here
  expectedHealthFactorBps,
}
```

Ratios carry a `Bps` suffix and stay `bigint`, matching the module's bigint-only rule — no
floating point crosses the SDK boundary.

## Plans (`plan.ts`)

`planOpen` maps the four UX modes onto the contract, carrying over the current
`leverage-sdk/strategies.ts` logic:

| Mode | Direction | Collateral | Debt | Margin asset | Entry point |
| --- | --- | --- | --- | --- | --- |
| 1 | Long X, holding X | X | stable | collateral | `openWithCollateralMargin` |
| 2 | Long X, holding stable | X | stable | debt | `openWithDebtMargin` |
| 3 | Short X, holding X | stable | X | debt | `openWithDebtMargin` |
| 4 | Short X, holding stable | stable | X | collateral | `openWithCollateralMargin` |

It returns `{ functionName, collateral, debtAsset, marginAsset, args }`; `marginAsset` tells the UI
which ERC-20 allowance to check. An invalid mode is rejected.

`planClose` returns `{ functionName: "closePositionWithPermit", args }`, defaulting both
`collateralToWithdraw` and `debtRepay` to `FULL_CLOSE`.

## Signatures (`signatures.ts`)

The three EIP-712 builders carry over unchanged — `buildATokenPermit`, `buildRevokePermit`,
`buildCreditDelegation`. Aave's aTokens and variable-debt tokens both use domain version `"1"`, so
no version override is required. (The previously tracked IMP-1 — a margin-permit builder with a
domain-version override — is obsolete: `AaveV3Strategies` pulls margin via `transferFrom` against a
prior approval, never a permit.)

The converters change. `toContractPermit` and `toContractRevoke` emit the superseded
`AaveV3Leverage` field order and are deleted, replaced by:

```ts
toStrategiesPermit(signature, amount, deadline) → { amount, deadline, r, s, v }
toStrategiesSig(signature, deadline)            → { deadline, r, s, v }
```

Two contract invariants the module documents and the tests pin, both silent-failure shaped:

- **A delegation `Sig` is signed over exactly `borrowAmount`**, so it must be built *after* sizing,
  never before. A mismatch leaves residual borrowing power or reverts.
- **On close the revoke `Sig` is always required** — `_permitZero` runs unconditionally. Its nonce
  is `nonce + 1` when paired with a fresh permit, but `nonce + 0` on the standing-allowance path.
  A wrong offset reverts with `InvalidExpiration()`, which reads as an unrelated bug; this already
  bit the fork tests.

## Reads (`reads.ts`)

```ts
getPauseState(client, contract)                                  → { paused: boolean }
getAllowedRouters(client, contract)                              → readonly Address[]
isRouterAllowed(client, contract, router)                        → boolean
getPermitContext(client, token, owner)                           → { name, nonce }
getPositionBalances(client, { aToken, variableDebtToken, user }) → { collateral, debt }
getDelegationAllowance(client, variableDebtToken, owner, delegatee) → bigint
```

`paused` is a plain `uint256` that is zero or one — **not** the per-leg bitmask
`AaveV3Leverage` used. The old `PAUSE_OPEN`/`PAUSE_CLOSE` decoding is deleted; keeping it would
misreport the pause state.

`getPositionBalances` and `getDelegationAllowance` close the previously tracked IMP-2 gap.
`getDelegationAllowance` is what lets the phase-2 hook skip the signature prompt entirely
(`deadline: 0n`) when a standing delegation already covers `borrowAmount`.

All reads accept a minimal `ReadClient` interface (a single `readContract` method), which any viem
`PublicClient` satisfies and any test stub can implement.

## Configuration

Mirrors the existing deleverager convention exactly:

- `ChainConfig.aave.strategies?: \`0x${string}\`` in `src/config/chains.ts`, fed by
  `VITE_STRATEGIES_ADDRESS_<chainId>`.
- `getStrategiesAddress(chainId): \`0x${string}\` | null`, returning `null` for unset, zero, or
  malformed addresses.
- SDK functions continue to take an explicit `contract: Address` — the SDK never reads config.

`.env` is never read, edited, or staged. The contract is undeployed, so `getStrategiesAddress`
returns `null` on every chain today and the phase-2 UI hides itself; the SDK ships and is fully
testable regardless.

## Contract cleanup

Delete `contract/src/AaveV3Leverage.sol` and `contract/src/AaveV3Leverager.sol` along with their
fork suites. **Keep `contract/src/AaveV3Deleverager.sol`** until the close flow migrates to
Strategies — it is the source of a live deployment the app still calls, and deleting it would lose
the only record of what is on-chain.

## Testing

Vitest, pure units, no network. Per-task gate: `pnpm exec tsc -b` clean, `pnpm exec vitest run`
green, and no new eslint errors in the files that task touched (the repo carries a pre-existing
eslint backlog in unrelated files, so a clean full `pnpm lint` is not the bar).

- **`sizing.test.ts`** carries the weight: both flows, both directions, 6-decimal ↔ 18-decimal
  pairs, rounding direction, every guardrail rejection, and a round-trip check that
  `expectedCollateral`/`expectedDebt` reproduce the claimed health factor.
- **`plan.test.ts`**: all four modes map to the right entry point and asset roles; invalid mode
  rejected.
- **`signatures.test.ts`**: converter field order pinned against the ABI struct; both revoke nonce
  offsets.
- **`abi.test.ts`**: hand-pinned function selectors, asserted against `toFunctionSelector` on the
  parsed ABI. Not read from `contract/out/` — that directory is gitignored, so an artifact-backed
  test would fail on a fresh clone or in CI without a `forge build` first.
- **`reads.test.ts`**: stub client, assert call shapes and decoding.

## Phase 2 preview (not in this spec)

The open-position UI consumes this SDK: a mode picker (long/short × margin asset), a leverage
slider clamped by `maxLeverageForLtv`, a seed → quote → re-size loop against `src/adapters/`, an
ERC-20 approval for `marginAsset`, a credit-delegation signature over the sized `borrowAmount`, and
the `writeContract` call from `planOpen`.
