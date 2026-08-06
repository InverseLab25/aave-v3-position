# Direction-Neutral Leverage Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize `AaveV3Leverage.sol` into a direction-neutral open/close leverage router (variable `repayAmount`, permit hoist), cover it with fork tests, and build the in-repo FE SDK (`src/lib/leverage-sdk/`).

**Architecture:** One contract, one Morpho flash-loan callback dispatching on a mode word; long and short are the same code path with collateral/debt roles swapped. The FE SDK is a viem-only module (no React) that owns ABI, EIP-712 signature builders, argument assembly, and reads.

**Tech Stack:** Solidity 0.8.34 + Solady (Ownable, SafeTransferLib, LibCall, EnumerableSetLib), Foundry (mainnet fork tests), TypeScript 6 + viem 2.x + vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-06-direction-neutral-leverage-design.md`

## Global Constraints

- Solidity `0.8.34`, `via_ir = true`, `optimizer_runs = 1_000_000` (already in `contract/foundry.toml`).
- Solady style: glyph section banners, `@dev`-only NatSpec (no `@title`/`@notice`/`@param`/`@return`), `_underscorePrefix` privates, `("memory-safe")` assembly with inlined error selectors.
- Contract commands run from `contract/`; fork tests need `RPC_URL` set to an Ethereum mainnet endpoint: `RPC_URL=... forge test --match-path 'test/*Fork*'`. If `RPC_URL` is unavailable, run the non-fork tests + `forge build`, and flag the fork suite as not-run in the task report.
- Do NOT modify or delete `AaveV3Deleverager.sol`, `AaveV3Leverager.sol`, `AaveV3DeleveragerFork.t.sol`, or `script/*` — the deployed Deleverager and its FE integration stay live until the new contract deploys.
- FE: pnpm only (`pnpm test -- --run`, `pnpm run build`). SDK code must not import React or wagmi. Never read or edit `.env*`.
- Mainnet constants: Pool `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`, Morpho `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`, WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`.

---

### Task 1: Rename to the direction-neutral API

**Files:**
- Modify: `contract/src/AaveV3Leverage.sol`
- Test: `contract/test/AaveV3LeveragePayload.t.sol` (existing, must keep passing)

**Interfaces:**
- Produces: `openPosition(...)` (same params as current `openLong`), `closePosition(...)` (same params as current `closePositionWithPermit`), event `PositionOpened` (same fields as `LongOpened`). Tasks 2-6 build on these names.

- [ ] **Step 1: Rename in the contract**

In `contract/src/AaveV3Leverage.sol` apply exactly these renames (declaration + every reference):
- `function openLong(` → `function openPosition(`
- `function closePositionWithPermit(` → `function closePosition(`
- `event LongOpened(` → `event PositionOpened(` and `emit LongOpened(` → `emit PositionOpened(`

Update the contract-level `@dev` header: replace the "Open: …" sentence's "leveraged long" framing with direction-neutral wording, e.g.:

```solidity
/// @dev Opens and closes leveraged Aave V3 positions in one transaction each, financed by a
/// zero-fee Morpho Blue flash loan. Direction-neutral: a long supplies the volatile asset and
/// borrows the stable; a short supplies the stable and borrows the volatile asset — the same
/// code path with the roles swapped. ...
```

Also update the `openPosition` `@dev` comment ("Opens a leveraged long" → "Opens a leveraged position") and the `PAUSE_OPEN`/`PAUSE_CLOSE` comments to reference the new names.

- [ ] **Step 2: Build and run the payload tests**

Run: `cd contract && forge build && forge test --match-path 'test/AaveV3LeveragePayload.t.sol'`
Expected: build succeeds, 2 fuzz tests PASS (they reference only structs, which are unchanged).

- [ ] **Step 3: Commit**

```bash
git add contract/src/AaveV3Leverage.sol
git commit -m "refactor: rename AaveV3Leverage API to direction-neutral openPosition/closePosition"
```

---

### Task 2: Permit hoist — consume the aToken permit at entry

**Files:**
- Modify: `contract/src/AaveV3Leverage.sol`
- Test: `contract/test/AaveV3LeveragePayload.t.sol`

**Interfaces:**
- Produces: `CloseParams` WITHOUT the `Permit permit` field (Tasks 4-6 and the SDK encode against this shape). Revoke rule: the callback executes `revokePermit` iff `revokePermit.deadline != 0`.

- [ ] **Step 1: Write the failing test (payload shape)**

In `contract/test/AaveV3LeveragePayload.t.sol`, remove the `permit` field from the close round-trip: delete the `AaveV3Leverage.Permit memory permit` fuzz param, the `permit: permit,` line in the struct literal, and the five `d.permit.*` assertions. The close fuzz test signature becomes:

```solidity
function testFuzz_closePayloadRoundTrips(
    address user,
    address collateral,
    address debtAsset,
    uint256 collateralToWithdraw,
    uint256 minOut,
    address router,
    AaveV3Leverage.RevokePermit memory revokePermit,
    bytes calldata swapData
) public view {
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd contract && forge test --match-path 'test/AaveV3LeveragePayload.t.sol'`
Expected: FAIL to compile — `CloseParams` still declares `permit`, so the struct literal in the test is missing a member.

- [ ] **Step 3: Implement the hoist**

In `contract/src/AaveV3Leverage.sol`:

a. Delete `Permit permit;` from `struct CloseParams`.

b. In `closePosition`, after the `NoDebt` check and before `_flash(...)`, insert:

```solidity
        // Consume the aToken permit up front: a bad or front-run signature reverts before
        // the flash loan and repay are paid for. Only the revoke stays in the callback —
        // it must run after the transferFrom.
        if (permit.value != 0) {
            IERC2612(_POOL.getReserveAToken(collateral)).permit(
                msg.sender, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s
            );
        }
```

c. Remove `permit: permit,` from the `CloseParams` literal inside `closePosition`.

d. In `_close`, delete the first `permit(...)` block (the one gated on `p.permit.value != 0`) and the `uint256 permitValue = p.permit.value;` cache. Change the revoke gate from `if (permitValue != 0)` to:

```solidity
        // deadline == 0 marks "no permit was granted" (caller relied on a standing
        // allowance), so there is nothing to clear.
        if (p.revokePermit.deadline != 0) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd contract && forge build && forge test --match-path 'test/AaveV3LeveragePayload.t.sol'`
Expected: PASS (2 fuzz tests).

- [ ] **Step 5: Commit**

```bash
git add contract/src/AaveV3Leverage.sol contract/test/AaveV3LeveragePayload.t.sol
git commit -m "feat: consume aToken permit at closePosition entry, slim CloseParams"
```

---

### Task 3: Variable `repayAmount` (partial closes)

**Files:**
- Modify: `contract/src/AaveV3Leverage.sol`

**Interfaces:**
- Produces: final close signature used by every later task and the SDK:
  `closePosition(address collateral, address debtAsset, uint256 repayAmount, uint256 collateralToWithdraw, uint256 minOut, address router, bytes swapData, Permit permit, RevokePermit revokePermit)`.
  Semantics: flash-borrows `min(repayAmount, currentDebt)`; `type(uint256).max` (or any value ≥ debt) = full close; `repayAmount == 0` reverts `ZeroAmount`.

- [ ] **Step 1: Implement**

In `closePosition`:

a. Add `uint256 repayAmount,` as the third parameter (after `debtAsset`, before `collateralToWithdraw`).

b. Extend the zero check: `if (repayAmount == 0 || collateralToWithdraw == 0 || minOut == 0) revert ZeroAmount();`

c. After the `NoDebt` check, cap the flash amount:

```solidity
        // Partial close: flash only what the caller wants repaid, never more than the
        // live debt — a stale frontend quote can't over-borrow the flash loan.
        if (repayAmount < debt) debt = repayAmount;
```

d. Update the function's `@dev` comment: "`repayAmount` may be max to repay the entire variable debt; anything smaller is a partial close, and Aave's health-factor check inside `withdraw` bounds `collateralToWithdraw`."

- [ ] **Step 2: Build + payload tests**

Run: `cd contract && forge build && forge test --match-path 'test/AaveV3LeveragePayload.t.sol'`
Expected: build succeeds, tests PASS (behavioural coverage lands with the fork suite in Tasks 4/6).

- [ ] **Step 3: Commit**

```bash
git add contract/src/AaveV3Leverage.sol
git commit -m "feat: variable repayAmount in closePosition (partial closes)"
```

---

### Task 4: Port the fork suite to `AaveV3Leverage`

**Files:**
- Create: `contract/test/AaveV3LeverageFork.t.sol` (from a copy of `contract/test/AaveV3DeleveragerFork.t.sol`)

**Interfaces:**
- Consumes: `closePosition` (Task 3 signature), `CloseParams` without permit (Task 2).
- Produces: `AaveV3LeverageForkTest` with `setUp` (10 WETH supplied / 1,000 USDC borrowed for `user`), helpers `_one`, `_signPermit`, `_signRevoke`, mock routers `MockRouter`, `MockRouterFixedPull`, `MockRouterReenter`. Tasks 5-6 add tests to THIS file using these helpers.

- [ ] **Step 1: Copy and rewire**

```bash
cd contract && cp test/AaveV3DeleveragerFork.t.sol test/AaveV3LeverageFork.t.sol
```

In the new file apply ALL of:
1. `import {AaveV3Deleverager} from "../src/AaveV3Deleverager.sol";` → `import {AaveV3Leverage} from "../src/AaveV3Leverage.sol";`
2. Every `AaveV3Deleverager` type reference → `AaveV3Leverage`; the `deleverager` variable → `lev`; contract name `AaveV3DeleveragerForkTest` → `AaveV3LeverageForkTest`. Rename the mock router contracts to avoid duplicate-name collisions with the old test file: `MockRouter` → `MockRouterL`, `MockRouterFixedPull` → `MockRouterFixedPullL`, `MockRouterReenter` → `MockRouterReenterL` (declaration + every `new`/`abi.encodeCall` reference).
3. Every close call gains `type(uint256).max` as the new third argument (full close) and drops the trailing rename, e.g.:

```solidity
        vm.prank(user);
        lev.closePosition(
            WETH, USDC, type(uint256).max, type(uint256).max, debt, address(router), swapData, permit, revoke
        );
```

   (arg order: collateral, debtAsset, repayAmount, collateralToWithdraw, minOut, router, swapData, permit, revoke)
4. `MockRouterReenterL.swap` re-enters via the NEW signature — a 9-arg `closePosition` with `repayAmount = 1`:

```solidity
contract MockRouterReenterL {
    function swap(address lev, address collateral, address debtAsset) external {
        AaveV3Leverage.Permit memory p;
        AaveV3Leverage.RevokePermit memory rp;
        AaveV3Leverage(lev).closePosition(collateral, debtAsset, 1, 1, 1, address(this), hex"", p, rp);
    }
}
```

5. `test_RevertsWhen_ZeroCollateralOrMinOut` gains a third case asserting `repayAmount == 0` reverts `ZeroAmount()`.
6. `test_ClosePosition_WithExistingAllowance_SkipsPermit`: with the hoist, "skip permit" now means `permit.value == 0` AND `revokePermit.deadline == 0` (zeroed structs) after a manual `approve` — verify it still closes and the manual allowance survives minus the pulled amount.
7. Pause tests use the bitmask: `lev.setPause(lev.PAUSE_CLOSE());` must block `closePosition` with `Paused()`; also assert `lev.setPause(lev.PAUSE_OPEN())` does NOT block a close (open-only pause leaves closes live).
8. `test_Aave_RejectsMaxRepayOnBehalf` keeps its Aave-behaviour documentation role — unchanged apart from variable renames.

- [ ] **Step 2: Run the fork suite**

Run: `cd contract && RPC_URL=$RPC_URL forge test --match-path 'test/AaveV3LeverageFork.t.sol' -vv`
Expected: all ported tests PASS. (Old suite untouched: `test/AaveV3DeleveragerFork.t.sol` still compiles.)

- [ ] **Step 3: Commit**

```bash
git add contract/test/AaveV3LeverageFork.t.sol
git commit -m "test: port fork suite to AaveV3Leverage closePosition"
```

---

### Task 5: Open-leg fork tests (long + short + delegation)

**Files:**
- Modify: `contract/test/AaveV3LeverageFork.t.sol`

**Interfaces:**
- Consumes: Task 4 harness. `openPosition(collateral, debtAsset, marginAmount, flashAmount, minCollateralOut, router, deadline, swapData, marginPermit, delegation)`.
- Produces: `_signDelegation(address debtToken, uint256 value, uint256 deadline)` helper used by Task 6's round-trip.

- [ ] **Step 1: Add the delegation helper + typehash**

```solidity
    bytes32 constant DELEGATION_WITH_SIG_TYPEHASH =
        keccak256("DelegationWithSig(address delegatee,uint256 value,uint256 nonce,uint256 deadline)");

    address openUser;
    uint256 openUserPk = 0xB0B;

    // In setUp(), add: openUser = vm.addr(openUserPk);

    /// @dev Signs credit delegation on `debtToken` (a variable debt token): delegator = owner,
    ///      delegatee = the leverage contract.
    function _signDelegation(uint256 pk, address owner, address debtToken, uint256 value, uint256 deadline)
        internal
        view
        returns (AaveV3Leverage.Permit memory)
    {
        uint256 nonce = IAToken(debtToken).nonces(owner);
        bytes32 structHash =
            keccak256(abi.encode(DELEGATION_WITH_SIG_TYPEHASH, address(lev), value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IAToken(debtToken).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return AaveV3Leverage.Permit({value: value, deadline: deadline, v: v, r: r, s: s});
    }
```

Also generalize the ported helpers to `_signPermit(uint256 pk, address owner, uint256 value, uint256 deadline)` and `_signRevoke(uint256 pk, address owner, uint256 deadline)` (replace the hardcoded `userPk`/`user` with the parameters) and update Task 4's call sites to pass `(userPk, user, ...)`. (`IAToken` already exposes `nonces`/`DOMAIN_SEPARATOR`; debt tokens implement both.)

- [ ] **Step 2: Write the open tests**

Use a fresh account with no pre-existing position for opens (`openUser = vm.addr(0xB0B)` — the `setUp` position belongs to `user`; opens are cleaner on a blank account; sign with pk `0xB0B`). Either parameterize the sign helpers with a pk or add `openUserPk`-based variants — parameterizing `_signPermit/_signRevoke/_signDelegation` with `(uint256 pk, address owner)` is the smaller diff; update Task 4's call sites accordingly.

```solidity
    /// @dev Long: margin 1 WETH + flash 2,000 USDC swapped to ~0.6 WETH ⇒ ~1.6 aWETH supplied,
    ///      2,000 USDC variable debt on the user, contract empty.
    function test_OpenPosition_Long_SuppliesAndBorrows() public {
        uint256 margin = 1 ether;
        uint256 flashAmount = 2_000e6;
        uint256 wethOut = 0.6 ether;
        deal(WETH, openUser, margin);
        deal(WETH, address(router), wethOut);

        (,, address vDebt) = IDataProvider(DATA_PROVIDER).getReserveTokensAddresses(USDC);
        uint256 deadline = block.timestamp + 1200;

        vm.startPrank(openUser);
        IERC20Like(WETH).approve(address(lev), margin); // margin via plain approve; permit variant below
        vm.stopPrank();

        AaveV3Leverage.Permit memory noPermit; // value 0 = use the allowance above
        AaveV3Leverage.Permit memory delegation = _signDelegation(openUserPk, openUser, vDebt, flashAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (USDC, WETH, wethOut));

        vm.prank(openUser);
        lev.openPosition(WETH, USDC, margin, flashAmount, wethOut, address(router), deadline, swapData, noPermit, delegation);

        assertGe(IERC20Like(aWeth).balanceOf(openUser), margin + wethOut - 1, "aWETH not supplied");
        assertEq(IERC20Like(vDebt).balanceOf(openUser), flashAmount, "debt mismatch");
        assertEq(IERC20Like(WETH).balanceOf(address(lev)), 0, "WETH stuck");
        assertEq(IERC20Like(USDC).balanceOf(address(lev)), 0, "USDC stuck");
    }

    /// @dev Short: USDC collateral, WETH debt — the SAME code path with roles swapped.
    function test_OpenPosition_Short_IsSameCodePath() public {
        uint256 margin = 5_000e6;          // USDC margin
        uint256 flashAmount = 1 ether;     // flash WETH, swap to USDC
        uint256 usdcOut = 3_000e6;
        deal(USDC, openUser, margin);
        deal(USDC, address(router), usdcOut);

        (address aUsdc,,) = IDataProvider(DATA_PROVIDER).getReserveTokensAddresses(USDC);
        (,, address vDebtWeth) = IDataProvider(DATA_PROVIDER).getReserveTokensAddresses(WETH);
        uint256 deadline = block.timestamp + 1200;

        vm.prank(openUser);
        IERC20Like(USDC).approve(address(lev), margin);

        AaveV3Leverage.Permit memory noPermit;
        AaveV3Leverage.Permit memory delegation = _signDelegation(openUserPk, openUser, vDebtWeth, flashAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, usdcOut));

        vm.prank(openUser);
        lev.openPosition(USDC, WETH, margin, flashAmount, usdcOut, address(router), deadline, swapData, noPermit, delegation);

        assertGe(IERC20Like(aUsdc).balanceOf(openUser), margin + usdcOut - 1, "aUSDC not supplied");
        assertEq(IERC20Like(vDebtWeth).balanceOf(openUser), flashAmount, "WETH debt mismatch");
    }

    function test_OpenPosition_RevertsWhen_Expired() public {
        AaveV3Leverage.Permit memory z;
        vm.prank(openUser);
        vm.expectRevert(AaveV3Leverage.Expired.selector);
        lev.openPosition(WETH, USDC, 0, 1e6, 1, address(router), block.timestamp - 1, hex"", z, z);
    }

    /// @dev Slippage: router returns less collateral than minCollateralOut ⇒ InsufficientOutput.
    function test_OpenPosition_RevertsWhen_SwapUnderMinOut() public {
        uint256 flashAmount = 2_000e6;
        uint256 wethOut = 0.5 ether;
        deal(WETH, address(router), wethOut);
        (,, address vDebt) = IDataProvider(DATA_PROVIDER).getReserveTokensAddresses(USDC);
        uint256 deadline = block.timestamp + 1200;
        AaveV3Leverage.Permit memory noPermit;
        AaveV3Leverage.Permit memory delegation = _signDelegation(openUserPk, openUser, vDebt, flashAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (USDC, WETH, wethOut));

        vm.prank(openUser);
        vm.expectRevert(
            abi.encodeWithSelector(AaveV3Leverage.InsufficientOutput.selector, wethOut, wethOut + 1)
        );
        lev.openPosition(WETH, USDC, 0, flashAmount, wethOut + 1, address(router), deadline, swapData, noPermit, delegation);
    }
```

Adjust helper signatures/imports so the file compiles (`openUser`, `openUserPk` as state; delegation helper takes `(uint256 pk, address owner, address debtToken, uint256 value, uint256 deadline)`).

- [ ] **Step 3: Run the fork suite**

Run: `cd contract && RPC_URL=$RPC_URL forge test --match-path 'test/AaveV3LeverageFork.t.sol' -vv`
Expected: all PASS, including the four new open tests.

- [ ] **Step 4: Commit**

```bash
git add contract/test/AaveV3LeverageFork.t.sol
git commit -m "test: open-leg fork coverage — long, short, delegation, expiry, slippage"
```

---

### Task 6: Partial-close + round-trip fork tests

**Files:**
- Modify: `contract/test/AaveV3LeverageFork.t.sol`

**Interfaces:**
- Consumes: Tasks 4-5 harness (`user` with 10 WETH / 1,000 USDC position from `setUp`, `_signPermit`, `_signRevoke`, `_signDelegation`).

- [ ] **Step 1: Write the partial-close tests**

```solidity
    /// @dev Repay half the debt, withdraw 1 WETH: position stays open and healthy.
    function test_ClosePosition_PartialRepay_LeavesPositionOpen() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        uint256 repayAmount = debt / 2;
        uint256 debtOut = repayAmount + 10e6;
        deal(USDC, address(router), debtOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Leverage.Permit memory permit = _signPermit(userPk, user, 1 ether, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        lev.closePosition(WETH, USDC, repayAmount, 1 ether, repayAmount, address(router), swapData, permit, revoke);

        // Remaining debt ≈ debt - repayAmount (1 wei tolerance for the same-block index).
        assertApproxEqAbs(IERC20Like(vDebtUsdc).balanceOf(user), debt - repayAmount, 1, "wrong remaining debt");
        assertGt(IERC20Like(aWeth).balanceOf(user), 8 ether, "too much collateral gone");
        assertEq(IERC20Like(USDC).balanceOf(address(lev)), 0, "USDC stuck");
    }

    /// @dev Repay half but try to drain ALL collateral: Aave's HF validation in withdraw reverts.
    function test_ClosePosition_PartialRepay_RevertsWhen_WithdrawTooGreedy() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        uint256 repayAmount = debt / 2;
        deal(USDC, address(router), debt); // router output irrelevant; withdraw reverts first

        uint256 deadline = block.timestamp + 1200;
        uint256 collAll = IERC20Like(aWeth).balanceOf(user);
        AaveV3Leverage.Permit memory permit = _signPermit(userPk, user, collAll + collAll / 100, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, debt));

        vm.prank(user);
        vm.expectRevert(); // Aave: HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD
        lev.closePosition(WETH, USDC, repayAmount, type(uint256).max, 1, address(router), swapData, permit, revoke);
    }

    /// @dev repayAmount above the live debt behaves exactly as a full close (flash is capped).
    function test_ClosePosition_RepayAboveDebt_IsFullClose() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        uint256 debtOut = debt + 50e6;
        deal(USDC, address(router), debtOut);

        uint256 deadline = block.timestamp + 1200;
        uint256 collAll = IERC20Like(aWeth).balanceOf(user);
        AaveV3Leverage.Permit memory permit = _signPermit(userPk, user, collAll + collAll / 100, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        lev.closePosition(WETH, USDC, debt * 2, type(uint256).max, debt, address(router), swapData, permit, revoke);

        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
    }

    /// @dev Full lifecycle on one account: open a long, then fully close it.
    function test_RoundTrip_OpenThenClose() public {
        // Open: margin 1 WETH + flash 2,000 USDC → ~1.6 WETH supplied.
        uint256 margin = 1 ether;
        uint256 flashAmount = 2_000e6;
        uint256 wethOut = 0.6 ether;
        deal(WETH, openUser, margin);
        deal(WETH, address(router), wethOut);
        uint256 deadline = block.timestamp + 1200;
        AaveV3Leverage.Permit memory noPermit;
        AaveV3Leverage.Permit memory delegation = _signDelegation(openUserPk, openUser, vDebtUsdc, flashAmount, deadline);
        vm.prank(openUser);
        IERC20Like(WETH).approve(address(lev), margin);
        vm.prank(openUser);
        lev.openPosition(WETH, USDC, margin, flashAmount, wethOut, address(router), deadline,
            abi.encodeCall(MockRouterL.swap, (USDC, WETH, wethOut)), noPermit, delegation);

        // Close: flash the full debt back, mock router returns it with margin.
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(openUser);
        uint256 debtOut = debt + 25e6;
        deal(USDC, address(router), debtOut);
        uint256 collAll = IERC20Like(aWeth).balanceOf(openUser);
        AaveV3Leverage.Permit memory permit = _signPermit(openUserPk, openUser, collAll + collAll / 100, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(openUserPk, openUser, deadline);
        vm.prank(openUser);
        lev.closePosition(WETH, USDC, type(uint256).max, type(uint256).max, debt, address(router),
            abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut)), permit, revoke);

        assertEq(IERC20Like(vDebtUsdc).balanceOf(openUser), 0, "debt survived round trip");
        assertLt(IERC20Like(aWeth).balanceOf(openUser), 1e12, "collateral survived round trip");
    }
```

- [ ] **Step 2: Run the full fork suite**

Run: `cd contract && RPC_URL=$RPC_URL forge test --match-path 'test/AaveV3LeverageFork.t.sol' -vv`
Expected: all PASS.

- [ ] **Step 3: Run everything (regression)**

Run: `cd contract && RPC_URL=$RPC_URL forge test`
Expected: old Deleverager fork suite + payload tests + new suite all PASS.

- [ ] **Step 4: Commit**

```bash
git add contract/test/AaveV3LeverageFork.t.sol
git commit -m "test: partial-close semantics and open/close round trip"
```

---

### Task 7: SDK — `abi.ts` + module scaffold

**Files:**
- Create: `src/lib/leverage-sdk/abi.ts`, `src/lib/leverage-sdk/index.ts`
- Test: `src/lib/leverage-sdk/abi.test.ts`

**Interfaces:**
- Produces: `aaveV3LeverageAbi` (viem `parseAbi` const), `FULL_CLOSE` / `DRAIN_ALL` (= `2n**256n - 1n`), `PAUSE_OPEN = 1n`, `PAUSE_CLOSE = 2n`. No address constant — every SDK function takes the contract address as a parameter (the contract is not yet deployed).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/leverage-sdk/abi.test.ts
import { describe, expect, it } from "vitest";
import { getAbiItem } from "viem";
import { aaveV3LeverageAbi, FULL_CLOSE, PAUSE_CLOSE, PAUSE_OPEN } from "./abi";

describe("aaveV3LeverageAbi", () => {
  it("exposes openPosition and closePosition with the deployed shapes", () => {
    const open = getAbiItem({ abi: aaveV3LeverageAbi, name: "openPosition" });
    const close = getAbiItem({ abi: aaveV3LeverageAbi, name: "closePosition" });
    expect(open && "inputs" in open && open.inputs).toHaveLength(10);
    expect(close && "inputs" in close && close.inputs).toHaveLength(9);
  });

  it("sentinels match the contract", () => {
    expect(FULL_CLOSE).toBe(2n ** 256n - 1n);
    expect(PAUSE_OPEN | PAUSE_CLOSE).toBe(3n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run src/lib/leverage-sdk/abi.test.ts`
Expected: FAIL — module `./abi` not found.

- [ ] **Step 3: Implement**

```typescript
// src/lib/leverage-sdk/abi.ts
import { parseAbi } from "viem";

/** ABI of AaveV3Leverage (contract/src/AaveV3Leverage.sol). */
export const aaveV3LeverageAbi = parseAbi([
  "struct Permit { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "struct RevokePermit { uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function openPosition(address collateral, address debtAsset, uint256 marginAmount, uint256 flashAmount, uint256 minCollateralOut, address router, uint256 deadline, bytes swapData, Permit marginPermit, Permit delegation)",
  "function closePosition(address collateral, address debtAsset, uint256 repayAmount, uint256 collateralToWithdraw, uint256 minOut, address router, bytes swapData, Permit permit, RevokePermit revokePermit)",
  "function allowedRouters(address router) view returns (bool)",
  "function getAllowedRouters() view returns (address[])",
  "function paused() view returns (uint256)",
  "event PositionOpened(address indexed user, address indexed collateral, address indexed debtAsset, uint256 margin, uint256 collateralSupplied, uint256 debtBorrowed)",
  "event PositionClosed(address indexed user, address indexed collateral, address indexed debtAsset, uint256 debtRepaid, uint256 collateralWithdrawn, uint256 returnedToUser)",
] as const);

/** Sentinel: repay the entire variable debt / drain the whole aToken balance. */
export const FULL_CLOSE = 2n ** 256n - 1n;
export const DRAIN_ALL = FULL_CLOSE;

/** Pause bitmask, mirrors the contract constants. */
export const PAUSE_OPEN = 1n << 0n;
export const PAUSE_CLOSE = 1n << 1n;
```

```typescript
// src/lib/leverage-sdk/index.ts
export * from "./abi";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run src/lib/leverage-sdk/abi.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/leverage-sdk/
git commit -m "feat(sdk): leverage-sdk ABI module and sentinels"
```

---

### Task 8: SDK — `signatures.ts` (EIP-712 builders)

**Files:**
- Create: `src/lib/leverage-sdk/signatures.ts`
- Modify: `src/lib/leverage-sdk/index.ts` (add `export * from "./signatures";`)
- Test: `src/lib/leverage-sdk/signatures.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (pure builders).
- Produces:
  - `buildATokenPermit(p: PermitRequest): TypedPermit` and `buildRevokePermit(p: Omit<PermitRequest, "value">): TypedPermit` where `PermitRequest = { chainId: number; token: Address; tokenName: string; owner: Address; spender: Address; value: bigint; nonce: bigint; deadline: bigint }` and `TypedPermit = { domain; types; primaryType; message }` (viem `signTypedData` input, minus account).
  - `buildCreditDelegation(p: DelegationRequest): TypedDelegation` with `DelegationRequest = { chainId; debtToken: Address; debtTokenName: string; delegatee: Address; value: bigint; nonce: bigint; deadline: bigint }`.
  - `toContractPermit(sig: Hex, value: bigint, deadline: bigint)` → `{ value, deadline, v, r, s }`; `toContractRevoke(sig: Hex, deadline: bigint)` → `{ deadline, v, r, s }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/leverage-sdk/signatures.test.ts
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import {
  buildATokenPermit,
  buildCreditDelegation,
  buildRevokePermit,
  toContractPermit,
  toContractRevoke,
} from "./signatures";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const aToken = "0x0B925eD163218f6662a35e0f0371Ac234f9E9371"; // aWETH mainnet
const spender = "0x000000000000000000000000000000000000dEaD";

const base = {
  chainId: 1,
  token: aToken,
  tokenName: "Aave Ethereum WETH",
  owner: account.address,
  spender,
  value: 123n,
  nonce: 7n,
  deadline: 1_786_000_000n,
} as const;

describe("aToken permit pair", () => {
  it("signs a verifiable grant at nonce N", async () => {
    const typed = buildATokenPermit(base);
    expect(typed.domain).toEqual({ name: base.tokenName, version: "1", chainId: 1, verifyingContract: aToken });
    expect(typed.message.nonce).toBe(7n);
    const sig = await account.signTypedData(typed);
    expect(await verifyTypedData({ ...typed, address: account.address, signature: sig })).toBe(true);
    const p = toContractPermit(sig, base.value, base.deadline);
    expect([27, 28]).toContain(p.v);
    expect(p.value).toBe(123n);
  });

  it("builds the revoke at nonce N+1 with value 0", () => {
    const typed = buildRevokePermit(base);
    expect(typed.message.value).toBe(0n);
    expect(typed.message.nonce).toBe(8n); // grant nonce + 1
  });
});

describe("credit delegation", () => {
  it("signs a verifiable DelegationWithSig", async () => {
    const typed = buildCreditDelegation({
      chainId: 1,
      debtToken: "0x72E95b8931767C79bA4EeE721354d6E99a61D004",
      debtTokenName: "Aave Ethereum Variable Debt USDC",
      delegatee: spender,
      value: 10n ** 9n,
      nonce: 0n,
      deadline: 1_786_000_000n,
    });
    expect(typed.primaryType).toBe("DelegationWithSig");
    const sig = await account.signTypedData(typed);
    expect(await verifyTypedData({ ...typed, address: account.address, signature: sig })).toBe(true);
  });
});

describe("revoke split", () => {
  it("splits a signature without a value field", async () => {
    const typed = buildRevokePermit(base);
    const sig = await account.signTypedData(typed);
    const r = toContractRevoke(sig, base.deadline);
    expect(Object.keys(r).sort()).toEqual(["deadline", "r", "s", "v"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run src/lib/leverage-sdk/signatures.test.ts`
Expected: FAIL — module `./signatures` not found.

- [ ] **Step 3: Implement**

```typescript
// src/lib/leverage-sdk/signatures.ts
import { parseSignature, type Address, type Hex, type TypedDataDomain } from "viem";

/** EIP-2612 permit types shared by aTokens (and standard ERC-20 permits). */
const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Aave variable-debt-token credit delegation types. */
const DELEGATION_TYPES = {
  DelegationWithSig: [
    { name: "delegatee", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface PermitRequest {
  chainId: number;
  token: Address;
  /** ERC-20 `name()` of the token — part of the EIP-712 domain. */
  tokenName: string;
  owner: Address;
  spender: Address;
  value: bigint;
  /** Current `nonces(owner)` of the token. The revoke signs nonce + 1. */
  nonce: bigint;
  deadline: bigint;
}

export interface DelegationRequest {
  chainId: number;
  debtToken: Address;
  debtTokenName: string;
  delegatee: Address;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}

function domain(chainId: number, name: string, verifyingContract: Address): TypedDataDomain {
  return { name, version: "1", chainId, verifyingContract };
}

/** Grant permit at nonce N. Aave aTokens use EIP-712 domain version "1". */
export function buildATokenPermit(p: PermitRequest) {
  return {
    domain: domain(p.chainId, p.tokenName, p.token),
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: { owner: p.owner, spender: p.spender, value: p.value, nonce: p.nonce, deadline: p.deadline },
  };
}

/** Revoke permit: value 0 at nonce N+1, consumable only after the grant at N. */
export function buildRevokePermit(p: Omit<PermitRequest, "value">) {
  return {
    domain: domain(p.chainId, p.tokenName, p.token),
    types: PERMIT_TYPES,
    primaryType: "Permit" as const,
    message: { owner: p.owner, spender: p.spender, value: 0n, nonce: p.nonce + 1n, deadline: p.deadline },
  };
}

/** delegationWithSig payload: lets the contract borrow `value` on the signer's credit. */
export function buildCreditDelegation(p: DelegationRequest) {
  return {
    domain: domain(p.chainId, p.debtTokenName, p.debtToken),
    types: DELEGATION_TYPES,
    primaryType: "DelegationWithSig" as const,
    message: { delegatee: p.delegatee, value: p.value, nonce: p.nonce, deadline: p.deadline },
  };
}

/** Splits a 65-byte signature into the contract's Permit struct fields. */
export function toContractPermit(signature: Hex, value: bigint, deadline: bigint) {
  const { v, r, s } = parseSignature(signature);
  return { value, deadline, v: Number(v), r, s };
}

/** Splits a 65-byte signature into the contract's RevokePermit struct fields. */
export function toContractRevoke(signature: Hex, deadline: bigint) {
  const { v, r, s } = parseSignature(signature);
  return { deadline, v: Number(v), r, s };
}
```

Add `export * from "./signatures";` to `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run src/lib/leverage-sdk/signatures.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/leverage-sdk/
git commit -m "feat(sdk): EIP-712 builders for aToken permit pair and credit delegation"
```

---

### Task 9: SDK — `params.ts` (arg assembly + partial-close sizing)

**Files:**
- Create: `src/lib/leverage-sdk/params.ts`
- Modify: `src/lib/leverage-sdk/index.ts` (add `export * from "./params";`)
- Test: `src/lib/leverage-sdk/params.test.ts`

**Interfaces:**
- Consumes: `FULL_CLOSE` (Task 7), permit/revoke structs shaped as in Task 8's `toContractPermit`/`toContractRevoke`.
- Produces:
  - `buildOpenArgs(p): readonly [...]` / `buildCloseArgs(p): readonly [...]` — tuples in exact ABI order for `writeContract({ functionName, args })`.
  - `ZERO_PERMIT`, `ZERO_REVOKE` — zeroed structs for the existing-allowance path (the contract skips a permit when `value == 0` and a revoke when `deadline == 0`).
  - `maxSafeCollateralWithdraw(p: SizingInput): bigint` with `SizingInput = { totalCollateral: bigint; totalDebt: bigint; repayAmount: bigint; collateralPriceUsd: bigint; debtPriceUsd: bigint; collateralDecimals: number; debtDecimals: number; liquidationThresholdBps: bigint; targetHealthFactorBps: bigint }` — max `collateralToWithdraw` keeping post-close HF ≥ target; returns `FULL_CLOSE` when the remaining debt is 0.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/leverage-sdk/params.test.ts
import { describe, expect, it } from "vitest";
import { FULL_CLOSE } from "./abi";
import { buildCloseArgs, buildOpenArgs, maxSafeCollateralWithdraw, ZERO_PERMIT, ZERO_REVOKE } from "./params";

const A = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as const; // wstETH
const B = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const; // USDC
const R = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5" as const;

it("buildOpenArgs emits the tuple in ABI order", () => {
  const args = buildOpenArgs({
    collateral: A, debtAsset: B, marginAmount: 1n, flashAmount: 2n, minCollateralOut: 3n,
    router: R, deadline: 4n, swapData: "0x", marginPermit: ZERO_PERMIT, delegation: ZERO_PERMIT,
  });
  expect(args).toEqual([A, B, 1n, 2n, 3n, R, 4n, "0x", ZERO_PERMIT, ZERO_PERMIT]);
});

it("buildCloseArgs defaults to a full close and drain", () => {
  const args = buildCloseArgs({
    collateral: A, debtAsset: B, minOut: 5n, router: R, swapData: "0x",
    permit: ZERO_PERMIT, revokePermit: ZERO_REVOKE,
  });
  expect(args[2]).toBe(FULL_CLOSE); // repayAmount
  expect(args[3]).toBe(FULL_CLOSE); // collateralToWithdraw
});

describe("maxSafeCollateralWithdraw", () => {
  // 10 WETH @ $2,000, 1,000 USDC debt, LT 80%, target HF 1.5.
  const base = {
    totalCollateral: 10n * 10n ** 18n,
    totalDebt: 1_000n * 10n ** 6n,
    collateralPriceUsd: 2_000_00000000n, // 8-decimals oracle style
    debtPriceUsd: 1_00000000n,
    collateralDecimals: 18,
    debtDecimals: 6,
    liquidationThresholdBps: 8_000n,
    targetHealthFactorBps: 15_000n,
  };

  it("full repay frees all collateral", () => {
    expect(maxSafeCollateralWithdraw({ ...base, repayAmount: base.totalDebt })).toBe(FULL_CLOSE);
  });

  it("half repay leaves the HF-required floor supplied", () => {
    // Remaining debt $500 → required collateral = 500 * 1.5 / 0.8 = $937.50 = 0.46875 WETH.
    const out = maxSafeCollateralWithdraw({ ...base, repayAmount: base.totalDebt / 2n });
    expect(out).toBe(10n * 10n ** 18n - 468_750_000_000_000_000n);
  });

  it("zero repay still bounds by target HF", () => {
    // Debt $1,000 → required = 1000 * 1.5 / 0.8 = $1,875 = 0.9375 WETH.
    const out = maxSafeCollateralWithdraw({ ...base, repayAmount: 0n });
    expect(out).toBe(10n * 10n ** 18n - 937_500_000_000_000_000n);
  });

  it("clamps to zero when the floor exceeds the balance", () => {
    const out = maxSafeCollateralWithdraw({ ...base, totalCollateral: 10n ** 17n, repayAmount: 0n });
    expect(out).toBe(0n);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run src/lib/leverage-sdk/params.test.ts`
Expected: FAIL — module `./params` not found.

- [ ] **Step 3: Implement**

```typescript
// src/lib/leverage-sdk/params.ts
import type { Address, Hex } from "viem";
import { FULL_CLOSE } from "./abi";

export interface ContractPermit { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex }
export interface ContractRevoke { deadline: bigint; v: number; r: Hex; s: Hex }

const ZERO_B32 = `0x${"00".repeat(32)}` as Hex;
/** Existing-allowance path: the contract skips a permit whose value is 0. */
export const ZERO_PERMIT: ContractPermit = { value: 0n, deadline: 0n, v: 0, r: ZERO_B32, s: ZERO_B32 };
/** No-permit path: the contract skips a revoke whose deadline is 0. */
export const ZERO_REVOKE: ContractRevoke = { deadline: 0n, v: 0, r: ZERO_B32, s: ZERO_B32 };

export interface OpenParams {
  collateral: Address; debtAsset: Address; marginAmount: bigint; flashAmount: bigint;
  minCollateralOut: bigint; router: Address; deadline: bigint; swapData: Hex;
  marginPermit: ContractPermit; delegation: ContractPermit;
}

export interface CloseParams {
  collateral: Address; debtAsset: Address;
  /** Defaults to FULL_CLOSE (repay the entire variable debt). */
  repayAmount?: bigint;
  /** Defaults to FULL_CLOSE (drain the whole aToken balance). */
  collateralToWithdraw?: bigint;
  minOut: bigint; router: Address; swapData: Hex;
  permit: ContractPermit; revokePermit: ContractRevoke;
}

/** Args tuple for `writeContract({ functionName: "openPosition", args })`. */
export function buildOpenArgs(p: OpenParams) {
  return [
    p.collateral, p.debtAsset, p.marginAmount, p.flashAmount, p.minCollateralOut,
    p.router, p.deadline, p.swapData, p.marginPermit, p.delegation,
  ] as const;
}

/** Args tuple for `writeContract({ functionName: "closePosition", args })`. */
export function buildCloseArgs(p: CloseParams) {
  return [
    p.collateral, p.debtAsset, p.repayAmount ?? FULL_CLOSE, p.collateralToWithdraw ?? FULL_CLOSE,
    p.minOut, p.router, p.swapData, p.permit, p.revokePermit,
  ] as const;
}

export interface SizingInput {
  totalCollateral: bigint; totalDebt: bigint; repayAmount: bigint;
  /** Oracle prices in any shared fixed-point scale (both sides must use the same). */
  collateralPriceUsd: bigint; debtPriceUsd: bigint;
  collateralDecimals: number; debtDecimals: number;
  /** Aave liquidation threshold, e.g. 8000 = 80%. */
  liquidationThresholdBps: bigint;
  /** Post-close health-factor floor, e.g. 15000 = 1.5. Must be > 10000. */
  targetHealthFactorBps: bigint;
}

/**
 * Max `collateralToWithdraw` for a partial close keeping
 * HF = collateralUsd * LT / debtUsd >= target after repaying `repayAmount`.
 * Mirrors the on-chain reality: Aave enforces HF >= 1 inside withdraw; the target
 * adds headroom on top. Returns FULL_CLOSE when the remaining debt is zero.
 */
export function maxSafeCollateralWithdraw(p: SizingInput): bigint {
  const remainingDebt = p.repayAmount >= p.totalDebt ? 0n : p.totalDebt - p.repayAmount;
  if (remainingDebt === 0n) return FULL_CLOSE;

  const debtUsd = remainingDebt * p.debtPriceUsd; // scale: 10^debtDecimals * priceScale
  // requiredCollateralUsd = debtUsd * targetHF / LT, then back to collateral token units.
  // Ceil-divide both steps so rounding always errs toward MORE collateral kept.
  const requiredUsd = ceilDiv(debtUsd * p.targetHealthFactorBps, p.liquidationThresholdBps);
  // tokenUnits(coll) = requiredUsd * 10^collDecimals / (collPrice * 10^debtDecimals)
  const requiredCollateral = ceilDiv(
    requiredUsd * 10n ** BigInt(p.collateralDecimals),
    p.collateralPriceUsd * 10n ** BigInt(p.debtDecimals),
  );

  return requiredCollateral >= p.totalCollateral ? 0n : p.totalCollateral - requiredCollateral;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
```

Add `export * from "./params";` to `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run src/lib/leverage-sdk/params.test.ts`
Expected: PASS. If the two decimal-scaling branches disagree with the fixtures, fix the implementation (the fixtures are hand-computed and authoritative: 0.46875 WETH and 0.9375 WETH floors).

- [ ] **Step 5: Commit**

```bash
git add src/lib/leverage-sdk/
git commit -m "feat(sdk): open/close arg assembly and partial-close sizing"
```

---

### Task 10: SDK — `reads.ts` + full FE verification

**Files:**
- Create: `src/lib/leverage-sdk/reads.ts`
- Modify: `src/lib/leverage-sdk/index.ts` (add `export * from "./reads";`)
- Test: `src/lib/leverage-sdk/reads.test.ts`

**Interfaces:**
- Consumes: `aaveV3LeverageAbi` (Task 7).
- Produces: `getAllowedRouters(client, contract)`, `getPauseState(client, contract)` → `{ openPaused: boolean; closePaused: boolean }`, `getPermitContext(client, token, owner)` → `{ name: string; nonce: bigint }` (feeds Task 8's builders). All take `client: { readContract: Function }` — satisfied by any viem `PublicClient`; tests stub it.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/leverage-sdk/reads.test.ts
import { describe, expect, it } from "vitest";
import { getAllowedRouters, getPauseState, getPermitContext } from "./reads";

const CONTRACT = "0x000000000000000000000000000000000000BEEF" as const;
const TOKEN = "0x0B925eD163218f6662a35e0f0371Ac234f9E9371" as const;
const OWNER = "0x000000000000000000000000000000000000dEaD" as const;

function stubClient(responses: Record<string, unknown>) {
  return {
    calls: [] as Array<{ functionName: string; args?: readonly unknown[] }>,
    async readContract(p: { functionName: string; args?: readonly unknown[] }) {
      this.calls.push(p);
      return responses[p.functionName];
    },
  };
}

it("getAllowedRouters returns the enumerated set", async () => {
  const client = stubClient({ getAllowedRouters: [CONTRACT] });
  expect(await getAllowedRouters(client, CONTRACT)).toEqual([CONTRACT]);
});

it("getPauseState decodes the bitmask", async () => {
  const client = stubClient({ paused: 2n }); // PAUSE_CLOSE only
  expect(await getPauseState(client, CONTRACT)).toEqual({ openPaused: false, closePaused: true });
});

it("getPermitContext fetches name and nonce for the EIP-712 domain", async () => {
  const client = stubClient({ name: "Aave Ethereum WETH", nonces: 7n });
  const ctx = await getPermitContext(client, TOKEN, OWNER);
  expect(ctx).toEqual({ name: "Aave Ethereum WETH", nonce: 7n });
  expect(client.calls.find((c) => c.functionName === "nonces")?.args).toEqual([OWNER]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run src/lib/leverage-sdk/reads.test.ts`
Expected: FAIL — module `./reads` not found.

- [ ] **Step 3: Implement**

```typescript
// src/lib/leverage-sdk/reads.ts
import { parseAbi, type Address } from "viem";
import { aaveV3LeverageAbi, PAUSE_CLOSE, PAUSE_OPEN } from "./abi";

/** Minimal read surface — any viem PublicClient satisfies this. */
export interface ReadClient {
  readContract(params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

const permitContextAbi = parseAbi([
  "function name() view returns (string)",
  "function nonces(address owner) view returns (uint256)",
] as const);

/** Routers the owner has allowlisted — filter swap quotes to these before signing. */
export async function getAllowedRouters(client: ReadClient, contract: Address): Promise<readonly Address[]> {
  return (await client.readContract({
    address: contract, abi: aaveV3LeverageAbi, functionName: "getAllowedRouters",
  })) as readonly Address[];
}

/** Decodes the pause bitmask into per-leg flags. */
export async function getPauseState(client: ReadClient, contract: Address) {
  const bits = (await client.readContract({
    address: contract, abi: aaveV3LeverageAbi, functionName: "paused",
  })) as bigint;
  return { openPaused: (bits & PAUSE_OPEN) !== 0n, closePaused: (bits & PAUSE_CLOSE) !== 0n };
}

/** name() + nonces(owner) of an aToken or debt token — the EIP-712 domain inputs. */
export async function getPermitContext(client: ReadClient, token: Address, owner: Address) {
  const [name, nonce] = await Promise.all([
    client.readContract({ address: token, abi: permitContextAbi, functionName: "name" }) as Promise<string>,
    client.readContract({ address: token, abi: permitContextAbi, functionName: "nonces", args: [owner] }) as Promise<bigint>,
  ]);
  return { name, nonce };
}
```

Add `export * from "./reads";` to `index.ts`.

- [ ] **Step 4: Run the whole SDK suite + typecheck + full FE verification**

Run: `pnpm test -- --run src/lib/leverage-sdk/ && pnpm run build && pnpm run lint`
Expected: all SDK tests PASS, `tsc -b` clean, lint clean, existing FE tests unaffected (`pnpm test -- --run` for the full suite).

- [ ] **Step 5: Commit**

```bash
git add src/lib/leverage-sdk/
git commit -m "feat(sdk): read helpers for routers, pause state, and permit context"
```

---

## Follow-ups (explicitly NOT in this plan)

- Refactor `src/hooks/useDeleverageClose.ts` onto the SDK (spec: follow-up task; needs the deployed address).
- Deployment script for `AaveV3Leverage` + router setup, retirement of the two old contracts.
- FE open-position UI.
