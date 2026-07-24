// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {AaveV3Deleverager} from "../src/AaveV3Deleverager.sol";

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

/// @notice Stand-in for a live aggregator. Pulls the exact collateral the deleverager approved
///         (allowance == the amount it wants swapped) and hands back a fixed debt-asset amount.
///         Lets the fork test exercise the real flash-loan / repay / permit / withdraw path
///         without depending on off-chain, block-specific aggregator calldata.
contract MockRouter {
    function swap(address collateral, address debtAsset, uint256 debtOut) external {
        uint256 amountIn = IERC20Like(collateral).allowance(msg.sender, address(this));
        IERC20Like(collateral).transferFrom(msg.sender, address(this), amountIn);
        IERC20Like(debtAsset).transfer(msg.sender, debtOut);
    }
}

/// @notice Mock router that pulls a FIXED `amountIn` (less than the approved allowance),
///         mirroring a real aggregator that swaps only `requiredIn` and leaves the cushion
///         behind for the deleverager to sweep back to the user.
contract MockRouterFixedPull {
    function swap(address collateral, uint256 amountIn, address debtAsset, uint256 debtOut) external {
        IERC20Like(collateral).transferFrom(msg.sender, address(this), amountIn);
        IERC20Like(debtAsset).transfer(msg.sender, debtOut);
    }
}

/*//////////////////////////////////////////////////////////////
                            FORK TEST
////////////////////////////////////////////////--------------*/

