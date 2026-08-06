# Direction-Neutral Leverage Router — Design

**Date:** 2026-08-06
**Status:** Approved
**Contract:** `contract/src/AaveV3Leverage.sol` (generalized in place; not yet deployed)

## Goal

One contract that opens and closes both long and short leveraged Aave V3 positions in a
single transaction each, financed by a zero-fee Morpho Blue flash loan, authorized by
user signatures (aToken EIP-2612 permit for closes, variable-debt-token credit
delegation for opens).

## Key insight

The Aave V3 Pool has no notion of long or short — a position is just *(supplied
collateral asset, borrowed debt asset)*. Long wstETH = supply wstETH / borrow USDC;
short wstETH = supply USDC / borrow wstETH. Both are the same code path with the roles
swapped, so the contract stays direction-neutral and the frontend labels the direction.
This keeps one audit surface for four products (open/close × long/short).

## Decisions (user-approved)

| Decision | Choice |
| --- | --- |
| API shape | One generic pair: `openPosition` / `closePosition`; direction implicit |
| Margin asset | Always the collateral asset (stables when shorting, volatile when longing) |
| Pair policy | No on-chain pair list; only `collateral != debtAsset` enforced |
| Close scope | Variable: `repayAmount` chooses how much debt to repay; `type(uint256).max` = full close. Flash = `min(repayAmount, currentDebt)` |
| Partial opens | No special path; opening on top of an existing position is naturally additive |
| Code base | Generalize the merged `AaveV3Leverage.sol` (approach A: rename + permit hoist) |
| Code style | Solady style throughout (see below) |

Approach C (partial closes, debt-asset margin) was initially dropped in favour of A;
the variable `repayAmount` close was re-added during spec review. Debt-asset margin
stays out of scope.

## External API

```solidity
function openPosition(
    address collateral,
    address debtAsset,
    uint256 marginAmount,      // collateral-asset margin pulled from caller; may be 0
    uint256 flashAmount,       // debt asset flash-borrowed and swapped; the exact debt incurred
    uint256 minCollateralOut,  // slippage bound on the swap
    address router,            // must be allowlisted
    uint256 deadline,
    bytes calldata swapData,   // router calldata: flashAmount debtAsset -> collateral, recipient = contract
    Permit calldata marginPermit,  // EIP-2612 on collateral; value 0 = rely on existing allowance
    Permit calldata delegation     // delegationWithSig on variable debt token; value 0 = existing delegation
) external;

function closePosition(
    address collateral,
    address debtAsset,
    uint256 repayAmount,           // debt to repay; max (or >= debt) = full close
    uint256 collateralToWithdraw,  // aTokens pulled; max = drain
    uint256 minOut,                // slippage bound on the swap
    address router,
    bytes calldata swapData,       // router calldata: collateral -> debtAsset, recipient = contract
    Permit calldata permit,        // EIP-2612 on the aToken, nonce N
    RevokePermit calldata revokePermit  // zero-value permit at nonce N+1
) external;
```

Renames from the current file: `openLong` → `openPosition`,
`closePositionWithPermit` → `closePosition`, `LongOpened` → `PositionOpened`
(fields unchanged). Admin surface unchanged: `setRouters(address[],bool)`,
`setPause(uint256)` bitmask (`PAUSE_OPEN | PAUSE_CLOSE`), `rescueToken`,
`allowedRouters`, `getAllowedRouters`.

## Mechanics (unchanged from the merged contract)

- Morpho Blue zero-fee flash loan; single `onMorphoFlashLoan` callback doubly
  authenticated (msg.sender == Morpho AND payload keccak matches the transient
  commitment made at entry) and dispatching on a leading mode word.
- Payload decoded via calldata pointers (no `abi.decode` memory copy).
- Router allowlist (EnumerableSetLib); router approvals exact-amount and revoked
  in-transaction. Standing max approvals to Morpho and the Aave Pool only, topped up
  lazily (`_approveMax`).
- Transient `_pendingDataHash` doubles as the reentrancy guard across the whole
  callback, including the router call.
- All user-account actions pinned to the `msg.sender` captured at entry.

## The permit hoist (the one behavioural change)

Today the close path consumes the aToken permit inside the flash-loan callback. It
moves to the entry point, before the flash loan:

- `permit()` only sets an allowance — it has no health-factor or repay dependency, so
  ordering is safe. The allowance window widens only across `MORPHO.flashLoan` and
  `POOL.repay`, both trusted and hardcoded. The untrusted router call still runs after
  `revokePermit`.
- A bad or front-run permit now reverts before the flash loan + repay are paid for.
- `CloseParams` loses its 5-word `Permit` field (−160 payload bytes); `revokePermit`
  stays in the payload because it must run after the callback's `safeTransferFrom`.
- Both legs become symmetric: grant signatures consumed at entry, callback works with
  what it has.

