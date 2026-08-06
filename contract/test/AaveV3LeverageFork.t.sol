// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {AaveV3Leverage} from "../src/AaveV3Leverage.sol";

/*//////////////////////////////////////////////////////////////
                        MINIMAL INTERFACES
////////////////////////////////////////////////--------------*/

interface IPoolFull {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);
}

interface IDataProvider {
    function getReserveTokensAddresses(address asset)
        external
        view
        returns (address aToken, address stableDebt, address variableDebt);
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface IAToken {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
}

/*//////////////////////////////////////////////////////////////
                        MOCK SWAP ROUTER
////////////////////////////////////////////////--------------*/

/// @notice Stand-in for a live aggregator. Pulls the exact collateral the leverager approved
///         (allowance == the amount it wants swapped) and hands back a fixed debt-asset amount.
///         Lets the fork test exercise the real flash-loan / repay / permit / withdraw path
///         without depending on off-chain, block-specific aggregator calldata.
contract MockRouterL {
    function swap(address collateral, address debtAsset, uint256 debtOut) external {
        uint256 amountIn = IERC20Like(collateral).allowance(msg.sender, address(this));
        IERC20Like(collateral).transferFrom(msg.sender, address(this), amountIn);
        IERC20Like(debtAsset).transfer(msg.sender, debtOut);
    }
}

/// @notice Mock router that pulls a FIXED `amountIn` (less than the approved allowance),
///         mirroring a real aggregator that swaps only `requiredIn` and leaves the cushion
///         behind for the leverager to sweep back to the user.
contract MockRouterFixedPullL {
    function swap(address collateral, uint256 amountIn, address debtAsset, uint256 debtOut) external {
        IERC20Like(collateral).transferFrom(msg.sender, address(this), amountIn);
        IERC20Like(debtAsset).transfer(msg.sender, debtOut);
    }
}

/// @notice Malicious router that re-enters closePosition mid-swap via the NEW signature. The
///         entry point's `_pendingDataHash != 0` check is what must stop it, now that
///         ReentrancyGuardTransient is gone.
contract MockRouterReenterL {
    function swap(address lev, address collateral, address debtAsset) external {
        AaveV3Leverage.Permit memory p;
        AaveV3Leverage.RevokePermit memory rp;
        AaveV3Leverage(lev).closePosition(collateral, debtAsset, 1, 1, 1, address(this), hex"", p, rp);
    }
}

/*//////////////////////////////////////////////////////////////
                            FORK TEST
////////////////////////////////////////////////--------------*/

contract AaveV3LeverageForkTest is Test {
    // Mainnet addresses (match the constants hardcoded in AaveV3Leverage).
    address constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant DATA_PROVIDER = 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // collateral
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // debt

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    bytes32 constant DELEGATION_WITH_SIG_TYPEHASH =
        keccak256("DelegationWithSig(address delegatee,uint256 value,uint256 nonce,uint256 deadline)");

    AaveV3Leverage lev;
    MockRouterL router;

    uint256 userPk = 0xA11CE;
    address user;
    address aWeth;
    address vDebtUsdc;

    address openUser;
    uint256 openUserPk = 0xB0B;

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));

        user = vm.addr(userPk);
        openUser = vm.addr(openUserPk);
        lev = new AaveV3Leverage(address(this));
        router = new MockRouterL();
        // The leverager only calls allowlisted routers; this test contract is the owner.
        lev.setRouters(_one(address(router)), true);

        (aWeth,,) = IDataProvider(DATA_PROVIDER).getReserveTokensAddresses(WETH);
        (,, vDebtUsdc) = IDataProvider(DATA_PROVIDER).getReserveTokensAddresses(USDC);

        // Give the user a real Aave position: supply 10 WETH, borrow 1,000 USDC.
        deal(WETH, user, 10 ether);
        vm.startPrank(user);
        IERC20Like(WETH).approve(POOL, 10 ether);
        IPoolFull(POOL).supply(WETH, 10 ether, user, 0);
        IPoolFull(POOL).borrow(USDC, 1_000e6, 2, 0, user);
        vm.stopPrank();
    }

    /// @dev Reproduces the ROOT CAUSE in isolation: Aave rejects the type(uint256).max repay-all
    ///      sentinel when repaying on behalf of a different account. This is exactly what the
    ///      pre-fix contract did (msg.sender = leverager, onBehalfOf = user), which reverted
    ///      with NoExplicitAmountToRepayOnBehalf().
    function test_Aave_RejectsMaxRepayOnBehalf() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        assertGt(debt, 0, "no debt set up");

        // This contract stands in for "some caller != user" (like the leverager).
        deal(USDC, address(this), debt);
        IERC20Like(USDC).approve(POOL, debt);

        vm.expectRevert(); // NoExplicitAmountToRepayOnBehalf()
        IPoolFull(POOL).repay(USDC, type(uint256).max, 2, user);
    }

    /// @dev End-to-end: the merged contract closes the position in one tx with a real aToken
    ///      permit, real Morpho flash loan, real Aave repay/withdraw, and a mocked swap.
    function test_ClosePositionWithPermit_ClosesDebtAndReturnsExcess() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        assertGt(debt, 0, "no debt set up");

        // Mock router returns debt + 50 USDC so output clears the flash loan with margin.
        uint256 debtOut = debt + 50e6;
        deal(USDC, address(router), debtOut);

        uint256 collAmount = IERC20Like(aWeth).balanceOf(user);
        assertGt(collAmount, 0, "no collateral");

        // Build the EIP-2612 permit on the aWETH token (spender = lev).
        uint256 permitValue = collAmount + collAmount / 100; // 1% rebase buffer, mirrors the frontend
        uint256 deadline = block.timestamp + 1200;
        AaveV3Leverage.Permit memory permit = _signPermit(userPk, user, address(lev), permitValue, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, address(lev), deadline);

        // Swap calldata for the mock router: collateral -> debt asset.
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut));

        uint256 userUsdcBefore = IERC20Like(USDC).balanceOf(user);

        // minOut floor = the debt itself (what the frontend passes). Sentinels = repay all / drain all.
        vm.prank(user);
        lev.closePosition(
            WETH, USDC, type(uint256).max, type(uint256).max, debt, address(router), swapData, permit, revoke
        );

        // The over-approved permit leaves nothing behind: the revoke at nonce N+1 clears it.
        assertEq(IERC20Like(aWeth).allowance(user, address(lev)), 0, "residual allowance survived");

        // Debt fully repaid.
        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
        // Collateral fully withdrawn (aToken burned).
        assertLt(IERC20Like(aWeth).balanceOf(user), 1e12, "collateral aToken dust remains");
        // Excess debt asset (debtOut - flashLoan) returned to the user.
        assertEq(IERC20Like(USDC).balanceOf(user) - userUsdcBefore, debtOut - debt, "excess not returned");
        // No funds stuck in the leverager.
        assertEq(IERC20Like(USDC).balanceOf(address(lev)), 0, "USDC stuck in contract");
        assertEq(IERC20Like(WETH).balanceOf(address(lev)), 0, "WETH stuck in contract");
    }

    /// @dev Partial withdraw: repay full debt but only pull ~1 WETH of collateral; the remaining
    ///      ~9 WETH must stay supplied in Aave (aToken balance retained).
    function test_ClosePositionWithPermit_PartialWithdraw_LeavesRestSupplied() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        assertGt(debt, 0, "no debt set up");

        uint256 debtOut = debt + 50e6;
        deal(USDC, address(router), debtOut);

        uint256 collBefore = IERC20Like(aWeth).balanceOf(user);
        uint256 collateralToWithdraw = 1 ether; // withdraw ~1 WETH; ~9 WETH stays supplied

        uint256 deadline = block.timestamp + 1200;
        // Fixed-amount pull → permit value is the exact amount, no rebase buffer.
        AaveV3Leverage.Permit memory permit =
            _signPermit(userPk, user, address(lev), collateralToWithdraw, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, address(lev), deadline);

        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        lev.closePosition(
            WETH, USDC, type(uint256).max, collateralToWithdraw, debt, address(router), swapData, permit, revoke
        );

        // Full debt repaid.
        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
        // The remainder is still supplied in Aave (~9 WETH aToken).
        assertApproxEqAbs(
            IERC20Like(aWeth).balanceOf(user), collBefore - collateralToWithdraw, 1e12, "remainder not left supplied"
        );
        // Nothing stuck in the leverager.
        assertEq(IERC20Like(USDC).balanceOf(address(lev)), 0, "USDC stuck in contract");
        assertLt(IERC20Like(WETH).balanceOf(address(lev)), 1e12, "WETH stuck in contract");
    }

    /// @dev Real partial path: the router consumes only part of the approved collateral
    ///      (requiredIn), and the leftover cushion must be swept to the user's wallet — not
    ///      stranded in the contract. Also proves collateralAmount >= the router's pull.
    function test_ClosePositionWithPermit_PartialWithdraw_SweepsCushionToWallet() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        assertGt(debt, 0, "no debt set up");

        uint256 debtOut = debt + 50e6;
        MockRouterFixedPullL fixedRouter = new MockRouterFixedPullL();
        lev.setRouters(_one(address(fixedRouter)), true);
        deal(USDC, address(fixedRouter), debtOut);

        uint256 collBefore = IERC20Like(aWeth).balanceOf(user);
        uint256 userWethBefore = IERC20Like(WETH).balanceOf(user);

        uint256 collateralToWithdraw = 1 ether; // contract withdraws + approves ~1 WETH
        uint256 routerPull = 0.999 ether; // router consumes less; cushion = 0.001 WETH left
        uint256 deadline = block.timestamp + 1200;
        AaveV3Leverage.Permit memory permit =
            _signPermit(userPk, user, address(lev), collateralToWithdraw, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, address(lev), deadline);

        bytes memory swapData = abi.encodeCall(MockRouterFixedPullL.swap, (WETH, routerPull, USDC, debtOut));

        vm.prank(user);
        lev.closePosition(
            WETH,
            USDC,
            type(uint256).max,
            collateralToWithdraw,
            debt,
            address(fixedRouter),
            swapData,
            permit,
            revoke
        );

        // Full debt repaid.
        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
        // The unswapped cushion (collateralToWithdraw - routerPull) is swept to the user's WALLET.
        assertApproxEqAbs(
            IERC20Like(WETH).balanceOf(user) - userWethBefore,
            collateralToWithdraw - routerPull,
            1e12,
            "cushion not returned to wallet"
        );
        // The rest stays supplied in Aave.
        assertApproxEqAbs(
            IERC20Like(aWeth).balanceOf(user), collBefore - collateralToWithdraw, 1e12, "remainder not left supplied"
        );
        // Nothing stuck in the leverager.
        assertEq(IERC20Like(WETH).balanceOf(address(lev)), 0, "WETH stuck in contract");
        assertEq(IERC20Like(USDC).balanceOf(address(lev)), 0, "USDC stuck in contract");
    }

    /// @dev Repay half the debt, withdraw 1 WETH: position stays open and healthy.
    function test_ClosePosition_PartialRepay_LeavesPositionOpen() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        uint256 repayAmount = debt / 2;
        uint256 debtOut = repayAmount + 10e6;
        deal(USDC, address(router), debtOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Leverage.Permit memory permit = _signPermit(userPk, user, address(lev), 1 ether, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, address(lev), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        lev.closePosition(WETH, USDC, repayAmount, 1 ether, repayAmount, address(router), swapData, permit, revoke);

        // Remaining debt ≈ debt - repayAmount (1 wei tolerance for the same-block index).
        assertApproxEqAbs(IERC20Like(vDebtUsdc).balanceOf(user), debt - repayAmount, 1, "wrong remaining debt");
        assertGt(IERC20Like(aWeth).balanceOf(user), 8 ether, "too much collateral gone");
        assertEq(IERC20Like(USDC).balanceOf(address(lev)), 0, "USDC stuck");
    }

    /// @dev Repay half but try to drain ALL collateral: Aave's HF validation in the aToken's
    /// `finalizeTransfer` hook (fired by the post-repay `safeTransferFrom` pull) reverts.
    function test_ClosePosition_PartialRepay_RevertsWhen_WithdrawTooGreedy() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        uint256 repayAmount = debt / 2;
        deal(USDC, address(router), debt); // router output irrelevant; withdraw reverts first

        uint256 deadline = block.timestamp + 1200;
        uint256 collAll = IERC20Like(aWeth).balanceOf(user);
        AaveV3Leverage.Permit memory permit = _signPermit(userPk, user, address(lev), collAll + collAll / 100, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, address(lev), deadline);
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
        AaveV3Leverage.Permit memory permit = _signPermit(userPk, user, address(lev), collAll + collAll / 100, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, address(lev), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        lev.closePosition(WETH, USDC, debt * 2, type(uint256).max, debt, address(router), swapData, permit, revoke);

        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
    }

    /*//////////////////////////////////////////////////////////////
                            OPEN POSITION
    //////////////////////////////////////////////////////////////*/

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
        lev.openPosition(WETH, USDC, margin, flashAmount, wethOut, address(router), swapData, delegation);

        assertGe(IERC20Like(aWeth).balanceOf(openUser), margin + wethOut - 1, "aWETH not supplied");
        // Variable-debt ray-math (mint's rayDiv then balanceOf's rayMul) can overshoot the
        // nominal borrowed amount by a wei; tolerate that rounding rather than the aToken itself.
        assertApproxEqAbs(IERC20Like(vDebt).balanceOf(openUser), flashAmount, 2, "debt mismatch");
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
        lev.openPosition(USDC, WETH, margin, flashAmount, usdcOut, address(router), swapData, delegation);

        assertGe(IERC20Like(aUsdc).balanceOf(openUser), margin + usdcOut - 1, "aUSDC not supplied");
        // Same variable-debt ray-math rounding as the long test — tolerate a wei of overshoot.
        assertApproxEqAbs(IERC20Like(vDebtWeth).balanceOf(openUser), flashAmount, 2, "WETH debt mismatch");
    }

    /// @dev Slippage: router returns less collateral than minCollateralOut ⇒ InsufficientOutput.
    function test_OpenPosition_RevertsWhen_SwapUnderMinOut() public {
        uint256 margin = 0.1 ether;
        uint256 flashAmount = 2_000e6;
        uint256 wethOut = 0.5 ether;
        deal(WETH, openUser, margin);
        deal(WETH, address(router), wethOut);
        (,, address vDebt) = IDataProvider(DATA_PROVIDER).getReserveTokensAddresses(USDC);
        uint256 deadline = block.timestamp + 1200;
        AaveV3Leverage.Permit memory delegation = _signDelegation(openUserPk, openUser, vDebt, flashAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (USDC, WETH, wethOut));

        vm.prank(openUser);
        IERC20Like(WETH).approve(address(lev), margin);

        vm.prank(openUser);
        vm.expectRevert(
            abi.encodeWithSelector(AaveV3Leverage.InsufficientOutput.selector, wethOut, wethOut + 1)
        );
        lev.openPosition(WETH, USDC, margin, flashAmount, wethOut + 1, address(router), swapData, delegation);
    }

    /// @dev Margin is mandatory on the open leg: zero margin trips ZeroAmount at entry.
    function test_OpenPosition_RevertsWhen_ZeroMargin() public {
        AaveV3Leverage.Permit memory z;
        vm.prank(openUser);
        vm.expectRevert(AaveV3Leverage.ZeroAmount.selector);
        lev.openPosition(WETH, USDC, 0, 1e6, 1, address(router), hex"", z);
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
        lev.openPosition(WETH, USDC, margin, flashAmount, wethOut, address(router),
            abi.encodeCall(MockRouterL.swap, (USDC, WETH, wethOut)), delegation);

        // Close: flash the full debt back, mock router returns it with margin.
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(openUser);
        uint256 debtOut = debt + 25e6;
        deal(USDC, address(router), debtOut);
        uint256 collAll = IERC20Like(aWeth).balanceOf(openUser);
        AaveV3Leverage.Permit memory permit = _signPermit(openUserPk, openUser, address(lev), collAll + collAll / 100, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(openUserPk, openUser, address(lev), deadline);
        vm.prank(openUser);
        lev.closePosition(WETH, USDC, type(uint256).max, type(uint256).max, debt, address(router),
            abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut)), permit, revoke);

        assertEq(IERC20Like(vDebtUsdc).balanceOf(openUser), 0, "debt survived round trip");
        assertLt(IERC20Like(aWeth).balanceOf(openUser), 1e12, "collateral survived round trip");
    }

    /*//////////////////////////////////////////////////////////////
                        CALLBACK / PAYLOAD GUARD
    //////////////////////////////////////////////////////////////*/

    /// @dev Only Morpho may invoke the callback.
    function test_Callback_RevertsWhen_CallerIsNotMorpho() public {
        vm.expectRevert(AaveV3Leverage.NotMorpho.selector);
        lev.onMorphoFlashLoan(1e6, hex"");
    }

    /// @dev Even from Morpho, a payload this contract never encoded must be rejected. Guards the
    ///      unchecked assembly decode of CloseParams: `_pendingDataHash` is 0 outside a close, so
    ///      the `iszero(expected)` arm fires. Regression test for the guard that used to `return`
    ///      instead of `revert`, silently no-opping the callback.
    function test_Callback_RevertsOn_ForgedPayload() public {
        bytes memory forged = abi.encode(
            AaveV3Leverage.CloseParams({
                user: user,
                collateral: WETH,
                debtAsset: USDC,
                collateralToWithdraw: type(uint256).max,
                minOut: 1,
                router: address(router),
                revokePermit: AaveV3Leverage.RevokePermit({deadline: 0, v: 0, r: bytes32(0), s: bytes32(0)}),
                swapData: hex""
            })
        );

        vm.prank(MORPHO);
        vm.expectRevert(AaveV3Leverage.UnexpectedCallback.selector);
        lev.onMorphoFlashLoan(1e6, forged);
    }

    /// @dev A router that calls back into closePosition mid-swap must be stopped by the
    ///      `_pendingDataHash != 0` entry check (the replacement for ReentrancyGuardTransient).
    function test_Reentrancy_RouterCannotReenterClose() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        MockRouterReenterL evil = new MockRouterReenterL();
        lev.setRouters(_one(address(evil)), true);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Leverage.Permit memory permit = _signPermit(userPk, user, address(lev), 1 ether, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, address(lev), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterReenterL.swap, (address(lev), WETH, USDC));

        vm.prank(user);
        vm.expectRevert(AaveV3Leverage.Reentrancy.selector);
        lev.closePosition(WETH, USDC, type(uint256).max, 1 ether, debt, address(evil), swapData, permit, revoke);
    }

    /*//////////////////////////////////////////////////////////////
                            ENTRY VALIDATION
    //////////////////////////////////////////////////////////////*/

    /// @dev The `permit.value == 0` mode: rely on an allowance the user granted in a prior tx.
    ///      With the hoist, "skip permit" now means BOTH `permit.value == 0` AND
    ///      `revokePermit.deadline == 0` (zeroed structs) — no permit call is made at entry, and
    ///      no revoke runs in the callback. The manual allowance is approved with a cushion above
    ///      the pulled amount, so the post-close allowance proves the pull decrements it exactly
    ///      rather than being swept to zero by an implicit revoke.
    function test_ClosePosition_WithExistingAllowance_SkipsPermit() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        uint256 debtOut = debt + 50e6;
        deal(USDC, address(router), debtOut);

        uint256 collateralToWithdraw = 1 ether;
        uint256 approvedAmount = collateralToWithdraw + 1 ether; // cushion above the pull
        vm.prank(user);
        IERC20Like(aWeth).approve(address(lev), approvedAmount);

        AaveV3Leverage.Permit memory empty;
        AaveV3Leverage.RevokePermit memory emptyRevoke;
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        lev.closePosition(
            WETH, USDC, type(uint256).max, collateralToWithdraw, debt, address(router), swapData, empty, emptyRevoke
        );

        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "debt not cleared via allowance path");
        // The aToken is rebasing, so its scaled-balance transferFrom can shave the allowance
        // debit by a wei versus the nominal pull; assert within that rounding, not bit-exact.
        assertApproxEqAbs(
            IERC20Like(aWeth).allowance(user, address(lev)),
            approvedAmount - collateralToWithdraw,
            2,
            "manual allowance not decremented by ~the pulled amount"
        );
    }

    function test_RevertsWhen_RouterNotAllowlisted() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        AaveV3Leverage.Permit memory empty;
        AaveV3Leverage.RevokePermit memory emptyRevoke;

        vm.prank(user);
        vm.expectRevert(AaveV3Leverage.RouterNotAllowed.selector);
        lev.closePosition(WETH, USDC, type(uint256).max, 1 ether, debt, address(0xBAD), hex"", empty, emptyRevoke);
    }

    function test_RevertsWhen_Paused() public {
        lev.setPause(lev.PAUSE_CLOSE());
        AaveV3Leverage.Permit memory empty;
        AaveV3Leverage.RevokePermit memory emptyRevoke;

        vm.prank(user);
        vm.expectRevert(AaveV3Leverage.Paused.selector);
        lev.closePosition(WETH, USDC, type(uint256).max, 1 ether, 1, address(router), hex"", empty, emptyRevoke);
    }

    /// @dev Halting PAUSE_OPEN alone must not block closePosition — the emergency posture is
    ///      "stop new leverage, let existing positions still unwind."
    function test_OpenOnlyPause_DoesNotBlockClose() public {
        lev.setPause(lev.PAUSE_OPEN());

        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        assertGt(debt, 0, "no debt set up");

        uint256 debtOut = debt + 50e6;
        deal(USDC, address(router), debtOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Leverage.Permit memory permit = _signPermit(userPk, user, address(lev), 1 ether, deadline);
        AaveV3Leverage.RevokePermit memory revoke = _signRevoke(userPk, user, address(lev), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterL.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        lev.closePosition(WETH, USDC, type(uint256).max, 1 ether, debt, address(router), swapData, permit, revoke);

        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "close blocked while only PAUSE_OPEN was set");
    }

    function test_RevertsWhen_SameAsset() public {
        AaveV3Leverage.Permit memory empty;
        AaveV3Leverage.RevokePermit memory emptyRevoke;
        vm.prank(user);
        vm.expectRevert(AaveV3Leverage.SameAsset.selector);
        lev.closePosition(WETH, WETH, type(uint256).max, 1 ether, 1, address(router), hex"", empty, emptyRevoke);
    }

    function test_RevertsWhen_ZeroCollateralOrMinOut() public {
        AaveV3Leverage.Permit memory empty;
        AaveV3Leverage.RevokePermit memory emptyRevoke;

        vm.prank(user);
        vm.expectRevert(AaveV3Leverage.ZeroAmount.selector);
        lev.closePosition(WETH, USDC, 0, 1 ether, 1, address(router), hex"", empty, emptyRevoke);

        vm.prank(user);
        vm.expectRevert(AaveV3Leverage.ZeroAmount.selector);
        lev.closePosition(WETH, USDC, type(uint256).max, 0, 1, address(router), hex"", empty, emptyRevoke);

        vm.prank(user);
        vm.expectRevert(AaveV3Leverage.ZeroAmount.selector);
        lev.closePosition(WETH, USDC, type(uint256).max, 1 ether, 0, address(router), hex"", empty, emptyRevoke);
    }

    /// @dev A caller with no variable debt in the reserve is rejected before the flash loan.
    function test_RevertsWhen_NoDebt() public {
        AaveV3Leverage.Permit memory empty;
        AaveV3Leverage.RevokePermit memory emptyRevoke;
        address stranger = address(0xBEEF);

        vm.prank(stranger);
        vm.expectRevert(AaveV3Leverage.NoDebt.selector);
        lev.closePosition(WETH, USDC, type(uint256).max, 1 ether, 1, address(router), hex"", empty, emptyRevoke);
    }

    /*//////////////////////////////////////////////////////////////
                                ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_RescueToken_SweepsStrayBalance() public {
        deal(USDC, address(lev), 123e6);

        lev.rescueToken(USDC, address(this));

        assertEq(IERC20Like(USDC).balanceOf(address(lev)), 0, "not swept");
        assertEq(IERC20Like(USDC).balanceOf(address(this)), 123e6, "not received");
    }

    function test_Admin_RevertsOn_ZeroAddress() public {
        vm.expectRevert(AaveV3Leverage.ZeroAddress.selector);
        lev.setRouters(_one(address(0)), true);

        vm.expectRevert(AaveV3Leverage.ZeroAddress.selector);
        lev.rescueToken(USDC, address(0));
    }

    function test_Admin_OnlyOwner() public {
        // Read the constant before pranking: `lev.PAUSE_CLOSE()` is itself an external call, and
        // evaluating it as a call argument would otherwise consume `vm.expectRevert`'s "next call".
        uint256 closeBit = lev.PAUSE_CLOSE();
        vm.startPrank(user);

        vm.expectRevert(bytes4(0x82b42900)); // Solady Ownable.Unauthorized()
        lev.setRouters(_one(address(router)), false);

        vm.expectRevert(bytes4(0x82b42900));
        lev.setPause(closeBit);

        vm.expectRevert(bytes4(0x82b42900));
        lev.rescueToken(USDC, user);

        vm.stopPrank();
    }

    function test_SetRouters_SingleEntryTogglesAllowlist() public {
        address r = address(0xB0B);
        assertFalse(lev.allowedRouters(r), "allowed before set");
        lev.setRouters(_one(r), true);
        assertTrue(lev.allowedRouters(r), "not allowed after set");
        lev.setRouters(_one(r), false);
        assertFalse(lev.allowedRouters(r), "still allowed after unset");
    }

    /// @dev The allowlist is enumerable so a frontend can read it whole and filter swap
    ///      routes before quoting, rather than probing one router at a time.
    function test_GetAllowedRouters_EnumeratesAndPrunes() public {
        // setUp already allowlisted `router`.
        assertEq(lev.getAllowedRouters().length, 1, "unexpected initial count");
        assertEq(lev.getAllowedRouters()[0], address(router), "initial entry wrong");

        address a = address(0xA11);
        address b = address(0xB22);
        lev.setRouters(_one(a), true);
        lev.setRouters(_one(b), true);
        assertEq(lev.getAllowedRouters().length, 3, "count after adds");

        // Re-adding an existing router must not duplicate it.
        lev.setRouters(_one(a), true);
        assertEq(lev.getAllowedRouters().length, 3, "duplicate added");

        lev.setRouters(_one(a), false);
        assertFalse(lev.allowedRouters(a), "removed router still allowed");

        address[] memory all = lev.getAllowedRouters();
        assertEq(all.length, 2, "values() length mismatch");
        for (uint256 i; i < all.length; ++i) {
            assertTrue(lev.allowedRouters(all[i]), "enumerated router not allowed");
            assertTrue(all[i] != a, "removed router still enumerated");
        }

        // Removing an absent router is a no-op, not a revert.
        lev.setRouters(_one(address(0xDEAD)), false);
        assertEq(lev.getAllowedRouters().length, 2, "no-op removal changed the set");
    }

    /// @dev Batch form. The allowlist is configured across several aggregators at once, and
    ///      doing it in one owner call keeps that atomic: a half-applied allowlist leaves the
    ///      frontend quoting routes whose router reverts with RouterNotAllowed() only after
    ///      the user has already signed a permit.
    function test_SetRouters_BatchTogglesAllowlist() public {
        address a = address(0xA11);
        address b = address(0xB22);
        address c = address(0xC33);

        address[] memory batch = new address[](3);
        batch[0] = a;
        batch[1] = b;
        batch[2] = c;

        // setUp already allowlisted `router`, so the batch lands three on top of it.
        lev.setRouters(batch, true);
        assertEq(lev.getAllowedRouters().length, 4, "count after batch add");
        assertTrue(lev.allowedRouters(a), "a not allowed");
        assertTrue(lev.allowedRouters(b), "b not allowed");
        assertTrue(lev.allowedRouters(c), "c not allowed");

        // Re-applying the same batch must not duplicate entries.
        lev.setRouters(batch, true);
        assertEq(lev.getAllowedRouters().length, 4, "batch re-add duplicated");

        lev.setRouters(batch, false);
        assertEq(lev.getAllowedRouters().length, 1, "count after batch revoke");
        assertEq(lev.getAllowedRouters()[0], address(router), "wrong survivor");
    }

    /// @dev One bad entry reverts the whole batch. Partially applying it would be worse than
    ///      applying none: the owner reads the tx as failed while some routers went live.
    function test_SetRouters_RevertsWhen_BatchContainsZeroAddress() public {
        address[] memory batch = new address[](2);
        batch[0] = address(0xA11);
        batch[1] = address(0);

        vm.expectRevert(AaveV3Leverage.ZeroAddress.selector);
        lev.setRouters(batch, true);

        assertFalse(lev.allowedRouters(address(0xA11)), "earlier entry survived the revert");
    }

    function test_SetRouters_RevertsWhen_NotOwner() public {
        address[] memory batch = new address[](1);
        batch[0] = address(0xA11);

        vm.prank(address(0xBAD));
        vm.expectRevert(); // Solady Ownable.Unauthorized()
        lev.setRouters(batch, true);
    }

    /// @dev An empty batch is a no-op rather than a revert — the loop simply never runs.
    function test_SetRouters_EmptyBatchIsNoOp() public {
        address[] memory batch = new address[](0);
        lev.setRouters(batch, true);
        assertEq(lev.getAllowedRouters().length, 1, "empty batch changed the set");
    }

    /// @dev `setRouters` is the only allowlist setter, so the single-router cases still have to
    ///      pass an array. Wrapping that here keeps each test's intent readable.
    function _one(address router_) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = router_;
    }

    /// @dev Parameterized by (pk, owner) so future tests can sign for a different account without
    ///      touching this helper.
    function _signPermit(uint256 pk, address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (AaveV3Leverage.Permit memory)
    {
        uint256 nonce = IAToken(aWeth).nonces(owner);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IAToken(aWeth).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return AaveV3Leverage.Permit({value: value, deadline: deadline, v: v, r: r, s: s});
    }

    /// @dev The revoke half of the pair: value 0 at nonce N+1, so it can only be consumed
    ///      after the granting permit at nonce N.
    function _signRevoke(uint256 pk, address owner, address spender, uint256 deadline)
        internal
        view
        returns (AaveV3Leverage.RevokePermit memory)
    {
        uint256 nonce = IAToken(aWeth).nonces(owner) + 1;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, uint256(0), nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IAToken(aWeth).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return AaveV3Leverage.RevokePermit({deadline: deadline, v: v, r: r, s: s});
    }

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
}
