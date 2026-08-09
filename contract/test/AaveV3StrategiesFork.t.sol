// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {AaveV3Strategies} from "../src/AaveV3Strategies.sol";

interface IPoolFullS {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
}

interface IDataProviderS {
    function getReserveTokensAddresses(address asset)
        external
        view
        returns (address aToken, address stableDebt, address variableDebt);
}

interface IERC20LikeS {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}

interface ITokenSigS {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
    function borrowAllowance(address fromUser, address toUser) external view returns (uint256);
}

interface IDelegationS {
    function approveDelegation(address delegatee, uint256 amount) external;
}

/// @dev Pulls the exact allowance of `tokenIn` and pays out a fixed `amountOut` of `tokenOut`.
contract MockRouterS {
    function swap(address tokenIn, address tokenOut, uint256 amountOut) external {
        uint256 amountIn = IERC20LikeS(tokenIn).allowance(msg.sender, address(this));
        IERC20LikeS(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20LikeS(tokenOut).transfer(msg.sender, amountOut);
    }
}

/// @dev Pulls a FIXED amountIn (less than approved) and pays a fixed amountOut — mirrors an
///      aggregator that consumes only requiredIn and leaves the cushion behind.
contract MockRouterFixedPullS {
    function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut) external {
        IERC20LikeS(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20LikeS(tokenOut).transfer(msg.sender, amountOut);
    }
}

/// @dev Malicious router that re-enters closePositionWithPermit mid-swap; the transient
///      `_pendingDataHash` guard must stop it.
contract MockRouterReenterS {
    function swap(address strategies, address collateral, address debtAsset) external {
        AaveV3Strategies.Permit memory p;
        AaveV3Strategies.Sig memory rp;
        AaveV3Strategies(strategies).closePositionWithPermit(
            collateral, debtAsset, 1, 1, 1, address(this), p, rp, hex""
        );
    }
}

/// @dev Malicious router that re-enters the OPEN entry point mid-swap — the close-side twin of
///      {MockRouterReenterS}. The same transient guard must stop it.
contract MockRouterReenterOpenS {
    function swap(address strategies, address collateral, address debtAsset) external {
        AaveV3Strategies.Sig memory d;
        AaveV3Strategies(strategies).openWithDebtMargin(
            collateral, debtAsset, 1, 1, 0, 1, address(this), hex"", d
        );
    }
}

contract AaveV3StrategiesForkTest is Test {
    address constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant DATA_PROVIDER = 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant DELEGATION_WITH_SIG_TYPEHASH =
        keccak256("DelegationWithSig(address delegatee,uint256 value,uint256 nonce,uint256 deadline)");

    AaveV3Strategies strat;
    MockRouterS router;

    uint256 userPk = 0xA11CE;
    address user;
    address aWeth;
    address vDebtUsdc;

    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    /// @dev Aave's `InvalidExpiration()` — what a permit with a zero deadline reverts with.
    bytes4 constant AAVE_INVALID_EXPIRATION = 0xfb2a6752;
    /// @dev Solady `Ownable.Unauthorized()`.
    bytes4 constant UNAUTHORIZED = 0x82b42900;

    function setUp() public {
        // Unpinned by default (the RPC's head), but set FORK_BLOCK to make a run reproducible —
        // aToken interest accrues between blocks and drifts the 1-wei assertions below.
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(vm.envString("RPC_URL"));
        else vm.createSelectFork(vm.envString("RPC_URL"), forkBlock);

        user = vm.addr(userPk);
        strat = new AaveV3Strategies(address(this), MORPHO, POOL);
        router = new MockRouterS();
        strat.setRouters(_one(address(router)), true);

        (aWeth,,) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(WETH);
        (,, vDebtUsdc) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(USDC);

        // Real Aave position: supply 10 WETH, borrow 1,000 USDC.
        deal(WETH, user, 10 ether);
        vm.startPrank(user);
        IERC20LikeS(WETH).approve(POOL, 10 ether);
        IPoolFullS(POOL).supply(WETH, 10 ether, user, 0);
        IPoolFullS(POOL).borrow(USDC, 1_000e6, 2, 0, user);
        vm.stopPrank();
    }

    /// @dev Full close with the permit pair: debt cleared, collateral drained, excess returned.
    function test_Close_FullWithPermit() public {
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 debtOut = debt + 50e6;
        deal(USDC, address(router), debtOut);

        uint256 collAmount = IERC20LikeS(aWeth).balanceOf(user);
        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory permit =
            _signPermit(user, address(strat), collAmount + collAmount / 100, deadline);
        AaveV3Strategies.Sig memory revoke = _signRevoke(user, address(strat), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, debtOut));

        uint256 usdcBefore = IERC20LikeS(USDC).balanceOf(user);

        vm.prank(user);
        strat.closePositionWithPermit(
            WETH, USDC, type(uint256).max, type(uint256).max, debt, address(router), permit, revoke, swapData
        );

        assertEq(IERC20LikeS(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
        assertLt(IERC20LikeS(aWeth).balanceOf(user), 1e12, "collateral dust remains");
        assertEq(IERC20LikeS(aWeth).allowance(user, address(strat)), 0, "residual allowance");
        assertEq(IERC20LikeS(USDC).balanceOf(user) - usdcBefore, debtOut - debt, "excess not returned");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
    }

    /// @dev Partial close: repay half, pull 1 WETH; position stays open and healthy.
    function test_Close_PartialRepay() public {
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 repay = debt / 2;
        uint256 debtOut = repay + 10e6;
        deal(USDC, address(router), debtOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory permit = _signPermit(user, address(strat), 1 ether, deadline);
        AaveV3Strategies.Sig memory revoke = _signRevoke(user, address(strat), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        strat.closePositionWithPermit(WETH, USDC, 1 ether, repay, repay, address(router), permit, revoke, swapData);

        assertApproxEqAbs(IERC20LikeS(vDebtUsdc).balanceOf(user), debt - repay, 1, "wrong remaining debt");
        assertGt(IERC20LikeS(aWeth).balanceOf(user), 8 ether, "too much collateral gone");
    }

    /// @dev Open with EXACT exposure: flash-supplied collateral, debt-asset margin, one swap.
    ///      Surplus WETH above the flash repayment is supplied for the user too.
    function test_Mode2_LongX_HoldingStable() public {
        address openUser = vm.addr(0xB0B);
        uint256 supplyAmount = 1.5 ether;
        uint256 borrowAmount = 2_000e6;
        uint256 margin = 1_050e6;      // USDC margin — no WETH in the wallet at all
        uint256 wethOut = 1.52 ether;  // covers the 1.5 flash + 0.02 surplus
        deal(USDC, openUser, margin);
        deal(WETH, address(router), wethOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation =
            _signDelegation(0xB0B, openUser, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, wethOut));

        vm.prank(openUser);
        IERC20LikeS(USDC).approve(address(strat), margin);
        vm.prank(openUser);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, margin, supplyAmount, address(router), swapData, delegation
        );

        // Exact exposure + surplus folded in: 1.5 supplied for the flash, 0.02 surplus supplied.
        // Two supplies (flash amount + surplus) each round a wei down in scaled-balance math.
        assertGe(IERC20LikeS(aWeth).balanceOf(openUser), wethOut - 2, "aWETH not supplied");
        assertApproxEqAbs(IERC20LikeS(vDebtUsdc).balanceOf(openUser), borrowAmount, 2, "debt mismatch");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
        // The delegation was signed over exactly borrowAmount, so the borrow consumed it whole.
        assertEq(ITokenSigS(vDebtUsdc).borrowAllowance(openUser, address(strat)), 0, "residual delegation");
    }

    /// @dev Router pulls less USDC than approved; the leftover repays the user's fresh debt
    ///      on their behalf instead of dusting the wallet.
    function test_Open_LeftoverUsdcRepaysDebt() public {
        MockRouterFixedPullS fixedRouter = new MockRouterFixedPullS();
        strat.setRouters(_one(address(fixedRouter)), true);

        address openUser = vm.addr(0xB0B);
        uint256 supplyAmount = 1.5 ether;
        uint256 borrowAmount = 2_000e6;
        uint256 margin = 1_050e6;
        uint256 pulled = 3_000e6;      // router consumes 3,000 of the 3,050 approved
        deal(USDC, openUser, margin);
        deal(WETH, address(fixedRouter), supplyAmount);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation =
            _signDelegation(0xB0B, openUser, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterFixedPullS.swap, (USDC, pulled, WETH, supplyAmount));

        vm.prank(openUser);
        IERC20LikeS(USDC).approve(address(strat), margin);
        vm.prank(openUser);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, margin, supplyAmount, address(fixedRouter), swapData, delegation
        );

        // 50 USDC leftover repaid the debt: 2,000 borrowed - 50 = 1,950 remaining.
        // Borrow + same-tx repay compounds two ray-roundings; live-fork drift is 1-3 units.
        assertApproxEqAbs(IERC20LikeS(vDebtUsdc).balanceOf(openUser), borrowAmount - 50e6, 5, "leftover not repaid");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
    }

    /// @dev The borrow is mandatory: nothing would fund the swap that repays the flash.
    function test_Open_RevertsWhen_ZeroBorrow() public {
        AaveV3Strategies.Sig memory z;
        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector);
        strat.openWithDebtMargin(WETH, USDC, 1 ether, 0, 1e6, 1, address(router), hex"", z);
    }

    /// @dev Zero margin is a legitimate leverage ratchet: `user` already has 10 WETH supplied and
    ///      spare borrowing power, so the new exposure is funded entirely by the fresh borrow.
    function test_Mode2_ZeroMargin_LeverageRatchet() public {
        uint256 supplyAmount = 1 ether;
        uint256 borrowAmount = 2_000e6;
        uint256 wethOut = 1.01 ether;  // the borrow alone covers the flash + surplus
        deal(WETH, address(router), wethOut);

        uint256 aWethBefore = IERC20LikeS(aWeth).balanceOf(user);
        uint256 debtBefore = IERC20LikeS(vDebtUsdc).balanceOf(user);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation =
            _signDelegation(userPk, user, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, wethOut));

        vm.prank(user);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, 0, supplyAmount, address(router), swapData, delegation
        );

        assertGe(IERC20LikeS(aWeth).balanceOf(user) - aWethBefore, wethOut - 2, "aWETH not supplied");
        assertApproxEqAbs(
            IERC20LikeS(vDebtUsdc).balanceOf(user) - debtBefore, borrowAmount, 2, "debt mismatch"
        );
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
    }

    /// @dev Mode 1 — long WETH holding WETH: collateral margin joins the flash in one supply.
    function test_Mode1_LongX_HoldingX() public {
        address openUser = vm.addr(0xB0B);
        uint256 marginWeth = 1 ether;
        uint256 flashWeth = 1 ether;
        uint256 borrowUsdc = 2_000e6;
        uint256 wethOut = 1.005 ether; // swap of the borrow must cover the 1 WETH flash
        deal(WETH, openUser, marginWeth);
        deal(WETH, address(router), wethOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation =
            _signDelegation(0xB0B, openUser, vDebtUsdc, borrowUsdc, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, wethOut));

        vm.prank(openUser);
        IERC20LikeS(WETH).approve(address(strat), marginWeth);
        vm.prank(openUser);
        strat.openWithCollateralMargin(
            WETH, USDC, flashWeth, borrowUsdc, marginWeth, flashWeth, address(router), swapData, delegation
        );

        // Supplied = margin + flash + surplus (0.005), each supply rounding ≤1 wei down.
        assertGe(IERC20LikeS(aWeth).balanceOf(openUser), marginWeth + wethOut - 2, "aWETH short");
        assertApproxEqAbs(IERC20LikeS(vDebtUsdc).balanceOf(openUser), borrowUsdc, 2, "debt mismatch");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
    }

    /// @dev Mode 3 — short WETH holding WETH: same openWithDebtMargin code path, roles swapped
    ///      (USDC is the collateral, WETH is the debt AND the margin asset).
    function test_Mode3_ShortX_HoldingX() public {
        address openUser = vm.addr(0xB0B);
        uint256 flashUsdc = 4_000e6;   // exact USDC exposure supplied
        uint256 borrowWeth = 0.5 ether;
        uint256 marginWeth = 0.5 ether;
        uint256 usdcOut = 4_005e6;     // swap of borrow+margin WETH must cover the flash
        deal(WETH, openUser, marginWeth);
        deal(USDC, address(router), usdcOut);

        (address aUsdc,,) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(USDC);
        (,, address vDebtWeth) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(WETH);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation =
            _signDelegation(0xB0B, openUser, vDebtWeth, borrowWeth, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, usdcOut));

        vm.prank(openUser);
        IERC20LikeS(WETH).approve(address(strat), marginWeth);
        vm.prank(openUser);
        strat.openWithDebtMargin(
            USDC, WETH, flashUsdc, borrowWeth, marginWeth, flashUsdc, address(router), swapData, delegation
        );

        assertGe(IERC20LikeS(aUsdc).balanceOf(openUser), usdcOut - 2, "aUSDC short");
        assertApproxEqAbs(IERC20LikeS(vDebtWeth).balanceOf(openUser), borrowWeth, 2, "WETH debt mismatch");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
    }

    /// @dev Mode 4 — short WETH holding USDC: collateral-margin flow with stable roles.
    function test_Mode4_ShortX_HoldingStable() public {
        address openUser = vm.addr(0xB0B);
        uint256 marginUsdc = 2_000e6;
        uint256 flashUsdc = 2_000e6;
        uint256 borrowWeth = 0.5 ether;
        uint256 usdcOut = 2_005e6;     // swap of the borrowed WETH must cover the USDC flash
        deal(USDC, openUser, marginUsdc);
        deal(USDC, address(router), usdcOut);

        (address aUsdc,,) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(USDC);
        (,, address vDebtWeth) = IDataProviderS(DATA_PROVIDER).getReserveTokensAddresses(WETH);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation =
            _signDelegation(0xB0B, openUser, vDebtWeth, borrowWeth, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, usdcOut));

        vm.prank(openUser);
        IERC20LikeS(USDC).approve(address(strat), marginUsdc);
        vm.prank(openUser);
        strat.openWithCollateralMargin(
            USDC, WETH, flashUsdc, borrowWeth, marginUsdc, flashUsdc, address(router), swapData, delegation
        );

        assertGe(IERC20LikeS(aUsdc).balanceOf(openUser), marginUsdc + usdcOut - 2, "aUSDC short");
        assertApproxEqAbs(IERC20LikeS(vDebtWeth).balanceOf(openUser), borrowWeth, 2, "WETH debt mismatch");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
    }

    /// @dev The collateral-margin entry also requires a non-zero borrow.
    function test_OpenCollateralMargin_RevertsWhen_ZeroBorrow() public {
        AaveV3Strategies.Sig memory z;
        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector);
        strat.openWithCollateralMargin(WETH, USDC, 1 ether, 0, 1e6, 1, address(router), hex"", z);
    }

    /// @dev Zero-margin ratchet through the collateral-margin entry: with no margin to join it,
    ///      the supply is the flash alone and the borrow's swap still has to repay it.
    function test_Mode1_ZeroMargin_LeverageRatchet() public {
        uint256 flashAmount = 1 ether;
        uint256 borrowAmount = 2_000e6;
        uint256 wethOut = 1.01 ether;
        deal(WETH, address(router), wethOut);

        uint256 aWethBefore = IERC20LikeS(aWeth).balanceOf(user);
        uint256 debtBefore = IERC20LikeS(vDebtUsdc).balanceOf(user);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation =
            _signDelegation(userPk, user, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, wethOut));

        vm.prank(user);
        strat.openWithCollateralMargin(
            WETH, USDC, flashAmount, borrowAmount, 0, flashAmount, address(router), swapData, delegation
        );

        assertGe(IERC20LikeS(aWeth).balanceOf(user) - aWethBefore, wethOut - 2, "aWETH short");
        assertApproxEqAbs(
            IERC20LikeS(vDebtUsdc).balanceOf(user) - debtBefore, borrowAmount, 2, "debt mismatch"
        );
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
    }

    /// @dev Standing-allowance close: zeroed Permit, but the revoke still runs unconditionally,
    ///      so the whole standing allowance — not just this close's slice — is cleared.
    function test_Close_StandingAllowance_NoPermit() public {
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 debtOut = debt + 10e6;
        deal(USDC, address(router), debtOut);

        vm.prank(user);
        IERC20LikeS(aWeth).approve(address(strat), 1.1 ether);

        AaveV3Strategies.Permit memory noPermit;
        // No permit runs this tx, so the revoke signs the CURRENT nonce, not nonce + 1.
        AaveV3Strategies.Sig memory revoke = _signRevoke(user, address(strat), block.timestamp + 1200, 0);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        strat.closePositionWithPermit(
            WETH, USDC, 1 ether, debt, debt, address(router), noPermit, revoke, swapData
        );

        assertEq(IERC20LikeS(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
        assertEq(IERC20LikeS(aWeth).allowance(user, address(strat)), 0, "allowance not revoked");
    }

    /// @dev A router cannot re-enter the close entry point mid-swap.
    function test_Close_RouterCannotReenter() public {
        MockRouterReenterS evil = new MockRouterReenterS();
        strat.setRouters(_one(address(evil)), true);

        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory permit = _signPermit(user, address(strat), 1 ether, deadline);
        AaveV3Strategies.Sig memory revoke = _signRevoke(user, address(strat), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterReenterS.swap, (address(strat), WETH, USDC));

        vm.prank(user);
        // The inner call reverts Reentrancy(); the router bubble makes the outer call revert too.
        vm.expectRevert();
        strat.closePositionWithPermit(WETH, USDC, 1 ether, debt, 1, address(evil), permit, revoke, swapData);
    }

    /*//////////////////////////////////////////////////////////////
              PoC — FINDING 1: _open `debtBorrowed -= repaid` underflow
    //////////////////////////////////////////////////////////////*/

    /// @dev Control: a ratchet open whose router consumes the WHOLE swap input leaves no
    ///      leftover, so the repay branch is skipped and the open succeeds. This is the baseline
    ///      the attack below diverges from — same call, the only difference is a donation.
    function test_PoC_Open_Control_NoDonation_Succeeds() public {
        MockRouterFixedPullS fixedRouter = new MockRouterFixedPullS();
        strat.setRouters(_one(address(fixedRouter)), true);

        uint256 supplyAmount = 0.1 ether; // flash-borrowed collateral
        uint256 borrowAmount = 200e6; // this tx's borrow
        uint256 wethOut = 0.101 ether; // covers the 0.1 flash + dust surplus
        deal(WETH, address(fixedRouter), wethOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation = _signDelegation(userPk, user, vDebtUsdc, borrowAmount, deadline);
        // Router pulls EXACTLY borrowAmount of USDC — so with no donation, leftover == 0.
        bytes memory swapData = abi.encodeCall(MockRouterFixedPullS.swap, (USDC, borrowAmount, WETH, wethOut));

        vm.prank(user);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, 0, supplyAmount, address(fixedRouter), swapData, delegation
        );

        // Sanity: leftover was 0, nothing stuck.
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
    }

    /// @dev Regression for Finding 1. `user` already carries ~1,000 USDC variable debt from setUp
    ///      (the "existing position" the leverage-ratchet path is documented for). An attacker
    ///      donates USDC straight to the contract; the router still consumes only `borrowAmount`,
    ///      so the donation survives as `leftover` and `POOL.repay` retires more than this tx's
    ///      `borrowAmount`. Pre-fix, `debtBorrowed -= repaid` underflowed and reverted the whole
    ///      open (Panic 0x11), a repeatable gas-only griefing DoS. Post-fix the subtraction
    ///      saturates to 0, so the open completes: the donation simply pays down the user's debt.
    function test_Open_RatchetWithDonation_DoesNotUnderflow() public {
        MockRouterFixedPullS fixedRouter = new MockRouterFixedPullS();
        strat.setRouters(_one(address(fixedRouter)), true);

        // Precondition (from setUp): user holds pre-existing USDC variable debt.
        uint256 preDebt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        assertGe(preDebt, 1_000e6, "precondition: user has pre-existing USDC debt");
        uint256 aWethBefore = IERC20LikeS(aWeth).balanceOf(user);

        // Attacker donates USDC directly to the contract — no function call, no guard.
        uint256 donation = 900e6;
        deal(USDC, address(strat), donation);

        uint256 supplyAmount = 0.1 ether;
        uint256 borrowAmount = 200e6; // donation (900) > borrowAmount (200): pre-fix this underflowed
        uint256 wethOut = 0.101 ether;
        deal(WETH, address(fixedRouter), wethOut);

        uint256 userUsdcBefore = IERC20LikeS(USDC).balanceOf(user);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation = _signDelegation(userPk, user, vDebtUsdc, borrowAmount, deadline);
        // Router consumes exactly borrowAmount USDC; the 900e6 donation is left as `leftover`.
        bytes memory swapData = abi.encodeCall(MockRouterFixedPullS.swap, (USDC, borrowAmount, WETH, wethOut));

        vm.prank(user);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, 0, supplyAmount, address(fixedRouter), swapData, delegation
        );

        // Open completed instead of reverting: exposure supplied.
        assertGe(IERC20LikeS(aWeth).balanceOf(user) - aWethBefore, wethOut - 2, "aWETH not supplied");
        // The donation is a stray, not this-tx money: it neither repays debt nor reaches the user.
        assertApproxEqAbs(IERC20LikeS(vDebtUsdc).balanceOf(user), preDebt + borrowAmount, 5, "debt mismatch");
        assertEq(IERC20LikeS(USDC).balanceOf(user), userUsdcBefore, "stray leaked to user");
        // The donation stays in the contract for the owner's rescueToken.
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), donation, "donation not kept for rescue");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
    }

    /*//////////////////////////////////////////////////////////////
              PoC — FINDING 2: _open absolute-balance (stray harvest)
    //////////////////////////////////////////////////////////////*/

    /// @dev Regression for Finding 2. 5 WETH is stranded in the contract (a mis-send awaiting the
    ///      owner's rescueToken). Pre-fix, `_open` read `received = collateral.balanceOf(this)`
    ///      (absolute), counted the stray 5 WETH as swap `surplus`, and supplied it into the
    ///      CALLER's Aave account — letting a dust-sized open harvest the strays and front-run
    ///      rescueToken. Post-fix `received` is a swap delta, so the dust open reverts (real swap
    ///      output < the flash it must repay) and the 5 WETH is left untouched.
    function test_Open_StrayCollateralNotHarvested() public {
        address mallory = vm.addr(0xBEEF);

        uint256 stray = 5 ether; // collateral sitting in the contract, awaiting rescueToken
        deal(WETH, address(strat), stray);

        uint256 supplyAmount = 0.001 ether; // dust flash
        uint256 borrowAmount = 1e6; // 1 USDC
        uint256 swapOut = 0.0005 ether; // real swap output — deliberately LESS than the flash
        deal(WETH, address(router), swapOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation = _signDelegation(0xBEEF, mallory, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, swapOut));

        vm.prank(mallory);
        // Post-fix: real output (swapOut) < flash (supplyAmount) → flash-repayment floor.
        vm.expectRevert(AaveV3Strategies.InsufficientOutputForFlashLoanRepayment.selector);
        strat.openWithDebtMargin(WETH, USDC, supplyAmount, borrowAmount, 0, 1, address(router), swapData, delegation);

        // The stray collateral is untouched — recoverable by the owner, not harvested by the caller.
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), stray, "stray WETH was harvested");
        assertEq(IERC20LikeS(aWeth).balanceOf(mallory), 0, "caller gained collateral");
    }

    /*//////////////////////////////////////////////////////////////
              PoC — FINDING 3: _close keeps strays (rescueToken recovers)
    //////////////////////////////////////////////////////////////*/

    /// @dev Regression for Finding 3. ~5 aWETH is stranded in the contract (anyone can supply on
    ///      its behalf via Aave). Pre-fix, `_close` withdrew `type(uint256).max` — the contract's
    ///      WHOLE aToken balance — so a routine close swept the stray 5 aWETH out to the caller.
    ///      Post-fix the close withdraws only the user's pulled collateral, so the stray aWETH
    ///      stays in the contract for the owner's rescueToken.
    function test_Close_StrayAtokensKeptInContract() public {
        // Strand ~5 aWETH in the contract via a permissionless supply on its behalf.
        address whale = vm.addr(0xCAFE);
        deal(WETH, whale, 5 ether);
        vm.startPrank(whale);
        IERC20LikeS(WETH).approve(POOL, 5 ether);
        IPoolFullS(POOL).supply(WETH, 5 ether, address(strat), 0);
        vm.stopPrank();
        uint256 strayA = IERC20LikeS(aWeth).balanceOf(address(strat));
        assertGe(strayA, 5 ether - 2, "stray setup failed");

        // `user` closes part of their real position (1 WETH of collateral).
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 repay = debt / 2;
        uint256 debtOut = repay + 10e6;
        deal(USDC, address(router), debtOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory permit = _signPermit(user, address(strat), 1 ether, deadline);
        AaveV3Strategies.Sig memory revoke = _signRevoke(user, address(strat), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        strat.closePositionWithPermit(WETH, USDC, 1 ether, repay, repay, address(router), permit, revoke, swapData);

        // The stray aTokens were NOT withdrawn/swept — they remain for rescueToken.
        assertApproxEqAbs(IERC20LikeS(aWeth).balanceOf(address(strat)), strayA, 3, "stray aWETH was swept out");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
    }

    /*//////////////////////////////////////////////////////////////
                        HARDENING — _preflight
    //////////////////////////////////////////////////////////////*/

    /// @dev The pause blocks every entry point, not just one.
    function test_Preflight_RevertsWhen_Paused() public {
        strat.setPause(true);
        AaveV3Strategies.Sig memory z;
        AaveV3Strategies.Permit memory p;

        vm.startPrank(user);
        vm.expectRevert(AaveV3Strategies.Paused.selector);
        strat.openWithDebtMargin(WETH, USDC, 1 ether, 1e6, 0, 1, address(router), hex"", z);

        vm.expectRevert(AaveV3Strategies.Paused.selector);
        strat.openWithCollateralMargin(WETH, USDC, 1 ether, 1e6, 0, 1, address(router), hex"", z);

        vm.expectRevert(AaveV3Strategies.Paused.selector);
        strat.closePositionWithPermit(WETH, USDC, 1 ether, 1e6, 1, address(router), p, z, hex"");
        vm.stopPrank();
    }

    /// @dev Unpausing restores the entry points — the guard is a toggle, not a latch.
    function test_Preflight_UnpauseRestoresEntryPoints() public {
        strat.setPause(true);
        strat.setPause(false);
        assertEq(strat.paused(), 0, "still paused");

        // Now reverts on the NEXT check (zero minOut), proving it passed the pause gate.
        AaveV3Strategies.Sig memory z;
        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector);
        strat.openWithDebtMargin(WETH, USDC, 1 ether, 1e6, 0, 0, address(router), hex"", z);
    }

    /// @dev A position cannot be opened against itself — same collateral and debt reserve.
    function test_Preflight_RevertsWhen_SameAsset() public {
        AaveV3Strategies.Sig memory z;
        AaveV3Strategies.Permit memory p;

        vm.startPrank(user);
        vm.expectRevert(AaveV3Strategies.SameAsset.selector);
        strat.openWithDebtMargin(WETH, WETH, 1 ether, 1e6, 0, 1, address(router), hex"", z);

        vm.expectRevert(AaveV3Strategies.SameAsset.selector);
        strat.openWithCollateralMargin(WETH, WETH, 1 ether, 1e6, 0, 1, address(router), hex"", z);

        vm.expectRevert(AaveV3Strategies.SameAsset.selector);
        strat.closePositionWithPermit(WETH, WETH, 1 ether, 1e6, 1, address(router), p, z, hex"");
        vm.stopPrank();
    }

    /// @dev Load-bearing: an un-allowlisted router receives an arbitrary call with caller-supplied
    ///      calldata, so this is the gate between a swap and an arbitrary-call primitive.
    function test_Preflight_RevertsWhen_RouterNotAllowed() public {
        address rogue = address(0xDEAD);
        AaveV3Strategies.Sig memory z;
        AaveV3Strategies.Permit memory p;

        vm.startPrank(user);
        vm.expectRevert(AaveV3Strategies.RouterNotAllowed.selector);
        strat.openWithDebtMargin(WETH, USDC, 1 ether, 1e6, 0, 1, rogue, hex"", z);

        vm.expectRevert(AaveV3Strategies.RouterNotAllowed.selector);
        strat.openWithCollateralMargin(WETH, USDC, 1 ether, 1e6, 0, 1, rogue, hex"", z);

        vm.expectRevert(AaveV3Strategies.RouterNotAllowed.selector);
        strat.closePositionWithPermit(WETH, USDC, 1 ether, 1e6, 1, rogue, p, z, hex"");
        vm.stopPrank();
    }

    /// @dev De-allowlisting takes effect immediately.
    function test_Preflight_RevertsWhen_RouterRemoved() public {
        strat.setRouters(_one(address(router)), false);
        assertFalse(strat.allowedRouters(address(router)), "still allowed");

        AaveV3Strategies.Sig memory z;
        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.RouterNotAllowed.selector);
        strat.openWithDebtMargin(WETH, USDC, 1 ether, 1e6, 0, 1, address(router), hex"", z);
    }

    /// @dev The open path has the same transient reentrancy guard as the close path.
    function test_Open_RouterCannotReenter() public {
        MockRouterReenterOpenS evil = new MockRouterReenterOpenS();
        strat.setRouters(_one(address(evil)), true);

        uint256 supplyAmount = 0.01 ether;
        uint256 borrowAmount = 1e6;
        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation = _signDelegation(userPk, user, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterReenterOpenS.swap, (address(strat), WETH, USDC));

        vm.prank(user);
        // LibCall bubbles the inner revert verbatim, so Reentrancy() surfaces on the outer call.
        vm.expectRevert(AaveV3Strategies.Reentrancy.selector);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, 0, 1, address(evil), swapData, delegation
        );
    }

    /*//////////////////////////////////////////////////////////////
                    HARDENING — amount validation
    //////////////////////////////////////////////////////////////*/

    /// @dev Every amount the open path validates, one revert each.
    function test_Open_RevertsWhen_ZeroAmounts() public {
        AaveV3Strategies.Sig memory z;
        vm.startPrank(user);

        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector); // zero supply
        strat.openWithDebtMargin(WETH, USDC, 0, 1e6, 1e6, 1, address(router), hex"", z);

        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector); // zero minOut
        strat.openWithDebtMargin(WETH, USDC, 1 ether, 1e6, 1e6, 0, address(router), hex"", z);

        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector); // zero flash
        strat.openWithCollateralMargin(WETH, USDC, 0, 1e6, 1e6, 1, address(router), hex"", z);

        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector); // zero minOut
        strat.openWithCollateralMargin(WETH, USDC, 1 ether, 1e6, 1e6, 0, address(router), hex"", z);

        vm.stopPrank();
    }

    /// @dev Every amount the close path validates, one revert each.
    function test_Close_RevertsWhen_ZeroAmounts() public {
        AaveV3Strategies.Permit memory p;
        AaveV3Strategies.Sig memory z;
        vm.startPrank(user);

        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector); // zero debtRepay
        strat.closePositionWithPermit(WETH, USDC, 1 ether, 0, 1, address(router), p, z, hex"");

        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector); // zero collateralToWithdraw
        strat.closePositionWithPermit(WETH, USDC, 0, 1e6, 1, address(router), p, z, hex"");

        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector); // zero minOut
        strat.closePositionWithPermit(WETH, USDC, 1 ether, 1e6, 0, address(router), p, z, hex"");

        vm.stopPrank();
    }

    /// @dev Closing a position that does not exist reverts before any flash loan is paid for.
    function test_Close_RevertsWhen_NoDebt() public {
        address stranger = vm.addr(0xD00D);
        AaveV3Strategies.Permit memory p;
        AaveV3Strategies.Sig memory z;

        vm.prank(stranger);
        vm.expectRevert(AaveV3Strategies.NoDebt.selector);
        strat.closePositionWithPermit(WETH, USDC, 1 ether, 1e6, 1, address(router), p, z, hex"");
    }

    /// @dev An asset Aave has never listed resolves to a zero debt-token address. Solady's
    ///      `balanceOf` returns 0 rather than reverting on a codeless target, so this lands on
    ///      NoDebt — a clean revert, not a confusing low-level one.
    function test_Close_RevertsWhen_UnlistedReserve() public {
        address unlisted = address(0xBADCA11);
        AaveV3Strategies.Permit memory p;
        AaveV3Strategies.Sig memory z;

        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.NoDebt.selector);
        strat.closePositionWithPermit(WETH, unlisted, 1 ether, 1e6, 1, address(router), p, z, hex"");
    }

    /*//////////////////////////////////////////////////////////////
                     HARDENING — callback guard
    //////////////////////////////////////////////////////////////*/

    /// @dev Only Morpho may deliver the callback.
    function test_Callback_RevertsWhen_NotMorpho() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert(AaveV3Strategies.NotMorpho.selector);
        strat.onMorphoFlashLoan(1 ether, hex"");
    }

    /// @dev Even Morpho cannot drive a leg that no entry point committed to. (Mutation-checked:
    ///      the rejection comes from the hash mismatch — the `iszero(expected)` half of the guard
    ///      is belt-and-braces, unreachable by test since it needs `keccak256(data) == 0`.)
    function test_Callback_RevertsWhen_NoPendingCommitment() public {
        vm.prank(MORPHO);
        vm.expectRevert(AaveV3Strategies.UnexpectedCallback.selector);
        strat.onMorphoFlashLoan(1 ether, hex"");
    }

    /// @dev A payload that does not hash to the commitment is rejected, even from Morpho.
    function test_Callback_RevertsWhen_PayloadMismatch() public {
        AaveV3Strategies.OpenParam memory forged = AaveV3Strategies.OpenParam({
            mode: 0,
            user: user,
            collateral: WETH,
            debtAsset: USDC,
            router: address(router),
            marginAmount: 0,
            borrowAmount: 1e6,
            minOut: 1,
            swapData: hex""
        });

        vm.prank(MORPHO);
        vm.expectRevert(AaveV3Strategies.UnexpectedCallback.selector);
        strat.onMorphoFlashLoan(1 ether, abi.encode(forged));
    }

    /*//////////////////////////////////////////////////////////////
                      HARDENING — slippage bounds
    //////////////////////////////////////////////////////////////*/

    /// @dev The user's own `minOut` binds even when the swap covers the flash loan.
    function test_Open_RevertsWhen_BelowMinOut() public {
        uint256 supplyAmount = 1 ether;
        uint256 borrowAmount = 2_000e6;
        uint256 wethOut = 1.01 ether; // covers the flash...
        uint256 minOut = 1.5 ether;   // ...but not what the user demanded
        deal(WETH, address(router), wethOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation = _signDelegation(userPk, user, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, wethOut));

        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.InsufficientOutputFromRouter.selector);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, 0, minOut, address(router), swapData, delegation
        );
    }

    /// @dev With a permissive `minOut`, the flash repayment is still a hard floor.
    function test_Open_RevertsWhen_CannotRepayFlash() public {
        uint256 supplyAmount = 1 ether;
        uint256 borrowAmount = 2_000e6;
        uint256 wethOut = 0.9 ether; // less than the flash
        deal(WETH, address(router), wethOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation = _signDelegation(userPk, user, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, wethOut));

        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.InsufficientOutputForFlashLoanRepayment.selector);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, 0, 1, address(router), swapData, delegation
        );
    }

    /// @dev Same two bounds on the close path: `minOut` first, then the flash floor.
    function test_Close_RevertsWhen_BelowMinOut() public {
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 repay = debt / 2;
        uint256 debtOut = repay + 10e6;
        deal(USDC, address(router), debtOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory permit = _signPermit(user, address(strat), 1 ether, deadline);
        AaveV3Strategies.Sig memory revoke = _signRevoke(user, address(strat), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.InsufficientOutputFromRouter.selector);
        strat.closePositionWithPermit(
            WETH, USDC, 1 ether, repay, debtOut + 1, address(router), permit, revoke, swapData
        );
    }

    /// @dev A close whose swap cannot repay the flash reverts on the floor, not on `minOut`.
    function test_Close_RevertsWhen_CannotRepayFlash() public {
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 repay = debt / 2;
        uint256 debtOut = repay - 1e6; // short of the flashed repay amount
        deal(USDC, address(router), debtOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory permit = _signPermit(user, address(strat), 1 ether, deadline);
        AaveV3Strategies.Sig memory revoke = _signRevoke(user, address(strat), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.InsufficientOutputForFlashLoanRepayment.selector);
        strat.closePositionWithPermit(
            WETH, USDC, 1 ether, repay, 1, address(router), permit, revoke, swapData
        );
    }

    /*//////////////////////////////////////////////////////////////
                   HARDENING — signatures & allowances
    //////////////////////////////////////////////////////////////*/

    /// @dev The delegation must be signed over EXACTLY `borrowAmount`; a signature over any other
    ///      value recovers a different signer and fails. This is what stops residual borrowing
    ///      power being left delegated to this contract.
    function test_Open_RevertsWhen_DelegationValueMismatch() public {
        uint256 borrowAmount = 2_000e6;
        uint256 deadline = block.timestamp + 1200;
        // Signed over borrowAmount + 1, submitted as borrowAmount.
        AaveV3Strategies.Sig memory delegation =
            _signDelegation(userPk, user, vDebtUsdc, borrowAmount + 1, deadline);

        vm.prank(user);
        vm.expectRevert(); // Aave's INVALID_SIGNATURE
        strat.openWithDebtMargin(
            WETH, USDC, 1 ether, borrowAmount, 0, 1, address(router), hex"", delegation
        );
    }

    /// @dev deadline == 0 is the standing-delegation path: the entry point skips
    ///      `delegationWithSig` and leans on an allowance the user granted earlier.
    function test_Open_StandingDelegation_ZeroDeadline() public {
        uint256 supplyAmount = 1 ether;
        uint256 borrowAmount = 2_000e6;
        uint256 wethOut = 1.01 ether;
        deal(WETH, address(router), wethOut);

        vm.prank(user);
        IDelegationS(vDebtUsdc).approveDelegation(address(strat), borrowAmount);

        uint256 aWethBefore = IERC20LikeS(aWeth).balanceOf(user);
        AaveV3Strategies.Sig memory noDelegation; // deadline 0
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, wethOut));

        vm.prank(user);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, 0, supplyAmount, address(router), swapData, noDelegation
        );

        assertGe(IERC20LikeS(aWeth).balanceOf(user) - aWethBefore, wethOut - 2, "aWETH not supplied");
        // The standing delegation was consumed in full by the borrow.
        assertEq(ITokenSigS(vDebtUsdc).borrowAllowance(user, address(strat)), 0, "residual delegation");
    }

    /// @dev Regression lock for the unconditional revoke: an all-zero `revokePermit` no longer
    ///      means "skip". The aToken rejects the zero deadline, so the close reverts outright.
    function test_Close_RevertsWhen_RevokeSigMissing() public {
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 debtOut = debt + 10e6;
        deal(USDC, address(router), debtOut);

        vm.prank(user);
        IERC20LikeS(aWeth).approve(address(strat), 1.1 ether);

        AaveV3Strategies.Permit memory noPermit;
        AaveV3Strategies.Sig memory noRevoke;
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        vm.expectRevert(AAVE_INVALID_EXPIRATION);
        strat.closePositionWithPermit(
            WETH, USDC, 1 ether, debt, debt, address(router), noPermit, noRevoke, swapData
        );
    }

    /// @dev A permit that has already expired cannot be replayed into a close.
    function test_Close_RevertsWhen_PermitExpired() public {
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory permit = _signPermit(user, address(strat), 1 ether, deadline);
        AaveV3Strategies.Sig memory revoke = _signRevoke(user, address(strat), deadline);

        vm.warp(deadline + 1);

        vm.prank(user);
        vm.expectRevert(AAVE_INVALID_EXPIRATION);
        strat.closePositionWithPermit(WETH, USDC, 1 ether, debt, 1, address(router), permit, revoke, hex"");
    }

    /*//////////////////////////////////////////////////////////////
                        HARDENING — admin surface
    //////////////////////////////////////////////////////////////*/

    /// @dev Only the owner controls the allowlist, the pause and the sweep.
    function test_Admin_RevertsWhen_NotOwner() public {
        vm.startPrank(user);

        vm.expectRevert(UNAUTHORIZED);
        strat.setRouters(_one(address(0x1234)), true);

        vm.expectRevert(UNAUTHORIZED);
        strat.setPause(true);

        vm.expectRevert(UNAUTHORIZED);
        strat.rescueToken(USDC, user);

        vm.stopPrank();
    }

    /// @dev A batch toggles every entry and the getters agree with `allowedRouters`.
    function test_SetRouters_BatchAndGetters() public {
        address[] memory batch = new address[](2);
        batch[0] = address(0xA1);
        batch[1] = address(0xA2);

        strat.setRouters(batch, true);
        assertTrue(strat.allowedRouters(batch[0]), "A1 not allowed");
        assertTrue(strat.allowedRouters(batch[1]), "A2 not allowed");
        assertEq(strat.getAllowedRouters().length, 3, "set size wrong"); // + the setUp router

        strat.setRouters(batch, false);
        assertFalse(strat.allowedRouters(batch[0]), "A1 still allowed");
        assertFalse(strat.allowedRouters(batch[1]), "A2 still allowed");
        assertEq(strat.getAllowedRouters().length, 1, "set not shrunk");
    }

    /// @dev One bad entry reverts the whole batch — no partial allowlisting.
    function test_SetRouters_RevertsWhen_BatchContainsZero() public {
        address[] memory batch = new address[](2);
        batch[0] = address(0xA1);
        batch[1] = address(0);

        vm.expectRevert(AaveV3Strategies.ZeroAddress.selector);
        strat.setRouters(batch, true);

        assertFalse(strat.allowedRouters(address(0xA1)), "partial write survived the revert");
    }

    /// @dev Re-adding an allowlisted router is idempotent; the set does not grow.
    function test_SetRouters_AddIsIdempotent() public {
        strat.setRouters(_one(address(router)), true);
        strat.setRouters(_one(address(router)), true);
        assertEq(strat.getAllowedRouters().length, 1, "duplicate entry");
    }

    /// @dev The sweep is the recovery path for the strays the delta accounting deliberately
    ///      leaves behind (see the Finding 1-3 regressions above).
    function test_RescueToken_SweepsStrays() public {
        address treasury = vm.addr(0xFEE);
        deal(USDC, address(strat), 1_234e6);

        strat.rescueToken(USDC, treasury);

        assertEq(IERC20LikeS(USDC).balanceOf(treasury), 1_234e6, "stray not swept");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "stray remains");
    }

    /// @dev Sweeping to the zero address would burn the strays.
    function test_RescueToken_RevertsWhen_ZeroRecipient() public {
        vm.expectRevert(AaveV3Strategies.ZeroAddress.selector);
        strat.rescueToken(USDC, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                          HARDENING — events
    //////////////////////////////////////////////////////////////*/

    /// @dev The open emits PositionOpened keyed to the caller and the asset pair.
    function test_Open_EmitsPositionOpened() public {
        uint256 supplyAmount = 1 ether;
        uint256 borrowAmount = 2_000e6;
        uint256 wethOut = 1.01 ether;
        deal(WETH, address(router), wethOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Sig memory delegation = _signDelegation(userPk, user, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (USDC, WETH, wethOut));

        // Topics checked exactly; the amount data carries live-fork rounding, so it is not.
        vm.expectEmit(true, true, true, false, address(strat));
        emit AaveV3Strategies.PositionOpened(user, WETH, USDC, 0, 0, 0);

        vm.prank(user);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, 0, supplyAmount, address(router), swapData, delegation
        );
    }

    /// @dev The close emits PositionClosed keyed to the caller and the asset pair.
    function test_Close_EmitsPositionClosed() public {
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 debtOut = debt + 10e6;
        deal(USDC, address(router), debtOut);

        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory permit = _signPermit(user, address(strat), 1.1 ether, deadline);
        AaveV3Strategies.Sig memory revoke = _signRevoke(user, address(strat), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, debtOut));

        vm.expectEmit(true, true, true, false, address(strat));
        emit AaveV3Strategies.PositionClosed(user, WETH, USDC, 0, 0, 0);

        vm.prank(user);
        strat.closePositionWithPermit(
            WETH, USDC, 1 ether, debt, debt, address(router), permit, revoke, swapData
        );
    }

    /// @dev The admin events carry the values the owner set.
    function test_Admin_EmitsEvents() public {
        vm.expectEmit(true, false, false, true, address(strat));
        emit AaveV3Strategies.RouterSet(address(0xA1), true);
        strat.setRouters(_one(address(0xA1)), true);

        vm.expectEmit(false, false, false, true, address(strat));
        emit AaveV3Strategies.PauseSet(true);
        strat.setPause(true);
    }

    function _one(address r) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = r;
    }

    function _signPermit(address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (AaveV3Strategies.Permit memory)
    {
        uint256 nonce = ITokenSigS(aWeth).nonces(owner);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ITokenSigS(aWeth).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return AaveV3Strategies.Permit({amount: value, deadline: deadline, r: r, s: s, v: v});
    }

    /// @dev The revoke rides one nonce behind the permit it clears, so callers that skip the
    ///      permit (standing allowance) must sign the current nonce instead — `nonceOffset` 0.
    function _signRevoke(address owner, address spender, uint256 deadline)
        internal
        view
        returns (AaveV3Strategies.Sig memory)
    {
        return _signRevoke(owner, spender, deadline, 1);
    }

    function _signRevoke(address owner, address spender, uint256 deadline, uint256 nonceOffset)
        internal
        view
        returns (AaveV3Strategies.Sig memory)
    {
        uint256 nonce = ITokenSigS(aWeth).nonces(owner) + nonceOffset;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, uint256(0), nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ITokenSigS(aWeth).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return AaveV3Strategies.Sig({deadline: deadline, r: r, s: s, v: v});
    }

    function _signDelegation(uint256 pk, address owner, address debtToken, uint256 value, uint256 deadline)
        internal
        view
        returns (AaveV3Strategies.Sig memory)
    {
        uint256 nonce = ITokenSigS(debtToken).nonces(owner);
        bytes32 structHash =
            keccak256(abi.encode(DELEGATION_WITH_SIG_TYPEHASH, address(strat), value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ITokenSigS(debtToken).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return AaveV3Strategies.Sig({deadline: deadline, r: r, s: s, v: v});
    }
}