contract AaveV3DeleveragerForkTest is Test {
    // Mainnet addresses (match the constants hardcoded in AaveV3Deleverager).
    address constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant DATA_PROVIDER = 0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2; // collateral
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // debt

    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    // Pin a block that has both Aave V3 and Morpho Blue live (override with FORK_BLOCK).
    uint256 constant DEFAULT_FORK_BLOCK = 20_800_000;

    AaveV3Deleverager deleverager;
    MockRouter router;

    uint256 userPk = 0xA11CE;
    address user;
    address aWeth;
    address vDebtUsdc;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("mainnet"), vm.envOr("FORK_BLOCK", DEFAULT_FORK_BLOCK));

        user = vm.addr(userPk);
        deleverager = new AaveV3Deleverager(address(this));
        router = new MockRouter();

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
    ///      pre-fix contract did (msg.sender = deleverager, onBehalfOf = user), which reverted
    ///      with NoExplicitAmountToRepayOnBehalf().
    function test_Aave_RejectsMaxRepayOnBehalf() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        assertGt(debt, 0, "no debt set up");

        // This contract stands in for "some caller != user" (like the deleverager).
        deal(USDC, address(this), debt);
        IERC20Like(USDC).approve(POOL, debt);

        vm.expectRevert(); // NoExplicitAmountToRepayOnBehalf()
        IPoolFull(POOL).repay(USDC, type(uint256).max, 2, user);
    }

    /// @dev End-to-end: the fixed contract closes the position in one tx with a real aToken permit,
    ///      real Morpho flash loan, real Aave repay/withdraw, and a mocked swap.
    function test_ClosePositionWithPermit_ClosesDebtAndReturnsExcess() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        assertGt(debt, 0, "no debt set up");

        // Mock router returns debt + 50 USDC so output clears the flash loan with margin.
        uint256 debtOut = debt + 50e6;
        deal(USDC, address(router), debtOut);

        uint256 collAmount = IERC20Like(aWeth).balanceOf(user);
        assertGt(collAmount, 0, "no collateral");

        // Build the EIP-2612 permit on the aWETH token (spender = deleverager).
        uint256 permitValue = collAmount + collAmount / 100; // 1% rebase buffer, mirrors the frontend
        uint256 deadline = block.timestamp + 1200;
        AaveV3Deleverager.Permit memory permit =
            _signPermit(user, address(deleverager), permitValue, deadline);

        // Swap calldata for the mock router: collateral -> debt asset.
        bytes memory swapData = abi.encodeCall(MockRouter.swap, (WETH, USDC, debtOut));

        uint256 userUsdcBefore = IERC20Like(USDC).balanceOf(user);

        // minOut floor = the debt itself (what the frontend passes). Sentinel = drain all.
        vm.prank(user);
        deleverager.closePositionWithPermit(WETH, USDC, type(uint256).max, debt, address(router), swapData, permit);

        // Debt fully repaid.
        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
        // Collateral fully withdrawn (aToken burned).
        assertLt(IERC20Like(aWeth).balanceOf(user), 1e12, "collateral aToken dust remains");
        // Excess debt asset (debtOut - flashLoan) returned to the user.
        assertEq(IERC20Like(USDC).balanceOf(user) - userUsdcBefore, debtOut - debt, "excess not returned");
        // No funds stuck in the deleverager.
        assertEq(IERC20Like(USDC).balanceOf(address(deleverager)), 0, "USDC stuck in contract");
        assertEq(IERC20Like(WETH).balanceOf(address(deleverager)), 0, "WETH stuck in contract");
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
        AaveV3Deleverager.Permit memory permit =
            _signPermit(user, address(deleverager), collateralToWithdraw, deadline);

        bytes memory swapData = abi.encodeCall(MockRouter.swap, (WETH, USDC, debtOut));

        vm.prank(user);
        deleverager.closePositionWithPermit(WETH, USDC, collateralToWithdraw, debt, address(router), swapData, permit);

        // Full debt repaid.
        assertEq(IERC20Like(vDebtUsdc).balanceOf(user), 0, "debt not cleared");
        // The remainder is still supplied in Aave (~9 WETH aToken).
        assertApproxEqAbs(
            IERC20Like(aWeth).balanceOf(user), collBefore - collateralToWithdraw, 1e12, "remainder not left supplied"
        );
        // Nothing stuck in the deleverager.
        assertEq(IERC20Like(USDC).balanceOf(address(deleverager)), 0, "USDC stuck in contract");
        assertLt(IERC20Like(WETH).balanceOf(address(deleverager)), 1e12, "WETH stuck in contract");
    }

    /// @dev Real partial path: the router consumes only part of the approved collateral
    ///      (requiredIn), and the leftover cushion must be swept to the user's wallet — not
    ///      stranded in the contract. Also proves collateralAmount >= the router's pull.
    function test_ClosePositionWithPermit_PartialWithdraw_SweepsCushionToWallet() public {
        uint256 debt = IERC20Like(vDebtUsdc).balanceOf(user);
        assertGt(debt, 0, "no debt set up");

        uint256 debtOut = debt + 50e6;
        MockRouterFixedPull fixedRouter = new MockRouterFixedPull();
        deal(USDC, address(fixedRouter), debtOut);

        uint256 collBefore = IERC20Like(aWeth).balanceOf(user);
        uint256 userWethBefore = IERC20Like(WETH).balanceOf(user);

        uint256 collateralToWithdraw = 1 ether;      // contract withdraws + approves ~1 WETH
        uint256 routerPull = 0.999 ether;            // router consumes less; cushion = 0.001 WETH left
        uint256 deadline = block.timestamp + 1200;
        AaveV3Deleverager.Permit memory permit =
            _signPermit(user, address(deleverager), collateralToWithdraw, deadline);

        bytes memory swapData = abi.encodeCall(MockRouterFixedPull.swap, (WETH, routerPull, USDC, debtOut));

        vm.prank(user);
        deleverager.closePositionWithPermit(
            WETH, USDC, collateralToWithdraw, debt, address(fixedRouter), swapData, permit
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
        // Nothing stuck in the deleverager.
        assertEq(IERC20Like(WETH).balanceOf(address(deleverager)), 0, "WETH stuck in contract");
        assertEq(IERC20Like(USDC).balanceOf(address(deleverager)), 0, "USDC stuck in contract");
    }

    function _signPermit(address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (AaveV3Deleverager.Permit memory)
    {
        uint256 nonce = IAToken(aWeth).nonces(owner);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IAToken(aWeth).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return AaveV3Deleverager.Permit({value: value, deadline: deadline, v: v, r: r, s: s});
    }
}
