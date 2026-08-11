// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";

/// @dev The allowlist surface, which `AaveV3Deleverager` and `AaveV3Strategies` expose with
///      identical signatures. An interface rather than either concrete type on purpose: the
///      target is a Deleverager on Ethereum and a Strategies on Base and Arbitrum, and importing
///      one to call the other would document the wrong contract at every call site here.
interface IRouterAllowlist {
    function owner() external view returns (address);
    function setRouters(address[] calldata routers, bool allowed) external;
    function allowedRouters(address router) external view returns (bool);
    function getAllowedRouters() external view returns (address[] memory);
}

/// @dev KyberSwap `MetaAggregationRouterV2`. One address on every chain KyberSwap supports —
///      Ethereum, Base and Arbitrum included, per
///      https://docs.kyberswap.com/developer-guide/aggregator-api/contracts — which is why this
///      is a single constant rather than a per-chain registry. It is still checked for code on
///      the connected chain before anything is signed, so a chain KyberSwap has not reached
///      fails loudly instead of allowlisting an empty address.
///
///      Reviewed against the three properties the close flow depends on:
///        - it pulls `srcToken` via `transferFrom` as ITSELF (`_transferFromOrApproveTarget`
///          → `TransferHelper.safeTransferFrom(srcToken, msg.sender, …)`), so the approve
///          target equals the call target, matching approve-then-call and `validateSwapTx`;
///        - `_collectExtraETHIfNeeded` requires `msg.value == 0` for an ERC20 `srcToken`,
///          which is all `LibCall.callContract` can send;
///        - `desc.dstReceiver` is honoured, so output lands on the calling contract.
///      Note it does NOT provide a usable output floor of its own: under `_PARTIAL_FILL`,
///      `_checkReturnAmount` is pro-rata, so absolute output can fall below
///      `desc.minReturnAmount`. The contract's own `minOut` (the full debt) and its
///      `afterBalance < assets` check are what actually bound this — do not relax them.
address constant KYBERSWAP_ROUTER_V2 = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;

/// @dev `AaveV3Deleverager` on Ethereum mainnet.
address constant DELEVERAGER_ETHEREUM = 0x834796774Eb472E571B5c21Da438069225C2B162;

/// @dev `AaveV3Strategies` on Base and Arbitrum. The same address on both because it is
///      deployed through CreateX/CREATE3 from one salt — see DeployStrategies.s.sol. Adding a
///      chain there means adding its id to {_defaultTarget} here and nothing else.
address constant STRATEGIES_CREATE3 = 0x75B1AB12e47AaEe4E1033100dE1992E735c32C9c;

