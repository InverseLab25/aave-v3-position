// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

// Solady, install with: forge install vectorized/solady
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LibCall} from "solady/utils/LibCall.sol";
import {EnumerableSetLib} from "solady/utils/EnumerableSetLib.sol";

/*//////////////////////////////////////////////////////////////
                        MORPHO BLUE
//////////////////////////////////////////////////////////////*/

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/*//////////////////////////////////////////////////////////////
                          AAVE V3
//////////////////////////////////////////////////////////////*/

interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IERC20 {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IATokenPermit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

interface ICreditDelegationToken {
    function delegationWithSig(
        address delegator,
        address delegatee,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/*//////////////////////////////////////////////////////////////
                         STRATEGIES
//////////////////////////////////////////////////////////////*/

/// @dev Direction-neutral leveraged Aave V3 positions in one transaction each, financed by a
/// zero-fee Morpho Blue flash loan. Rewrite of AaveV3Leverage with a leaner encoding: the
/// mode word lives inside the params struct (one payload word smaller), the max-collateral
/// sentinel is resolved at entry, and the Pool's reserve-token getters go through a raw
/// staticcall helper.
contract AaveV3Strategies is Ownable {
    using SafeTransferLib for address;
    using LibCall for address;
    using EnumerableSetLib for EnumerableSetLib.AddressSet;

    struct Permit {
        uint256 amount;
        uint256 deadline;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    struct RevokePermit {
        uint256 deadline;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    /// @dev `mode` is the FIRST field of both param structs, so the callback reads it straight
    /// off the struct pointer and dispatches without a separate encoded word.
    struct OpenParam {
        uint256 mode;
        address user;
        address collateral;
        address debtAsset;
        address router;
        uint256 margin;
        uint256 minCollateralOut;
        bytes swapData;
    }

    struct CloseParam {
        uint256 mode;
        address user;
        address collateral;
        address debtAsset;
        address router;
        uint256 collateralToWithdraw;
        uint256 minOut;
        RevokePermit revokePermit;
        bytes swapData;
    }

    error Reentrancy();
    error ExpectedState();
    error NotMorpho();
    error UnexpectedCallback();
    error Paused();
    error SameAsset();
    error ZeroAmount();
    error ZeroAddress();
    error NoDebt();
    error RouterNotAllowed();
    error InsufficientOutput(uint256 have, uint256 need);

    event PositionOpened(
        address indexed user,
        address indexed collateral,
        address indexed debtAsset,
        uint256 margin,
        uint256 collateralSupplied,
        uint256 debtBorrowed
    );
    event PositionClosed(
        address indexed user,
        address indexed collateral,
        address indexed debtAsset,
        uint256 debtRepaid,
        uint256 collateralWithdrawn,
        uint256 returnedToUser
    );
    event RouterSet(address indexed router, bool allowed);
    event PauseSet(bool paused);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    uint256 private constant VARIABLE_RATE = 2;
    uint16 private constant REFERRAL_NONE = 0;

    uint256 private constant MODE_OPEN = 0;
    uint256 private constant MODE_CLOSE = 1;

    // Hardcoded to Ethereum mainnet: Morpho Blue, Aave V3 Pool.
    IMorpho private constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    IPool private constant POOL = IPool(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2);
    // Address twin of POOL for inline assembly, which cannot reference contract-type constants.
    address private constant POOL_ADDR = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    // `getReserveAToken(address)` / `getReserveVariableDebtToken(address)`, right-aligned.
    uint256 private constant GET_RESERVE_ATOKEN_SEL = 0xcff027d9;
    uint256 private constant GET_RESERVE_VDEBT_SEL = 0x365090a0;

    uint256 public paused;

    /// @dev Swap routers the owner has approved. Only audited aggregator entry points belong
    /// here — they receive an arbitrary call with caller-supplied calldata.
    EnumerableSetLib.AddressSet private _allowedRouters;

    /// @dev keccak256 of the flash-loan payload encoded at entry, verified in the callback and
    /// cleared when the leg completes; doubles as the reentrancy guard. Transient.
    bytes32 private transient _pendingDataHash;

    constructor(address owner_) {
        _initializeOwner(owner_);
    }

    /*//////////////////////////////////////////////////////////////
                            ENTRY POINTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Opens a leveraged position. `marginAmount` of `collateral` (non-zero, pulled via a
    /// prior approval) plus `flashAmount` of `debtAsset` flash borrowed and swapped are supplied
    /// for the caller, who ends up owing exactly `flashAmount`. `delegation` must delegate at
    /// least `flashAmount` of borrowing power on the variable debt token of `debtAsset`.
    function openPosition(
        address collateral,
        address debtAsset,
        uint256 marginAmount,
        uint256 flashAmount,
        uint256 minCollateralOut,
        address router,
        bytes calldata swapData,
        Permit calldata delegation
    ) external {
        _preflight(collateral, debtAsset, router);
        if (flashAmount == 0 || minCollateralOut == 0 || marginAmount == 0) revert ZeroAmount();

        collateral.safeTransferFrom(msg.sender, address(this), marginAmount);

        if (delegation.amount != 0) {
            ICreditDelegationToken(_reserveToken(GET_RESERVE_VDEBT_SEL, debtAsset)).delegationWithSig(
                msg.sender,
                address(this),
                delegation.amount,
                delegation.deadline,
                delegation.v,
                delegation.r,
                delegation.s
            );
        }

        _flash(
            debtAsset,
            flashAmount,
            abi.encode(
                OpenParam({
                    mode: MODE_OPEN,
                    user: msg.sender, // bound to the caller — the callback can never act for anyone else
                    collateral: collateral,
                    debtAsset: debtAsset,
                    router: router,
                    margin: marginAmount,
                    minCollateralOut: minCollateralOut,
                    swapData: swapData
                })
            )
        );
    }

    /// @dev Closes the caller's position. `debtRepay` may be max to repay the entire variable
    /// debt; anything smaller is a partial close, bounded by Aave's health-factor validation in
    /// the aToken's `finalizeTransfer` hook when the collateral is pulled. `collateralToWithdraw`
    /// may be max to drain — resolved to the live balance here at entry, so the callback only
    /// ever sees a concrete amount.
    function closePositionWithPermit(
        address collateral,
        address debtAsset,
        uint256 collateralToWithdraw,
        uint256 debtRepay,
        uint256 minOut,
        address router,
        Permit calldata permit,
        RevokePermit calldata revokePermit,
        bytes calldata swapData
    ) external {
        _preflight(collateral, debtAsset, router);

        
        if (debtRepay == 0 || collateralToWithdraw == 0 || minOut == 0) revert ZeroAmount();

        // An unlisted reserve yields address(0) here, whose `balanceOf` reads as 0 and trips NoDebt.
        uint256 debt = _reserveToken(GET_RESERVE_VDEBT_SEL, debtAsset).balanceOf(msg.sender);
        if (debt == 0) revert NoDebt();

        // Partial close: flash only what the caller wants repaid, never more than the live debt.
        if (debtRepay < debt) debt = debtRepay;

        address aToken = _reserveToken(GET_RESERVE_ATOKEN_SEL, collateral);

        if (collateralToWithdraw == type(uint256).max) {
            collateralToWithdraw = aToken.balanceOf(msg.sender);
            if (collateralToWithdraw == 0) revert ZeroAmount();
        }

        // Consume the permit up front: a bad or front-run signature reverts before the flash
        // loan and repay are paid for. `amount` 0 relies on a standing allowance instead, and
        // must ship with `revokePermit.deadline` 0 (nothing granted, nothing to clear).
        if (permit.amount != 0) {
            IATokenPermit(aToken).permit(
                msg.sender, address(this), permit.amount, permit.deadline, permit.v, permit.r, permit.s
            );
        }

        _flash(
            debtAsset,
            debt,
            abi.encode(
                CloseParam({
                    mode: MODE_CLOSE,
                    user: msg.sender, // bound to the caller — the callback can never act for anyone else
                    collateral: collateral,
                    debtAsset: debtAsset,
                    router: router,
                    collateralToWithdraw: collateralToWithdraw,
                    minOut: minOut,
                    revokePermit: revokePermit,
                    swapData: swapData
                })
            )
        );
    }

    /*//////////////////////////////////////////////////////////////
                    MORPHO FLASH LOAN CALLBACK
    //////////////////////////////////////////////////////////////*/

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(MORPHO)) revert NotMorpho();
        bytes32 expected = _pendingDataHash;

        // `data` is byte-for-byte the payload this contract abi.encode'd at entry: an offset
        // word, then the params struct whose first field is the mode.
        uint256 mode;
        uint256 params;
        assembly ("memory-safe") {
            // Copy calldata into memory and validate the keccak256 hash. Doesn't update the
            // free memory pointer, saving the memory expansion cost.
            calldatacopy(mload(0x40), data.offset, data.length)

            if or(xor(keccak256(mload(0x40), data.length), expected), iszero(expected)) {
                mstore(0x00, 0xdab1e993) // `UnexpectedCallback()`.
                revert(0x1c, 0x04)
            }

            params := add(data.offset, calldataload(data.offset))
            mode := calldataload(params)
        }

        if (mode == MODE_OPEN) _open(assets, params);
        else _close(assets, params);

        _pendingDataHash = bytes32(0);
    }

    /*//////////////////////////////////////////////////////////////
                        FLASH LOAN LEGS
    //////////////////////////////////////////////////////////////*/

    function _open(uint256 assets, uint256 params) private {
        OpenParam calldata p;
        assembly ("memory-safe") {
            p := params
        }

        address user = p.user;
        address collateral = p.collateral;
        address debtAsset = p.debtAsset;

        // 1. Swap the flash-borrowed debt asset into collateral.
        uint256 beforeBalance = collateral.balanceOf(address(this));
        _swap(debtAsset, p.router, assets, p.swapData);
        uint256 afterBalance = collateral.balanceOf(address(this));

        uint256 received = afterBalance - beforeBalance;
        uint256 minOut = p.minCollateralOut;
        if (received < minOut) revert InsufficientOutput(received, minOut);

        // 2. Supply everything we hold — margin plus swap output — straight to the user's account.
        _approveMax(collateral, address(POOL), afterBalance);
        POOL.supply(collateral, afterBalance, user, REFERRAL_NONE);

        // 3. Borrow exactly the flash amount on the user's credit; Aave's health-factor check
        //    runs inside borrow(), so an over-levered request reverts the whole transaction.
        POOL.borrow(debtAsset, assets, VARIABLE_RATE, REFERRAL_NONE, user);

        // 4. Let Morpho pull the repayment, then return whatever the router left unspent.
        _approveMax(debtAsset, address(MORPHO), assets);

        uint256 leftover = debtAsset.balanceOf(address(this)) - assets;
        if (leftover != 0) debtAsset.safeTransfer(user, leftover);

        emit PositionOpened(user, collateral, debtAsset, p.margin, afterBalance, assets);
    }

    function _close(uint256 assets, uint256 params) private {
        CloseParam calldata p;
        assembly ("memory-safe") {
            p := params
        }

        address user = p.user;
        address collateral = p.collateral;
        address debtAsset = p.debtAsset;
        address aToken = _reserveToken(GET_RESERVE_ATOKEN_SEL, collateral);

        // 1. Repay Aave debt to unlock the collateral.
        _approveMax(debtAsset, address(POOL), assets);
        uint256 debtRepaid = POOL.repay(debtAsset, assets, VARIABLE_RATE, user);

        // 2. Pull the aTokens to swap — the amount was resolved and the permit consumed at
        //    entry. Aave's finalizeTransfer hook enforces the post-repay health factor here.
        aToken.safeTransferFrom(user, address(this), p.collateralToWithdraw);

        // deadline == 0 marks "no permit was granted" (standing allowance), nothing to clear.
        if (p.revokePermit.deadline != 0) {
            IATokenPermit(aToken).permit(
                user, address(this), 0, p.revokePermit.deadline, p.revokePermit.v, p.revokePermit.r, p.revokePermit.s
            );
        }

        uint256 collateralAmount = POOL.withdraw(collateral, type(uint256).max, address(this));

        // 3. Swap the collateral back into the debt asset.
        uint256 beforeBalance = debtAsset.balanceOf(address(this));
        _swap(collateral, p.router, collateralAmount, p.swapData);
        uint256 afterBalance = debtAsset.balanceOf(address(this));

        // 4. Enforce the user's slippage bound, then ensure the flash loan is fully covered.
        uint256 swapOutput = afterBalance - beforeBalance;
        uint256 minOut = p.minOut;
        if (swapOutput < minOut) revert InsufficientOutput(swapOutput, minOut);
        if (afterBalance < assets) revert InsufficientOutput(afterBalance, assets);

        // 5. Let Morpho pull the repayment; return the excess and any unswapped collateral,
        //    leaving this contract with zero balances.
        _approveMax(debtAsset, address(MORPHO), assets);

        uint256 returned = afterBalance - assets;
        if (returned != 0) debtAsset.safeTransfer(user, returned);

        uint256 collateralLeft = collateral.balanceOf(address(this));
        if (collateralLeft != 0) collateral.safeTransfer(user, collateralLeft);

        emit PositionClosed(user, collateral, debtAsset, debtRepaid, collateralAmount, returned);
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Shared entry-point checks; reading `_pendingDataHash` is the reentrancy guard,
    /// held for the whole callback including the router call.
    function _preflight(address collateral, address debtAsset, address router) private view {
        if (_pendingDataHash != bytes32(0)) revert Reentrancy();
        if (paused != 0) revert Paused();
        if (collateral == debtAsset) revert SameAsset();
        // Load-bearing: `router` receives an arbitrary call with caller-supplied calldata.
        if (!_allowedRouters.contains(router)) revert RouterNotAllowed();
    }

    /// @dev Commits to `data`, flash borrows, and confirms the callback ran to completion.
    function _flash(address token, uint256 assets, bytes memory data) private {
        _pendingDataHash = keccak256(data);
        MORPHO.flashLoan(token, assets, data);
        if (_pendingDataHash != bytes32(0)) revert ExpectedState();
    }

    /// @dev Swaps through an allowlisted router; exact-amount approval, revoked immediately.
    function _swap(address tokenIn, address router, uint256 amountIn, bytes calldata swapData) private {
        tokenIn.safeApproveWithRetry(router, amountIn);
        router.callContract(swapData);
        tokenIn.safeApproveWithRetry(router, 0);
    }

    /// @dev Standing max allowance for the two trusted, hardcoded spenders (Morpho, Pool) —
    /// never a router. An allowance read is far cheaper than an SSTORE per call.
    function _approveMax(address token, address spender, uint256 amount) private {
        if (IERC20(token).allowance(address(this), spender) < amount) {
            token.safeApproveWithRetry(spender, type(uint256).max);
        }
    }

    /// @dev Raw staticcall to a Pool reserve-token getter; `sel` is the 4-byte selector,
    /// right-aligned. Uses scratch space only. A revert bubbles up; a short or dirty
    /// (non-address) return reverts empty.
    function _reserveToken(uint256 sel, address asset) private view returns (address result) {
        assembly ("memory-safe") {
            mstore(0x00, sel)
            mstore(0x20, asset)
            // calldata = selector (4 bytes at 0x1c) ++ asset (32 bytes at 0x20).
            if iszero(staticcall(gas(), POOL_ADDR, 0x1c, 0x24, 0x00, 0x20)) {
                returndatacopy(0x00, 0x00, returndatasize())
                revert(0x00, returndatasize())
            }
            result := mload(0x00)
            if or(lt(returndatasize(), 0x20), shr(160, result)) { revert(0x00, 0x00) }
        }
    }

    /*//////////////////////////////////////////////////////////////
                              ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @dev Allows or disallows several routers at once; one bad entry reverts the whole batch.
    function setRouters(address[] calldata routers, bool allowed) external onlyOwner {
        for (uint256 i; i < routers.length; ++i) {
            address router = routers[i];
            if (router == address(0)) revert ZeroAddress();
            if (allowed) _allowedRouters.add(router);
            else _allowedRouters.remove(router);
            emit RouterSet(router, allowed);
        }
    }

    /// @dev Returns whether `router` may be passed to the entry points.
    function allowedRouters(address router) external view returns (bool) {
        return _allowedRouters.contains(router);
    }

    /// @dev Returns every allowlisted router.
    function getAllowedRouters() external view returns (address[] memory) {
        return _allowedRouters.values();
    }

    function setPause(bool c) external onlyOwner {
        paused = c ? 1 : 0;
        emit PauseSet(c);
    }

    /// @dev Sweeps tokens accidentally sent here; the contract holds no user funds at rest.
    function rescueToken(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit TokenRescued(token, to, token.safeTransferAll(to));
    }
}