The user-facing signatures (what the wallet prompts for) are unchanged.

## Error handling

Existing taxonomy kept: `Reentrancy`, `ExpectedState`, `NotMorpho`,
`UnexpectedCallback`, `NoDebt`, `SameAsset`, `Paused`, `Expired`, `RouterNotAllowed`,
`ZeroAmount`, `ZeroAddress`, `InsufficientOutput(have, need)`.

- Slippage is enforced from the contract's own balance deltas, never router return data.
- Post-hoist failure ordering: signature problems, pauses, `NoDebt`, and allowlist
  misses all revert pre-flash (cheap); only swap failures cost the flash round-trip.
- An unlisted reserve yields `address(0)` from the Pool getters, whose `balanceOf`
  reads 0 and trips `NoDebt` / `ZeroAmount` — no explicit listing check needed.

## Partial close semantics

- Entry point flash-borrows `min(repayAmount, currentDebt)`, so a stale frontend
  quote can never over-borrow the flash loan.
- When debt remains after the repay, `POOL.withdraw` runs Aave's health-factor
  validation and reverts if `collateralToWithdraw` would leave the position
  liquidatable — the contract adds no ratio math of its own.
- The frontend is responsible for sizing `collateralToWithdraw` against the
  remaining debt (worst-case swap rate), not against a full close.
- Swap output above the flashed amount is returned to the user unchanged (existing
  sweep logic).

## Calldata encoding decision

Standard ABI encoding is kept. Alternatives measured and rejected (2026-08-06):

- LibZip `cdCompress`/`cdFallback`: 1,316 → 1,314 bytes on a realistic close (dense
  aggregator swapData has no long zero runs), saving ~248 gas of calldata against
  ~104k gas of on-chain decompression. Strictly a loss on mainnet; user also vetoed.
- Packed structs / compact custom `bytes` encoding: ~590 gas total saving, traded
  against a hand-rolled decoder (new audit surface) and loss of Etherscan-decodable
  parameters.

## Frontend SDK (in-repo module)

`src/lib/leverage-sdk/` — a typed, viem-based module owning everything between the
UI hooks and the contract. No wagmi/React inside the SDK; hooks consume it.

| Unit | Responsibility |
| --- | --- |
| `abi.ts` | Contract ABI + address per chain, typed with viem's const assertions |
| `signatures.ts` | EIP-712 builders: aToken permit (nonce N) + revoke permit (nonce N+1) pair, credit delegation (`delegationWithSig`), margin permit — including deadline headroom rules already established in `close-position-flow.md` |
| `params.ts` | Assembles `openPosition` / `closePosition` args from quotes; partial-close sizing helper (bounds `collateralToWithdraw` by remaining-debt health factor at the worst-case swap rate) |
| `reads.ts` | Router allowlist (`getAllowedRouters`), variable debt, aToken balance/nonce reads |

Testing: vitest unit tests for signature digests (against known-good fixtures from the
fork tests) and partial-close sizing edge cases. Refactoring the existing
`useDeleverageClose` hook onto the SDK is a follow-up plan task, not a blocker for the
contract work.

## Code style — Solady

- Solady deps only: `Ownable`, `SafeTransferLib`, `LibCall`, `EnumerableSetLib`.
- Solady glyph section banners (`/*´:°•.°+.*•´.*:˚…*/`) in the established order:
  custom errors, events, constants, structs, storage, constructor, entry points,
  callback, internal helpers, admin.
- NatSpec: `@dev` only — no `@title`/`@notice`/`@param`/`@return` (house rule).
- `_underscorePrefix` for private constants/functions; custom errors with `@dev`
  one-liners; assembly blocks marked `("memory-safe")` with inlined error selectors.

## Testing

1. Keep `AaveV3LeveragePayload.t.sol` (fuzzed payload round-trip for both param
   structs), updated for the slimmer `CloseParams`.
2. Port `AaveV3DeleveragerFork.t.sol` to the generalized contract: mock routers
   (exact-pull, fixed-pull, reentering), full permit lifecycle including revoke,
   partial-swap sweep-back, pause/allowlist/admin paths.
3. New open-leg fork tests: long open (wstETH/USDC), short open (USDC collateral /
   wstETH debt — proves direction-neutrality on the identical code path), delegation
   consumption, `Expired` deadline, and open→close round trips in both directions.
4. Partial-close fork tests: repay half the debt and withdraw a safe collateral
   slice (position stays open and healthy); repay half but withdraw too much
   (Aave HF check reverts); `repayAmount > debt` behaves as a full close.
5. Fork tests require `RPC_URL` pointing at Ethereum mainnet.

## Out of scope

Calldata compression (measured, rejected — see above), margin in the debt asset or
third tokens, on-chain pair allowlists,
E-Mode, stable-rate debt (Aave V3.1 removed it), non-mainnet deployments, FE
integration (separate spec).
