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
        uint256 borrowAmount;
        uint256 minOut;
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

    /// @dev Opens a leveraged position with EXACT exposure: flash-borrows `supplyAmount` of
    /// `collateral` and supplies it straight to the caller's account, borrows `borrowAmount` of
    /// `debtAsset` on the caller's credit (Aave's LTV validation bounds it), then swaps the
    /// borrow plus the caller's `marginAmount` of `debtAsset` back into `collateral` to repay
    /// the flash loan. Margin is in the DEBT asset, so a stable-holding user opens a long with
    /// no pre-swap. Leftovers fold back into the position: surplus collateral is supplied,
    /// leftover debt asset repays the fresh debt. The swap output must cover both `minOut` and
    /// `supplyAmount`; `delegation.amount` must cover `borrowAmount`.
    function openPosition(
        address collateral,
        address debtAsset,
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 marginAmount,
        uint256 minOut,
        address router,
        bytes calldata swapData,
        Permit calldata delegation
    ) external {
        _preflight(collateral, debtAsset, router);
        if (supplyAmount == 0 || borrowAmount == 0 || marginAmount == 0 || minOut == 0) revert ZeroAmount();

        // Margin arrives in the debt asset and joins the borrowed funds in the callback's swap.
        debtAsset.safeTransferFrom(msg.sender, address(this), marginAmount);

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
            collateral,
            supplyAmount,
            abi.encode(
                OpenParam({
                    mode: MODE_OPEN,
                    user: msg.sender, // bound to the caller — the callback can never act for anyone else
                    collateral: collateral,
                    debtAsset: debtAsset,
                    router: router,
                    margin: marginAmount,
                    borrowAmount: borrowAmount,
                    minOut: minOut,
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
        }

        // Consume the permit up front: a bad or front-run signature reverts before the flash
        // loan and repay are paid for. `amount` 0 relies on a standing allowance instead, and
        // must ship with `revokePermit.deadline` 0 (nothing granted, nothing to clear).
        if (permit.amount != 0) {
            _permit(aToken, permit.amount, permit.deadline, permit.v, permit.r, permit.s);
        }

        _flash(
            debtAsset,
            debt,
            abi.encode(
                CloseParam({
                    mode: MODE_CLOSE,
                    user: msg.sender, 
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

        // 1. Supply the flash-borrowed collateral straight to the user's account — the exact
        //    exposure they asked for.
        collateral.safeApproveWithRetry(address(POOL), assets);
        POOL.supply(collateral, assets, user, REFERRAL_NONE);

        // 2. Borrow on the user's credit against the collateral supplied above. Aave's
        //    LTV/health-factor validation runs inside borrow(), so an over-levered request
        //    reverts the whole transaction.
        POOL.borrow(debtAsset, p.borrowAmount, VARIABLE_RATE, REFERRAL_NONE, user);

        // 3. Swap everything we hold in the debt asset — the borrow plus the user's margin —
        //    back into collateral to repay the flash loan.
        uint256 swapIn = debtAsset.balanceOf(address(this));
        _swap(debtAsset, p.router, swapIn, p.swapData);

        uint256 received = collateral.balanceOf(address(this));
        uint256 minOut = p.minOut;
        if (received < minOut) revert InsufficientOutput(received, minOut);
        // The flash repayment is the hard floor under any user-chosen minOut.
        if (received < assets) revert InsufficientOutput(received, assets);

        // 4. Let Morpho pull the repayment.
        collateral.safeApproveWithRetry(address(MORPHO), assets);

        // 5. Fold leftovers back into the position rather than dusting the wallet: surplus
        //    collateral is supplied, leftover debt asset repays the fresh debt on the user's
        //    behalf. Repay caps at the outstanding debt; anything beyond goes to the wallet.
        uint256 surplus = received - assets;
        if (surplus != 0) {
            collateral.safeApproveWithRetry(address(POOL), surplus);
            POOL.supply(collateral, surplus, user, REFERRAL_NONE);
        }

        uint256 debtBorrowed = p.borrowAmount;
        uint256 leftover = debtAsset.balanceOf(address(this));
        if (leftover != 0) {
            debtAsset.safeApproveWithRetry(address(POOL), leftover);
            uint256 repaid = POOL.repay(debtAsset, leftover, VARIABLE_RATE, user);
            debtBorrowed -= repaid;
            if (repaid != leftover) {
                debtAsset.safeApproveWithRetry(address(POOL), 0);
                debtAsset.safeTransfer(user, leftover - repaid);
            }
        }

        emit PositionOpened(user, collateral, debtAsset, p.margin, assets + surplus, debtBorrowed);
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
        debtAsset.safeApproveWithRetry(address(POOL), assets);
        uint256 debtRepaid = POOL.repay(debtAsset, assets, VARIABLE_RATE, user);
        if (debtRepaid != assets) debtAsset.safeApproveWithRetry(address(POOL), 0);

        // 2. Pull the aTokens to swap — the amount was resolved and the permit consumed at
        //    entry. Aave's finalizeTransfer hook enforces the post-repay health factor here.
        aToken.safeTransferFrom(user, address(this), p.collateralToWithdraw);
        
        // Clear the residual allowance from the over-approved grant — but only when a permit
        // was granted this tx. deadline == 0 marks the standing-allowance path, where a zeroed
        // signature would fail ecrecover and brick the close with INVALID_SIGNATURE.
        if (p.revokePermit.deadline != 0) {
            _permitZero(aToken, user, p.revokePermit.deadline, p.revokePermit.v, p.revokePermit.r, p.revokePermit.s);
        }

        // withdraw all collateral tokens (pool has limited atoken balance)
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
        debtAsset.safeApproveWithRetry(address(MORPHO), assets);

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

    function _permit(address target, uint256 amount, uint256 deadline, uint8 v,bytes32 r, bytes32 s) internal {
            assembly("memory-safe") {
                let m := mload(0x40)

                mstore(m, 0xd505accf)
                mstore(add(m, 0x20), caller())
                mstore(add(m, 0x40), address())
                mstore(add(m, 0x60), amount)
                mstore(add(m, 0x80), deadline)
                mstore(add(m, 0xa0), v)
                mstore(add(m, 0xc0), r)
                mstore(add(m, 0xe0), s)

                if iszero(call(gas(), target, 0, add(m,0x1c), 0xe4, codesize(), 0x00)) {
                    // Bubble up the revert if the call reverts.
                    returndatacopy(0x00, 0x00, returndatasize())
                    revert(0x00, returndatasize())
                }
            }

    }

      function _permitZero(address target, address user, uint256 deadline, uint8 v,bytes32 r, bytes32 s) internal {
            assembly("memory-safe") {
                let m := mload(0x40)

                mstore(m, 0xd505accf)
                mstore(add(m, 0x20), user)
                mstore(add(m, 0x40), address())
                mstore(add(m, 0x60), 0)
                mstore(add(m, 0x80), deadline)
                mstore(add(m, 0xa0), v)
                mstore(add(m, 0xc0), r)
                mstore(add(m, 0xe0), s)

                if iszero(call(gas(), target, 0, add(m,0x1c), 0xe4, codesize(), 0x00)) {
                    // Bubble up the revert if the call reverts.
                    returndatacopy(0x00, 0x00, returndatasize())
                    revert(0x00, returndatasize())
                }
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
