// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {AaveV3Deleverager} from "../src/AaveV3Deleverager.sol";

/// @title AaveV3Deleverager deployment script
/// @notice Deploys the AaveV3Deleverager contract.
///         The contract hardcodes Ethereum mainnet Morpho Blue / Aave V3 addresses,
///         so it is intended for Ethereum mainnet (or a mainnet fork).
///
/// Usage:
///   # dry run (simulation only)
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL
///
///   # broadcast with browser / hardware wallet / sender
///   forge script script/Deploy.s.sol \
///     --rpc-url $RPC_URL --sender $DEPLOYER --broadcast --browser --slow
///
/// Env vars:
///   OWNER - optional; contract owner. Defaults to tx.origin (the deployer address).
contract DeployAaveV3Deleverager is Script {
    function run() external returns (AaveV3Deleverager deleverager) {
        address owner = vm.envOr("OWNER", tx.origin);

        console2.log("Deployer / tx.origin:", tx.origin);
        console2.log("Owner:                ", owner);

        vm.startBroadcast();
        deleverager = new AaveV3Deleverager(owner);
        vm.stopBroadcast();

        console2.log("AaveV3Deleverager deployed at:", address(deleverager));
    }
}
