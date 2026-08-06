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
        AaveV3Strategies.RevokePermit memory rp;
        AaveV3Strategies(strategies).closePositionWithPermit(
            collateral, debtAsset, 1, 1, 1, address(this), p, rp, hex""
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

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));

        user = vm.addr(userPk);
        strat = new AaveV3Strategies(address(this));
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
        AaveV3Strategies.RevokePermit memory revoke = _signRevoke(user, address(strat), deadline);
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
        AaveV3Strategies.RevokePermit memory revoke = _signRevoke(user, address(strat), deadline);
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
        AaveV3Strategies.Permit memory delegation =
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
        AaveV3Strategies.Permit memory delegation =
            _signDelegation(0xB0B, openUser, vDebtUsdc, borrowAmount, deadline);
        bytes memory swapData = abi.encodeCall(MockRouterFixedPullS.swap, (USDC, pulled, WETH, supplyAmount));

        vm.prank(openUser);
        IERC20LikeS(USDC).approve(address(strat), margin);
        vm.prank(openUser);
        strat.openWithDebtMargin(
            WETH, USDC, supplyAmount, borrowAmount, margin, supplyAmount, address(fixedRouter), swapData, delegation
        );

        // 50 USDC leftover repaid the debt: 2,000 borrowed - 50 = 1,950 remaining.
        assertApproxEqAbs(IERC20LikeS(vDebtUsdc).balanceOf(openUser), borrowAmount - 50e6, 2, "leftover not repaid");
        assertEq(IERC20LikeS(USDC).balanceOf(address(strat)), 0, "USDC stuck");
        assertEq(IERC20LikeS(WETH).balanceOf(address(strat)), 0, "WETH stuck");
    }

    /// @dev Margin is mandatory: zero margin trips ZeroAmount at entry.
    function test_Open_RevertsWhen_ZeroMargin() public {
        AaveV3Strategies.Permit memory z;
        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector);
        strat.openWithDebtMargin(WETH, USDC, 1 ether, 1e6, 0, 1, address(router), hex"", z);
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
        AaveV3Strategies.Permit memory delegation =
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
        AaveV3Strategies.Permit memory delegation =
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
        AaveV3Strategies.Permit memory delegation =
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

    /// @dev The collateral-margin entry also requires non-zero margin.
    function test_OpenCollateralMargin_RevertsWhen_ZeroMargin() public {
        AaveV3Strategies.Permit memory z;
        vm.prank(user);
        vm.expectRevert(AaveV3Strategies.ZeroAmount.selector);
        strat.openWithCollateralMargin(WETH, USDC, 1 ether, 1e6, 0, 1, address(router), hex"", z);
    }

    /// @dev Standing-allowance close: zeroed Permit AND zeroed RevokePermit — the callback must
    ///      NOT attempt a zero-sig revoke (it would revert INVALID_SIGNATURE and brick the path).
    function test_Close_StandingAllowance_NoPermit() public {
        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 debtOut = debt + 10e6;
        deal(USDC, address(router), debtOut);

        vm.prank(user);
        IERC20LikeS(aWeth).approve(address(strat), 1.1 ether);

        AaveV3Strategies.Permit memory noPermit;
        AaveV3Strategies.RevokePermit memory noRevoke;
        bytes memory swapData = abi.encodeCall(MockRouterS.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        strat.closePositionWithPermit(
            WETH, USDC, 1 ether, debt, debt, address(router), noPermit, noRevoke, swapData
        );

        assertEq(IERC20LikeS(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
        assertApproxEqAbs(IERC20LikeS(aWeth).allowance(user, address(strat)), 0.1 ether, 2, "allowance wrong");
    }

    /// @dev A router cannot re-enter the close entry point mid-swap.
    function test_Close_RouterCannotReenter() public {
        MockRouterReenterS evil = new MockRouterReenterS();
        strat.setRouters(_one(address(evil)), true);

        uint256 debt = IERC20LikeS(vDebtUsdc).balanceOf(user);
        uint256 deadline = block.timestamp + 1200;
        AaveV3Strategies.Permit memory permit = _signPermit(user, address(strat), 1 ether, deadline);
        AaveV3Strategies.RevokePermit memory revoke = _signRevoke(user, address(strat), deadline);
        bytes memory swapData = abi.encodeCall(MockRouterReenterS.swap, (address(strat), WETH, USDC));

        vm.prank(user);
        // The inner call reverts Reentrancy(); the router bubble makes the outer call revert too.
        vm.expectRevert();
        strat.closePositionWithPermit(WETH, USDC, 1 ether, debt, 1, address(evil), permit, revoke, swapData);
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

    function _signRevoke(address owner, address spender, uint256 deadline)
        internal
        view
        returns (AaveV3Strategies.RevokePermit memory)
    {
        uint256 nonce = ITokenSigS(aWeth).nonces(owner) + 1;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, uint256(0), nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ITokenSigS(aWeth).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return AaveV3Strategies.RevokePermit({deadline: deadline, r: r, s: s, v: v});
    }

    function _signDelegation(uint256 pk, address owner, address debtToken, uint256 value, uint256 deadline)
        internal
        view
        returns (AaveV3Strategies.Permit memory)
    {
        uint256 nonce = ITokenSigS(debtToken).nonces(owner);
        bytes32 structHash =
            keccak256(abi.encode(DELEGATION_WITH_SIG_TYPEHASH, address(strat), value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ITokenSigS(debtToken).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return AaveV3Strategies.Permit({amount: value, deadline: deadline, r: r, s: s, v: v});
    }
}
