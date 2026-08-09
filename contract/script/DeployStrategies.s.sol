// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {CREATE3} from "solady/utils/CREATE3.sol";
import {AaveV3Strategies} from "../src/AaveV3Strategies.sol";

interface ICreateX {
    function deployCreate3(bytes32 salt, bytes memory initCode)
        external
        payable
        returns (address newContract);
}

/// @title AaveV3Strategies deterministic deployment via CreateX (CREATE3)
/// @notice Deploys AaveV3Strategies to the same address on every chain.
///
/// @dev Why CREATE3 rather than CREATE2. A CREATE2 address is derived from the init code, and
///      init code includes constructor arguments — so a contract that needs chain-specific
///      addresses lands somewhere different on every chain. CREATE3 derives the address from
///      the deployer and salt alone: it CREATE2s a fixed minimal proxy, then lets that proxy
///      CREATE the target. Bytecode and constructor arguments are free to differ per chain
///      while the address stays put.
///
///      CreateX is used rather than a bespoke factory: it is already deployed at the same
///      address on ~100 chains, so there is no factory to bootstrap and no extra trusted
///      contract of our own.
///
/// @dev THE SALT ENCODING IS LOAD-BEARING. CreateX reads structure out of the salt:
///
///        bytes  0..19  address field  — set to the deployer for permissioned deploy
///                                       protection, so nobody else can occupy this address
///                                       on a chain you have not reached yet
///        byte     20   redeploy flag  — MUST be 0x00. Setting it to 0x01 makes CreateX mix
///                                       block.chainid into the guarded salt, which produces
///                                       a DIFFERENT address on every chain: the exact
///                                       opposite of the goal here, and silent
///        bytes 21..31  entropy        — free
///
///      `buildSalt` composes a correct salt; `_assertSaltIsCrossChainStable` refuses an
///      incorrect one rather than letting a mis-set byte 20 be discovered on chain two.
///
/// @dev Chain support is the registry in `_chainConfig` and nothing else. AaveV3Strategies
///      takes Morpho Blue and the Aave V3 Pool as constructor arguments, so adding a chain is
///      one entry there — the address stays fixed because CREATE3 ignores init code. An
///      unlisted chain reverts rather than deploying something mis-wired.
///
///      Supported today: Ethereum (1) and Base (8453) — the two chains where Morpho Blue and
///      Aave V3 both exist and this has been tested. Note Morpho shares one address across
///      those two but differs on nearly every other chain, so do not extrapolate it.
///
/// Usage:
///   # compose a valid salt (offline)
///   DEPLOYER=0x… ENTROPY=42 forge script script/DeployStrategies.s.sol:DeployStrategies \
///     --sig "buildSalt()"
///
///   # predict the address (offline — no RPC, valid for every chain)
///   SALT=0x… OWNER=0x… forge script script/DeployStrategies.s.sol:DeployStrategies \
///     --sig "predict()"
///
///   # deploy
///   SALT=0x… OWNER=0x… forge script script/DeployStrategies.s.sol \
///     --rpc-url $RPC_URL --sender $DEPLOYER --broadcast --slow --verify
///
/// Env vars:
///   SALT  - required. Must encode the deployer in bytes 0..19 and 0x00 in byte 20.
///   OWNER - required. Contract owner. Unlike CREATE2 this does NOT affect the address, so it
///           may legitimately differ per chain — but you almost certainly want it identical.
contract DeployStrategies is Script {
    /// @dev CreateX, at the same address on ~100 chains. https://github.com/pcaversaccio/createx
    address internal constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;

    /// @dev Morpho Blue. Ethereum and Base happen to share this address; almost no other chain
    ///      does, which is why it is resolved per chain rather than assumed.
    address internal constant MORPHO_ETHEREUM = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant MORPHO_BASE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    /// @dev The Aave V3 Pool, which differs on every chain.
    address internal constant AAVE_POOL_ETHEREUM = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant AAVE_POOL_BASE = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;

    function run() external returns (address strategies) {
        (bytes32 salt, address owner) = _config();
        address deployer = msg.sender;

        _assertSaltIsCrossChainStable(salt, deployer);
        address predicted = _predict(salt, deployer);

        console2.log("Chain id: ", block.chainid);
        console2.log("Deployer: ", deployer);
        console2.log("Owner:    ", owner);
        console2.log("Predicted:", predicted);

        require(CREATEX.code.length != 0, "CreateX not deployed on this chain");

        (address morpho, address pool) = _chainConfig();
        _assertDependenciesLive(morpho, pool);
        console2.log("Morpho:   ", morpho);
        console2.log("AavePool: ", pool);

        if (predicted.code.length != 0) {
            console2.log("Already deployed at this address on this chain. Nothing to do.");
            return predicted;
        }

        // The init code deliberately differs per chain — the constructor arguments carry the
        // chain's addresses. Under CREATE2 that would move the address; under CREATE3 it does
        // not, which is the entire reason this script uses CreateX.
        bytes memory initCode = abi.encodePacked(
            type(AaveV3Strategies).creationCode, abi.encode(owner, morpho, pool)
        );

        vm.startBroadcast();
        strategies = ICreateX(CREATEX).deployCreate3(salt, initCode);
        vm.stopBroadcast();

        // A mismatch means the guarded-salt derivation assumed here diverged from CreateX's —
        // which would silently break the same-address guarantee on the NEXT chain, when it is
        // far more expensive to discover.
        require(strategies == predicted, "address mismatch: guarded-salt derivation diverged");

        console2.log("Deployed AaveV3Strategies at:", strategies);
        console2.log("Reuse this SALT from this DEPLOYER on every chain to match.");
    }

    /// @notice The address this salt produces, computed offline. No RPC, no chain state.
    /// @dev Uses Solady's CREATE3, whose proxy init code is byte-identical to CreateX's
    ///      (0x67363d3d37363d34f03d5260086018f3), so the two derive the same address.
    ///      Verified against the vendored library rather than assumed.
    function predict() external view returns (address predicted) {
        (bytes32 salt,) = _config();
        address deployer = vm.envAddress("DEPLOYER");

        _assertSaltIsCrossChainStable(salt, deployer);
        predicted = _predict(salt, deployer);

        console2.log("Deployer: ", deployer);
        console2.log("Predicted:", predicted);
        console2.log("This address is identical on every chain CreateX reaches.");
    }

    /// @notice Composes a salt that is permissioned to `DEPLOYER` and chain-stable.
    /// @dev Hand-writing the salt is the likeliest way to get byte 20 wrong, so this exists to
    ///      make the correct encoding the easy one.
    function buildSalt() external view returns (bytes32 salt) {
        address deployer = vm.envAddress("DEPLOYER");
        uint88 entropy = uint88(vm.envUint("ENTROPY"));

        // Address in the top 20 bytes; entropy in the low 11. Byte 20 is left untouched and so
        // stays 0x00 — which is what keeps block.chainid out of the guarded salt.
        salt = bytes32((uint256(uint160(deployer)) << 96) | uint256(entropy));

        _assertSaltIsCrossChainStable(salt, deployer);
        console2.log("Salt (reuse verbatim on every chain):");
        console2.logBytes32(salt);
    }

    function _config() internal view returns (bytes32 salt, address owner) {
        salt = vm.envBytes32("SALT");
        owner = vm.envOr("OWNER", address(0));
        require(owner != address(0) || msg.sig == this.predict.selector, "OWNER required");
    }

    /// @dev Reproduces CreateX's `_guard` for the (sender-matches, no-redeploy-protection)
    ///      case: `keccak256(abi.encode(msg.sender, salt))`, with no block.chainid.
    function _predict(bytes32 salt, address deployer) internal pure returns (address) {
        bytes32 guarded = keccak256(abi.encode(deployer, salt));
        return CREATE3.predictDeterministicAddress(guarded, CREATEX);
    }

    /// @dev The guard that makes this script worth having.
    ///
    ///      CreateX silently switches derivation modes on the salt's shape. Byte 20 set to
    ///      0x01 mixes in block.chainid and yields a different address per chain — with no
    ///      error, and no way to notice until the second chain lands somewhere unexpected.
    function _assertSaltIsCrossChainStable(bytes32 salt, address deployer) internal pure {
        require(
            address(uint160(uint256(salt >> 96))) == deployer,
            "salt bytes 0..19 must equal the deployer (permissioned deploy protection)"
        );
        require(
            uint8(uint256(salt >> 88)) == 0x00,
            "salt byte 20 must be 0x00 - 0x01 mixes in block.chainid and breaks the shared address"
        );
    }

    /// @dev The chain's Morpho Blue and Aave V3 Pool.
    ///
    ///      A hardcoded registry rather than env vars on purpose. These two addresses are
    ///      security-critical — `morpho` becomes the sole permitted caller of the flash-loan
    ///      callback — and a typo in an env var would deploy a contract that either bricks or
    ///      trusts the wrong party, at an address the front-end already believes in. An
    ///      unlisted chain fails loudly instead of guessing.
    ///
    ///      Adding a chain means adding its pair here, and nothing else.
    function _chainConfig() internal view returns (address morpho, address pool) {
        if (block.chainid == 1) return (MORPHO_ETHEREUM, AAVE_POOL_ETHEREUM);
        if (block.chainid == 8453) return (MORPHO_BASE, AAVE_POOL_BASE);
        revert(
            "unsupported chain - add its Morpho Blue and Aave V3 Pool to _chainConfig before deploying"
        );
    }

    /// @dev Both addresses must actually hold code on this chain. Catches a stale registry
    ///      entry, a fork pointed at the wrong network, or a chain where Aave has since
    ///      migrated — a simulation failure here costs nothing, the same mistake in production
    ///      costs a user's gas and lands broken code at a known address.
    function _assertDependenciesLive(address morpho, address pool) internal view {
        require(morpho.code.length != 0, "Morpho Blue has no code at the configured address on this chain");
        require(pool.code.length != 0, "Aave V3 Pool has no code at the configured address on this chain");
    }
}