/// @title Swap-router allowlist setup
/// @notice Allowlists (or revokes) swap routers on an already-deployed AaveV3Deleverager or
///         AaveV3Strategies. Until at least one router is allowlisted every cross-asset close
///         reverts with `RouterNotAllowed()`, and the frontend refuses to even quote one —
///         `buildPlan` reads `getAllowedRouters()` up front and bails on an empty set.
///
/// SECURITY: `setRouters` grants an address the right to receive an arbitrary call carrying
///           caller-supplied calldata from the contract, while holding an approval over the
///           collateral just withdrawn. Only audited aggregator ENTRY POINTS belong here —
///           never a token, an aToken, the Aave Pool, or Morpho itself. Only KyberSwap's
///           router is built in, and only because its source was read against those
///           requirements (see KYBERSWAP_ROUTER_V2 above). Every other entry has to be passed
///           explicitly, as a deliberate, verified choice.
///
///           The authoritative address for a given chain is whatever the aggregator's own
///           API returns as the transaction `to` — which is exactly what the frontend
///           adapters read (`Adapter.buildTransaction`), and what `validateSwapTx` checks
///           the allowlist against. Take the value from a real quote on the target chain,
///           cross-check it against the aggregator's published docs, then set it here.
///
///           The aggregator the frontend can route through is `COMPATIBLE_ADAPTERS` in
///           src/lib/deleverage.ts: KyberSwap. Anything else is rejected before quoting
///           (separate approval proxy, off-chain intent, or a Permit2 signature a contract
///           cannot produce), so allowlisting it achieves nothing.
///
/// Usage:
///   # dry run (simulation only) — always do this first and read the logged allowlist
///   forge script script/RouterSetup.s.sol --rpc-url $RPC_URL
///
///   # broadcast, signed by the owner
///   forge script script/RouterSetup.s.sol --rpc-url $RPC_URL --sender $OWNER --broadcast --slow
///
///   # a target this script does not know about, or a second instance
///   TARGET=0x… forge script script/RouterSetup.s.sol --rpc-url $RPC_URL --sender $OWNER --broadcast
///
///   # override the default set
///   ROUTERS=0xaaa…,0xbbb… \
///     forge script script/RouterSetup.s.sol --rpc-url $RPC_URL --sender $OWNER --broadcast
///
///   # revoke instead of allow
///   ALLOWED=false ROUTERS=0xaaa… \
///     forge script script/RouterSetup.s.sol --rpc-url $RPC_URL --sender $OWNER --broadcast
///
/// Env vars:
///   TARGET  - optional; the deployed contract to configure. Defaults to the known deployment
///             for the connected chain (see {_defaultTarget}); required on any other chain.
///   ROUTERS - optional; comma-separated router addresses. Defaults to KyberSwap's router,
///             which is the same address on all three supported chains.
///   ALLOWED - optional; true to allowlist (default), false to revoke.
contract RouterSetup is Script {
    function run() external {
        IRouterAllowlist target = IRouterAllowlist(vm.envOr("TARGET", _defaultTarget()));
        bool allowed = vm.envOr("ALLOWED", true);

        address[] memory defaultRouters = new address[](1);
        defaultRouters[0] = KYBERSWAP_ROUTER_V2;
        address[] memory routers = vm.envOr("ROUTERS", ",", defaultRouters);
        require(routers.length != 0, "ROUTERS is empty");

        console2.log("Chain id:   ", block.chainid);
        console2.log("Target:     ", address(target));
        require(address(target) != address(0), "TARGET is required on this chain");
        require(address(target).code.length != 0, "TARGET has no code on this chain");

        // `setRouters` is onlyOwner, so a mismatched sender burns a broadcast and reverts
        // inside the call. Fail here, before anything is signed, with the reason visible.
        address owner = target.owner();
        console2.log("Owner:      ", owner);
        console2.log("Sender:     ", tx.origin);
        require(owner == tx.origin, "sender is not the owner");

        // Only the entries that actually change state. `setRouters` is idempotent — the
        // allowlist is an EnumerableSet — so re-running against a configured chain would
        // otherwise sign a transaction that emits events and changes nothing. Ethereum is
        // already set up; Base and Arbitrum were deployed with an empty allowlist.
        uint256 pendingCount;
        address[] memory pending = new address[](routers.length);
        for (uint256 i; i < routers.length; ++i) {
            address router = routers[i];
            // setRouters reverts with ZeroAddress() anyway; checking here names the entry.
            require(router != address(0), "ROUTERS contains the zero address");
            // A router address carried over from the wrong chain is the failure mode this
            // script is most exposed to now that it runs on three of them. An EOA-shaped
            // entry would be allowlisted silently and only surface as a failed close.
            // Revocation is exempt: a router worth removing may be exactly one that no longer
            // has code, and refusing to remove it would be the wrong way round.
            require(!allowed || router.code.length != 0, "router has no code on this chain");

            if (target.allowedRouters(router) == allowed) {
                console2.log(allowed ? "  already allowed:" : "  already revoked:", router);
                continue;
            }
            console2.log(allowed ? "  allow:" : "  revoke:", router);
            pending[pendingCount++] = router;
        }

        if (pendingCount == 0) {
            console2.log("Allowlist already matches the requested state. Nothing to broadcast.");
            _logAllowlist(target);
            return;
        }

        assembly ("memory-safe") {
            mstore(pending, pendingCount)
        }

        // One transaction for the whole set, so the allowlist can never land half applied —
        // a partial allowlist has the frontend ranking routes across aggregators whose
        // fallback has silently nowhere to go.
        vm.startBroadcast();
        target.setRouters(pending, allowed);
        vm.stopBroadcast();

        _logAllowlist(target);
    }

    /// @dev The deployment this script configures on the connected chain.
    ///
    ///      A hardcoded registry rather than a required env var, for the same reason
    ///      DeployStrategies.s.sol keeps one: these are owner-only writes granting arbitrary-call
    ///      rights, and a mistyped address in a shell would either revert on the owner check or,
    ///      worse, configure something that is not ours. An unlisted chain returns the zero
    ///      address, and `run` then demands TARGET explicitly.
    function _defaultTarget() internal view returns (address) {
        if (block.chainid == 1) return DELEVERAGER_ETHEREUM;
        if (block.chainid == 8453 || block.chainid == 42161) return STRATEGIES_CREATE3;
        return address(0);
    }

    /// @dev Echo the resulting set — this is the same read the frontend performs, so what prints
    ///      here is exactly what the close flow will filter routes against.
    function _logAllowlist(IRouterAllowlist target) internal view {
        address[] memory current = target.getAllowedRouters();
        console2.log("Allowlist now holds", current.length, "router(s):");
        for (uint256 i; i < current.length; ++i) {
            console2.log("  -", current[i]);
        }
    }
}
