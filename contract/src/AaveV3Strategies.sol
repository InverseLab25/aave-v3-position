// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

// Solady, install with: forge install vectorized/solady
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LibCall} from "solady/utils/LibCall.sol";
import {EnumerableSetLib} from "solady/utils/EnumerableSetLib.sol";

/*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
/*                        MORPHO BLUE                         */
/*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
/*                          AAVE V3                           */
/*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

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

/*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
/*                         STRATEGIES                         */
/*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

/// @dev Direction-neutral leveraged Aave V3 positions, one transaction each, financed by a
/// zero-fee Morpho Blue flash loan.
contract AaveV3Strategies is Ownable {
    using SafeTransferLib for address;
    using LibCall for address;
    using EnumerableSetLib for EnumerableSetLib.AddressSet;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       CUSTOM ERRORS                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev An entry point was re-entered while a flash-loan leg was still in flight.
    error Reentrancy();

    /// @dev The flash-loan callback did not run to completion.
    error ExpectedState();

    /// @dev The callback was invoked by something other than Morpho Blue.
    error NotMorpho();

    /// @dev The callback payload does not match the one committed to at entry.
    error UnexpectedCallback();

    /// @dev The owner has paused the entry points.
    error Paused();

    /// @dev `collateral` and `debtAsset` are the same reserve.
    error SameAsset();

    /// @dev A required amount was zero.
    error ZeroAmount();

    /// @dev A required address was the zero address.
    error ZeroAddress();

    /// @dev The caller has no variable debt in `debtAsset` to close.
    error NoDebt();

    /// @dev `router` is not on the owner's allowlist.
    error RouterNotAllowed();

    /// @dev The swap returned less than the caller's `minOut`.
    error InsufficientOutputFromRouter();

    /// @dev The swap returned less than the flash loan owed back to Morpho.
    error InsufficientOutputForFlashLoanRepayment();

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                           EVENTS                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev A leveraged position was opened for `user`. `collateralSupplied` includes the
    /// margin and any swap surplus; `debtBorrowed` is net of the leftover repay.
    event PositionOpened(
        address indexed user,
        address indexed collateral,
        address indexed debtAsset,
        uint256 margin,
        uint256 collateralSupplied,
        uint256 debtBorrowed
    );

    /// @dev A position was closed (fully or partially) for `user`. `returnedToUser` is the
    /// debt-asset surplus left after the flash repayment.
    event PositionClosed(
        address indexed user,
        address indexed collateral,
        address indexed debtAsset,
        uint256 debtRepaid,
        uint256 collateralWithdrawn,
        uint256 returnedToUser
    );

    /// @dev `router` was added to (`allowed` true) or removed from the swap allowlist.
    event RouterSet(address indexed router, bool allowed);

    /// @dev The entry points were paused or unpaused.
    event PauseSet(bool paused);

    /// @dev `amount` of `token` was swept out to `to`.
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          STRUCTS                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev An EIP-2612 permit over `amount`. `amount` == 0 skips it and relies on an existing
    /// allowance — the revoke that clears it still runs, so a `Sig` is required either way.
    struct Permit {
        uint256 amount;
        uint256 deadline;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    /// @dev A bare signature. The signed value is implied by the call site, never carried here:
    /// 0 for the close revoke, `borrowAmount` for a delegation. deadline == 0 skips a delegation
    /// and relies on a standing one; the close revoke has no such opt-out and always runs.
    struct Sig {
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
        uint256 marginAmount;
        uint256 borrowAmount;
        uint256 minOut;
        bytes swapData;
    }

    /// @dev See {OpenParam} for the `mode`-first layout. `collateralToWithdraw` is always
    /// concrete here — the max sentinel is resolved at entry.
    struct CloseParam {
        uint256 mode;
        address user;
        address collateral;
        address debtAsset;
        address router;
        uint256 collateralToWithdraw;
        uint256 minOut;
        Sig revokePermit;
        bytes swapData;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         CONSTANTS                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Aave's variable interest rate mode.
    uint256 private constant VARIABLE_RATE = 2;

    /// @dev No Aave referral program.
    uint16 private constant REFERRAL_NONE = 0;

    /// @dev Flow B: margin arrives in the DEBT asset and joins the borrow in the swap.
    uint256 private constant MODE_OPEN = 0;

    /// @dev Unwind: repay debt, pull collateral, swap back to the debt asset.
    uint256 private constant MODE_CLOSE = 1;

    /// @dev Flow A: margin arrives in the collateral asset and joins the flash in one supply.
    uint256 private constant MODE_OPEN_COLL = 2;

    /// @dev Morpho Blue, the flash-loan source. Set at construction rather than hardcoded so
    /// one codebase serves several chains: the address is shared by Ethereum and Base but
    /// differs on every other chain Morpho has reached.
    IMorpho private immutable MORPHO;

    /// @dev The Aave V3 Pool. Differs on every chain, including between Ethereum and Base.
    IPool private immutable POOL;

    /// @dev `getReserveAToken(address)`, right-aligned.
    uint256 private constant GET_RESERVE_ATOKEN_SEL = 0xcff027d9;

    /// @dev `getReserveVariableDebtToken(address)`, right-aligned.
    uint256 private constant GET_RESERVE_VDEBT_SEL = 0x365090a0;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          STORAGE                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Nonzero blocks every entry point. Owner-controlled via {setPause}.
    uint256 public paused;

    /// @dev Swap routers the owner has approved. Only audited aggregator entry points belong
    /// here — they receive an arbitrary call with caller-supplied calldata.
    EnumerableSetLib.AddressSet private _allowedRouters;

    /// @dev keccak256 of the flash-loan payload encoded at entry, verified in the callback and
    /// cleared when the leg completes; doubles as the reentrancy guard. Transient.
    bytes32 private transient _pendingDataHash;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        CONSTRUCTOR                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Sets `owner_` as the initial owner of the router allowlist, pause and rescue, and
    /// binds the chain's Morpho Blue and Aave V3 Pool.
    ///
    /// Both were `constant`s hardcoded to Ethereum. Immutables read as cheaply — the value is
    /// inlined into the runtime code either way — while letting the same source deploy to any
    /// chain. That is only safe to pair with CREATE3 deployment: under CREATE2 these arguments
    /// would enter the init code and move the address per chain, which is exactly what the
    /// deploy script's use of CreateX avoids.
    ///
    /// `morpho_` is load-bearing for security, not just wiring: {onMorphoFlashLoan} trusts it
    /// as the sole permitted caller, so a wrong value here hands the callback to an impostor.
    constructor(address owner_, address morpho_, address pool_) {
        if (morpho_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        MORPHO = IMorpho(morpho_);
        POOL = IPool(pool_);
        _initializeOwner(owner_);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        ENTRY POINTS                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Opens a position with margin in the DEBT asset ({MODE_OPEN}). Flash-borrows
    /// `supplyAmount` of `collateral` and supplies it for the caller, borrows `borrowAmount`
    /// on the caller's credit, then swaps borrow + `marginAmount` back into `collateral` to
    /// repay the flash — output must cover both `minOut` and `supplyAmount`. Leftovers fold
    /// back into the position. `delegation` must be signed over exactly `borrowAmount`;
    /// `marginAmount` 0 ratchets leverage on an existing position.
    function openWithDebtMargin(
        address collateral,
        address debtAsset,
        uint256 supplyAmount,
        uint256 borrowAmount,
        uint256 marginAmount,
        uint256 minOut,
        address router,
        bytes calldata swapData,
        Sig calldata delegation
    ) external {
        _preflight(collateral, debtAsset, router);
        if (supplyAmount == 0 || borrowAmount == 0 || minOut == 0) revert ZeroAmount();

        // Margin arrives in the debt asset and joins the borrowed funds in the callback's swap.
        // Zero margin is the ratchet path — skip the pull rather than poke tokens that revert on
        // a zero-value transfer.
        if (marginAmount != 0) debtAsset.safeTransferFrom(msg.sender, address(this), marginAmount);

        // Signed over exactly `borrowAmount`, so the borrow consumes it in full — no residual
        // borrowing power is left here. deadline == 0 relies on an existing delegation.
        if (delegation.deadline != 0) {
            ICreditDelegationToken(_reserveToken(GET_RESERVE_VDEBT_SEL, debtAsset)).delegationWithSig(
                msg.sender,
                address(this),
                borrowAmount,
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
                    marginAmount: marginAmount,
                    borrowAmount: borrowAmount,
                    minOut: minOut,
                    swapData: swapData
                })
            )
        );
    }

    /// @dev Opens a position with margin in the COLLATERAL asset ({MODE_OPEN_COLL}), so it
    /// needs no pre-swap: `flashAmount + marginAmount` is supplied in one go, and the borrow
    /// is swapped back into collateral to repay the flash — output must cover both `minOut`
    /// and `flashAmount`. `delegation` must be signed over exactly `borrowAmount`;
    /// `marginAmount` 0 ratchets leverage on an existing position.
    function openWithCollateralMargin(
        address collateral,
        address debtAsset,
        uint256 flashAmount,
        uint256 borrowAmount,
        uint256 marginAmount,
        uint256 minOut,
        address router,
        bytes calldata swapData,
        Sig calldata delegation
    ) external {
        _preflight(collateral, debtAsset, router);
        if (flashAmount == 0 || borrowAmount == 0 || minOut == 0) revert ZeroAmount();

        // Margin is already the right asset — pull it here, supply it with the flash in the
        // callback. Zero margin is the ratchet path: the flash alone becomes the supply.
        if (marginAmount != 0) collateral.safeTransferFrom(msg.sender, address(this), marginAmount);

        // Signed over exactly `borrowAmount`, so the borrow consumes it in full — no residual
        // borrowing power is left here. deadline == 0 relies on an existing delegation.
        if (delegation.deadline != 0) {
            ICreditDelegationToken(_reserveToken(GET_RESERVE_VDEBT_SEL, debtAsset)).delegationWithSig(
                msg.sender,
                address(this),
                borrowAmount,
                delegation.deadline,
                delegation.v,
                delegation.r,
                delegation.s
            );
        }

        _flash(
            collateral,
            flashAmount,
            abi.encode(
                OpenParam({
                    mode: MODE_OPEN_COLL,
                    user: msg.sender, // bound to the caller — the callback can never act for anyone else
                    collateral: collateral,
                    debtAsset: debtAsset,
                    router: router,
                    marginAmount: marginAmount,
                    borrowAmount: borrowAmount,
                    minOut: minOut,
                    swapData: swapData
                })
            )
        );
    }

    /// @dev Closes the caller's position. `debtRepay` may be max to repay the whole variable
    /// debt; less is a partial close, bounded by Aave's health-factor check in the aToken's
    /// `finalizeTransfer`. `collateralToWithdraw` may be max to drain — resolved to the live
    /// balance at entry, so the callback only ever sees a concrete amount. `revokePermit` is
    /// always required: the aToken allowance is zeroed on every close.
    function closePositionWithPermit(
        address collateral,
        address debtAsset,
        uint256 collateralToWithdraw,
        uint256 debtRepay,
        uint256 minOut,
        address router,
        Permit calldata permit,
        Sig calldata revokePermit,
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
        // loan and repay are paid for.
        if (permit.amount != 0) {
            _permit(aToken, permit.amount, permit.deadline, permit.v, permit.r, permit.s);
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

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                 MORPHO FLASH LOAN CALLBACK                 */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Morpho Blue's flash-loan callback. Only Morpho may call it, and only with the exact
    /// payload committed to in {_flash}; the leg is dispatched off the payload's leading mode
    /// word and the commitment is cleared on the way out.
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

        if (mode == MODE_CLOSE) _close(assets, params);
        else _open(assets, params);

        _pendingDataHash = bytes32(0);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      FLASH LOAN LEGS                       */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev The open leg, for both flows. `params` is the calldata offset of the {OpenParam}
    /// inside the validated payload.
    function _open(uint256 assets, uint256 params) private {
        OpenParam calldata p;
        assembly ("memory-safe") {
            p := params
        }

        address user = p.user;
        address collateral = p.collateral;
        address debtAsset = p.debtAsset;

        // 1. Supply the flash-borrowed collateral, plus the margin on the Flow A path.
        uint256 supplyTotal = assets;
        if (p.mode == MODE_OPEN_COLL) supplyTotal += p.marginAmount;

        collateral.safeApproveWithRetry(address(POOL), supplyTotal);
        POOL.supply(collateral, supplyTotal, user, REFERRAL_NONE);

        // 2. Borrow on the user's credit — Aave's LTV validation is the bound.
        POOL.borrow(debtAsset, p.borrowAmount, VARIABLE_RATE, REFERRAL_NONE, user);

        // 3. Swap the borrow (plus the Flow B margin) back into collateral.
        uint256 beforeColl = collateral.balanceOf(address(this));
        uint256 swapIn = p.borrowAmount + (p.mode == MODE_OPEN_COLL ? 0 : p.marginAmount);
        // `swapIn` is exactly the debt asset THIS call introduced, so any excess is a stray.
        // Snapshot it and exclude it from the leftover math below — strays stay put for rescue.
        uint256 strayDebt = debtAsset.balanceOf(address(this)) - swapIn;
        _swap(debtAsset, p.router, swapIn, p.swapData);

        uint256 received = collateral.balanceOf(address(this)) - beforeColl;

        uint256 minOut = p.minOut;
        if (received < minOut) revert InsufficientOutputFromRouter();
        // The flash repayment is the hard floor under any user-chosen minOut.
        if (received < assets) revert InsufficientOutputForFlashLoanRepayment();

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
        // Only this call's unspent debt asset counts as leftover — never a pre-existing stray.
        uint256 leftover = debtAsset.balanceOf(address(this)) - strayDebt;
        if (leftover != 0) {
            // Repay only the debt this tx created — never the user's pre-existing debt. Cap the
            // repay at `borrowAmount`: total debt >= borrowAmount here, so Aave repays exactly
            // `toRepay` and the subtraction can never underflow.
            uint256 toRepay = leftover < debtBorrowed ? leftover : debtBorrowed;
            if (toRepay != 0) {
                debtAsset.safeApproveWithRetry(address(POOL), toRepay);
                debtBorrowed -= POOL.repay(debtAsset, toRepay, VARIABLE_RATE, user);
            }
            // Unspent margin (this call's money) goes back to the user; the stray stays put.
            uint256 remainder = debtAsset.balanceOf(address(this)) - strayDebt;
            if (remainder != 0) debtAsset.safeTransfer(user, remainder);
        }

        emit PositionOpened(user, collateral, debtAsset, p.marginAmount, supplyTotal + surplus, debtBorrowed);
    }

    /// @dev The close leg. `params` is the calldata offset of the {CloseParam} inside the
    /// validated payload.
    function _close(uint256 assets, uint256 params) private {
        CloseParam calldata p;
        assembly ("memory-safe") {
            p := params
        }

        address user = p.user;
        address collateral = p.collateral;
        address debtAsset = p.debtAsset;

        address aToken = _reserveToken(GET_RESERVE_ATOKEN_SEL, collateral);

        // Snapshot balances already resting here. Everything below settles on deltas, so these
        // strays are never withdrawn, swapped, or paid to the caller — they stay put for rescue.
        uint256 strayColl = collateral.balanceOf(address(this));
        uint256 strayAToken = aToken.balanceOf(address(this));

        // 1. Repay Aave debt to unlock the collateral.
        debtAsset.safeApproveWithRetry(address(POOL), assets);
        uint256 debtRepaid = POOL.repay(debtAsset, assets, VARIABLE_RATE, user);
        if (debtRepaid != assets) debtAsset.safeApproveWithRetry(address(POOL), 0);

        // 2. Pull the aTokens to swap — the amount was resolved and the permit consumed at
        //    entry. Aave's finalizeTransfer hook enforces the post-repay health factor here.
        aToken.safeTransferFrom(user, address(this), p.collateralToWithdraw);

        // Clear the residual allowance left by the over-approved grant. Always runs, so no close
        // can ever leave this contract holding spare aToken approval — `revokePermit` is a
        // required signature over 0, on the standing-allowance path too.
        _permitZero(aToken, user, p.revokePermit.deadline, p.revokePermit.v, p.revokePermit.r, p.revokePermit.s);

        // Withdraw only the user's pulled collateral, leaving any stray aTokens behind. With no
        // stray, use the max sentinel to dodge a 1-wei ray-rounding revert on a full-position close.
        uint256 collateralAmount =
            POOL.withdraw(collateral, strayAToken == 0 ? type(uint256).max : p.collateralToWithdraw, address(this));

        // 3. Swap the collateral back into the debt asset.
        uint256 beforeBalance = debtAsset.balanceOf(address(this));
        _swap(collateral, p.router, collateralAmount, p.swapData);
        uint256 swapOutput = debtAsset.balanceOf(address(this)) - beforeBalance;

        // 4. Enforce the user's slippage bound, then ensure the flash loan is fully covered.
        uint256 minOut = p.minOut;
        if (swapOutput < minOut) revert InsufficientOutputFromRouter();
        // The user's OWN swap must cover the flash — never any stray debt asset already here.
        if (swapOutput < assets) revert InsufficientOutputForFlashLoanRepayment();

        // 5. Let Morpho pull the repayment; return only this close's surplus and only the
        //    collateral this close left over — any pre-existing stray of either token stays put.
        debtAsset.safeApproveWithRetry(address(MORPHO), assets);

        uint256 returned = swapOutput - assets;
        if (returned != 0) debtAsset.safeTransfer(user, returned);

        uint256 collateralLeft = collateral.balanceOf(address(this)) - strayColl;
        if (collateralLeft != 0) collateral.safeTransfer(user, collateralLeft);

        emit PositionClosed(user, collateral, debtAsset, debtRepaid, collateralAmount, returned);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      INTERNAL HELPERS                      */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

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
        address pool = address(POOL);
        assembly ("memory-safe") {
            mstore(0x00, sel)
            mstore(0x20, asset)
            // calldata = selector (4 bytes at 0x1c) ++ asset (32 bytes at 0x20).
            if iszero(staticcall(gas(), pool, 0x1c, 0x24, 0x00, 0x20)) {
                returndatacopy(0x00, 0x00, returndatasize())
                revert(0x00, returndatasize())
            }
            result := mload(0x00)
            if or(lt(returndatasize(), 0x20), shr(160, result)) { revert(0x00, 0x00) }
        }
    }

    /// @dev `permit(msg.sender, address(this), amount, deadline, v, r, s)` on `target`.
    /// A revert bubbles up.
    function _permit(address target, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        assembly ("memory-safe") {
            let m := mload(0x40)

            mstore(m, 0xd505accf) // `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)`.
            mstore(add(m, 0x20), caller())
            mstore(add(m, 0x40), address())
            mstore(add(m, 0x60), amount)
            mstore(add(m, 0x80), deadline)
            mstore(add(m, 0xa0), v)
            mstore(add(m, 0xc0), r)
            mstore(add(m, 0xe0), s)

            if iszero(call(gas(), target, 0, add(m, 0x1c), 0xe4, codesize(), 0x00)) {
                returndatacopy(0x00, 0x00, returndatasize())
                revert(0x00, returndatasize())
            }
        }
    }

    /// @dev `permit(user, address(this), 0, deadline, v, r, s)` on `target` — clears the
    /// residual allowance left by an over-approved grant. A revert bubbles up.
    function _permitZero(address target, address user, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        assembly ("memory-safe") {
            let m := mload(0x40)

            mstore(m, 0xd505accf) // `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)`.
            mstore(add(m, 0x20), user)
            mstore(add(m, 0x40), address())
            mstore(add(m, 0x60), 0)
            mstore(add(m, 0x80), deadline)
            mstore(add(m, 0xa0), v)
            mstore(add(m, 0xc0), r)
            mstore(add(m, 0xe0), s)

            if iszero(call(gas(), target, 0, add(m, 0x1c), 0xe4, codesize(), 0x00)) {
                returndatacopy(0x00, 0x00, returndatasize())
                revert(0x00, returndatasize())
            }
        }
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                           ADMIN                            */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

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

    /// @dev Pauses (`c` true) or unpauses every entry point.
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
