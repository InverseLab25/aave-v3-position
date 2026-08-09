// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {AaveV3Strategies} from "../src/AaveV3Strategies.sol";

/// @title AaveV3Strategies deterministic deployment
/// @notice Deploys AaveV3Strategies through the canonical CREATE2 factory so the address is
///         identical on every chain it is deployed to.
///
/// @dev CREATE2 gives the same address only when three things match across chains:
///        1. the factory      — 0x4e59b448… below, present on most chains
///        2. the salt         — SALT env var, must be reused verbatim
///        3. the init code    — creation bytecode ++ abi.encode(owner)
///
///      Point 3 is the one that bites: `owner` is a constructor argument, so a different
///      owner produces a different address. Deploy every chain with the SAME owner, or the
///      whole exercise is pointless. The script refuses to guess it for that reason.
///
///      IMPORTANT — this contract is NOT chain-portable as written. It hardcodes Ethereum
///      mainnet's Aave V3 Pool and Morpho Blue as `constant`s, and those live at different
///      addresses on other chains. Deploying this bytecode elsewhere yields a contract at the
///      right address that calls the wrong ones. `_assertDependenciesLive` below catches that
///      before broadcast rather than leaving a user to discover it in a reverting transaction.
///
/// Usage:
///   # 1. predict the address without spending anything, on any chain
///   SALT=0x...  OWNER=0x... forge script script/DeployStrategies.s.sol:DeployStrategies \
///     --sig "predict()" --rpc-url $RPC_URL
///
///   # 2. dry run against a real chain (runs the dependency guard)
///   SALT=0x...  OWNER=0x... forge script script/DeployStrategies.s.sol --rpc-url $RPC_URL
///
///   # 3. broadcast
///   SALT=0x...  OWNER=0x... forge script script/DeployStrategies.s.sol \
///     --rpc-url $RPC_URL --sender $DEPLOYER --broadcast --slow --verify
///
/// Env vars:
///   SALT  - required. 32-byte hex. Reuse the SAME value on every chain.
///   OWNER - required. Contract owner. Reuse the SAME value on every chain; it is part of
///           the init code, so changing it changes the deployed address.
contract DeployStrategies is Script {
    /// @dev Arachnid's deterministic deployment proxy — Foundry's default CREATE2 factory.
    ///      Same address on every chain that has it; `predict()` refuses to guess without it.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev Mirrors the `constant`s inside AaveV3Strategies. Kept here so the guard can check
    ///      them without the contract exposing them — if either constant changes in the
    ///      contract, this deploy script must change with it or the guard silently checks the
    ///      wrong addresses.
    address internal constant EXPECTED_MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant EXPECTED_AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    function run() external returns (AaveV3Strategies strategies) {
        (bytes32 salt, address owner) = _config();
        bytes memory initCode = _initCode(owner);
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);

        _logPlan(salt, owner, predicted);
        _assertFactoryLive();
        _assertDependenciesLive();

        if (predicted.code.length != 0) {
            console2.log("Already deployed at this address on this chain. Nothing to do.");
            return AaveV3Strategies(predicted);
        }

        vm.startBroadcast();
        strategies = new AaveV3Strategies{salt: salt}(owner);
        vm.stopBroadcast();

        // A mismatch means the factory in use is not the one the prediction assumed, which
        // would silently break the same-address-everywhere guarantee on the NEXT chain.
        require(address(strategies) == predicted, "CREATE2 address mismatch: wrong factory?");

        console2.log("Deployed AaveV3Strategies at:", address(strategies));
        console2.log("Reuse the same SALT and OWNER on every other chain to match this address.");
    }

    /// @notice Prints the address this SALT + OWNER pair will produce, without deploying.
    /// @dev Pure address arithmetic — no chain state is read, so this is valid even against a
    ///      chain where the factory is absent. Use it to confirm two chains agree before
    ///      spending gas on either.
    function predict() external view returns (address predicted) {
        (bytes32 salt, address owner) = _config();
        predicted = vm.computeCreate2Address(salt, keccak256(_initCode(owner)), CREATE2_DEPLOYER);

        console2.log("Salt:     ");
        console2.logBytes32(salt);
        console2.log("Owner:    ", owner);
        console2.log("Predicted:", predicted);
    }

    /// @dev Both values are required rather than defaulted. `tx.origin` would differ between a
    ///      hardware wallet and a hot key, and an accidentally-different owner produces a
    ///      different address on that chain with no error — the exact failure this script exists
    ///      to prevent.
    function _config() internal view returns (bytes32 salt, address owner) {
        salt = vm.envBytes32("SALT");
        owner = vm.envAddress("OWNER");
        require(owner != address(0), "OWNER must not be the zero address");
    }

    function _initCode(address owner) internal pure returns (bytes memory) {
        return abi.encodePacked(type(AaveV3Strategies).creationCode, abi.encode(owner));
    }

    function _logPlan(bytes32 salt, address owner, address predicted) internal view {
        console2.log("Chain id: ", block.chainid);
        console2.log("Owner:    ", owner);
        console2.log("Predicted:", predicted);
        console2.log("Salt:     ");
        console2.logBytes32(salt);
    }

    function _assertFactoryLive() internal view {
        require(
            CREATE2_DEPLOYER.code.length != 0,
            "CREATE2 factory absent on this chain - deploy Arachnid's proxy first, or the address will not match"
        );
    }

    /// @dev The chain-portability guard.
    ///
    ///      AaveV3Strategies hardcodes mainnet's Morpho Blue and Aave V3 Pool. On any other
    ///      chain those addresses hold no code (or, worse, unrelated code), so every open and
    ///      close would revert. Failing here costs one simulation; failing in production costs
    ///      a user's gas and trust.
    function _assertDependenciesLive() internal view {
        require(
            EXPECTED_MORPHO.code.length != 0,
            "Morpho Blue absent at the hardcoded address on this chain - AaveV3Strategies cannot work here"
        );
        require(
            EXPECTED_AAVE_POOL.code.length != 0,
            "Aave V3 Pool absent at the hardcoded address on this chain - AaveV3Strategies cannot work here"
        );
    }
}
