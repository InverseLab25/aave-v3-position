// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Test} from "forge-std/Test.sol";
import {AaveV3Leverage} from "../src/AaveV3Leverage.sol";

/// @dev Mirrors the exact encode/decode pair used by `AaveV3Leverage`: entry points
/// `abi.encode(mode, Params)` into memory, Morpho hands it back as calldata, and the callback
/// reads the mode word plus a calldata pointer to the struct. This harness reproduces that
/// round trip so the layout assumption is tested without a fork.
contract PayloadHarness {
    uint256 private constant _MODE_OPEN = 0;
    uint256 private constant _MODE_CLOSE = 1;

    function encodeOpen(AaveV3Leverage.OpenParams memory p) external pure returns (bytes memory) {
        return abi.encode(_MODE_OPEN, p);
    }

    function encodeClose(AaveV3Leverage.CloseParams memory p) external pure returns (bytes memory) {
        return abi.encode(_MODE_CLOSE, p);
    }

    /// @dev Byte-identical to the callback's dispatch assembly.
    function split(bytes calldata data) private pure returns (uint256 mode, uint256 params) {
        assembly ("memory-safe") {
            mode := calldataload(data.offset)
            params := add(data.offset, calldataload(add(data.offset, 0x20)))
        }
    }

    function decodeOpen(bytes calldata data) external pure returns (uint256, AaveV3Leverage.OpenParams calldata) {
        (uint256 mode, uint256 params) = split(data);
        AaveV3Leverage.OpenParams calldata p;
        assembly ("memory-safe") {
            p := params
        }
        return (mode, p);
    }

    function decodeClose(bytes calldata data) external pure returns (uint256, AaveV3Leverage.CloseParams calldata) {
        (uint256 mode, uint256 params) = split(data);
        AaveV3Leverage.CloseParams calldata p;
        assembly ("memory-safe") {
            p := params
        }
        return (mode, p);
    }
}

contract AaveV3LeveragePayloadTest is Test {
    PayloadHarness harness = new PayloadHarness();

    function testFuzz_openPayloadRoundTrips(
        address user,
        address collateral,
        address debtAsset,
        uint256 margin,
        uint256 minCollateralOut,
        address router,
        bytes calldata swapData
    ) public view {
        AaveV3Leverage.OpenParams memory p = AaveV3Leverage.OpenParams({
            user: user,
            collateral: collateral,
            debtAsset: debtAsset,
            margin: margin,
            minCollateralOut: minCollateralOut,
            router: router,
            swapData: swapData
        });

        (uint256 mode, AaveV3Leverage.OpenParams memory d) = harness.decodeOpen(harness.encodeOpen(p));

        assertEq(mode, 0, "mode");
        assertEq(d.user, user, "user");
        assertEq(d.collateral, collateral, "collateral");
        assertEq(d.debtAsset, debtAsset, "debtAsset");
        assertEq(d.margin, margin, "margin");
        assertEq(d.minCollateralOut, minCollateralOut, "minCollateralOut");
        assertEq(d.router, router, "router");
        assertEq(d.swapData, swapData, "swapData");
    }

    function testFuzz_closePayloadRoundTrips(
        address user,
        address collateral,
        address debtAsset,
        uint256 collateralToWithdraw,
        uint256 minOut,
        address router,
        AaveV3Leverage.Permit memory permit,
        AaveV3Leverage.RevokePermit memory revokePermit,
        bytes calldata swapData
    ) public view {
        AaveV3Leverage.CloseParams memory p = AaveV3Leverage.CloseParams({
            user: user,
            collateral: collateral,
            debtAsset: debtAsset,
            collateralToWithdraw: collateralToWithdraw,
            minOut: minOut,
            router: router,
            permit: permit,
            revokePermit: revokePermit,
            swapData: swapData
        });

        (uint256 mode, AaveV3Leverage.CloseParams memory d) = harness.decodeClose(harness.encodeClose(p));

        assertEq(mode, 1, "mode");
        assertEq(d.user, user, "user");
        assertEq(d.collateral, collateral, "collateral");
        assertEq(d.debtAsset, debtAsset, "debtAsset");
        assertEq(d.collateralToWithdraw, collateralToWithdraw, "collateralToWithdraw");
        assertEq(d.minOut, minOut, "minOut");
        assertEq(d.router, router, "router");
        assertEq(d.permit.value, permit.value, "permit.value");
        assertEq(d.permit.deadline, permit.deadline, "permit.deadline");
        assertEq(d.permit.v, permit.v, "permit.v");
        assertEq(d.permit.r, permit.r, "permit.r");
        assertEq(d.permit.s, permit.s, "permit.s");
        assertEq(d.revokePermit.deadline, revokePermit.deadline, "revokePermit.deadline");
        assertEq(d.revokePermit.v, revokePermit.v, "revokePermit.v");
        assertEq(d.revokePermit.r, revokePermit.r, "revokePermit.r");
        assertEq(d.revokePermit.s, revokePermit.s, "revokePermit.s");
        assertEq(d.swapData, swapData, "swapData");
    }
}
