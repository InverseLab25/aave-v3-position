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
    function getReserveAToken(address asset) external view returns (address);
    function getReserveVariableDebtToken(address asset) external view returns (address);
}

interface IERC20 {
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @dev Aave V3 variable debt tokens implement credit delegation: the position owner signs a
/// delegation allowing this contract to borrow on their behalf. The debt lands on the user, the
/// borrowed funds go to the borrower's chosen recipient — here, this contract.
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
/*                       AAVE V3 LEVERAGE                     */
/*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

/// @dev Opens and closes leveraged Aave V3 positions in one transaction each, financed by a
/// zero-fee Morpho Blue flash loan. Direction-neutral: a long supplies the volatile asset and
/// borrows the stable; a short supplies the stable and borrows the volatile asset — the same
/// code path with the roles swapped. Both directions share one owner, one pause word, one router
/// allowlist, and one flash-loan callback — so a user grants approvals to a single address.
///
/// Open: flash borrow the debt asset, swap it to collateral, supply the user's margin plus the
/// swap output to Aave for the user, borrow the debt asset back on the user's credit delegation,
/// repay the flash loan.
///
/// Close: flash borrow the debt, repay Aave, pull and withdraw the user's collateral, swap it
/// back to the debt asset, repay the flash loan and return the remainder.
///
/// Security model:
/// - The swap router is restricted to an owner-managed allowlist. It receives an arbitrary call
///   with caller-supplied calldata, so only audited aggregator entry points belong there — never
///   tokens, aTokens, debt tokens, the Aave Pool, or Morpho.
/// - The callback is doubly authenticated: `msg.sender` must be Morpho, and the payload must hash
///   to what this contract committed to earlier in the same transaction.
/// - Every action on a user's Aave account is pinned to the `msg.sender` captured at entry, so
///   the callback can never act for anyone else.
/// - Router approvals are exact-amount and revoked in-transaction. Approvals to Morpho and the
///   Aave Pool are left at max: both are trusted, hardcoded, and already invoked in the flow, and
///   this contract holds no funds at rest for them to take.
contract AaveV3Leverage is Ownable {
    using SafeTransferLib for address;
    using LibCall for address;
    using EnumerableSetLib for EnumerableSetLib.AddressSet;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                       CUSTOM ERRORS                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev An entry point was called while a flash loan of ours was still in flight.
    error Reentrancy();

    /// @dev The flash loan returned without the callback having run.
    error ExpectedState();

    /// @dev The flash-loan callback was not called by Morpho Blue.
    error NotMorpho();

    /// @dev The callback payload is not the one committed to at entry.
    error UnexpectedCallback();

    /// @dev The caller has no variable debt in `debtAsset` to close.
    error NoDebt();

    /// @dev The collateral and debt assets must differ.
    error SameAsset();

    /// @dev The requested direction is paused.
    error Paused();

    /// @dev The transaction was mined after its deadline.
    error Expired();

    /// @dev The router is not on the owner's allowlist.
    error RouterNotAllowed();

    /// @dev An amount that must be non-zero was zero.
    error ZeroAmount();

    /// @dev An address that must be non-zero was zero.
    error ZeroAddress();

    /// @dev The swap produced less than required.
    error InsufficientOutput(uint256 have, uint256 need);

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          EVENTS                            */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

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

    event PauseSet(uint256 paused);

    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                         CONSTANTS                          */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Set in `paused` to block `openPosition`.
    uint256 public constant PAUSE_OPEN = 1 << 0;

    /// @dev Set in `paused` to block `closePosition`.
    uint256 public constant PAUSE_CLOSE = 1 << 1;

    // Hardcoded to Ethereum mainnet: Morpho Blue, Aave V3 Pool.
    IMorpho private constant _MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    IPool private constant _POOL = IPool(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2);

    uint256 private constant _VARIABLE_RATE = 2;
    uint16 private constant _REFERRAL_NONE = 0;

    /// @dev Leading word of the flash-loan payload, telling the callback which leg to run.
    uint256 private constant _MODE_OPEN = 0;
    uint256 private constant _MODE_CLOSE = 1;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          STRUCTS                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev An EIP-2612 signature. `value` of 0 means "rely on an existing allowance or
    /// delegation" and skips the call entirely.
    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Signature over an EIP-2612 permit for value 0 at nonce N+1, the grant sitting at N.
    /// Carries no `value`: the contract passes a literal 0, so this can only ever clear.
    struct RevokePermit {
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct OpenParams {
        address user;
        address collateral;
        address debtAsset;
        uint256 margin;
        uint256 minCollateralOut;
        address router;
        bytes swapData;
    }

    struct CloseParams {
        address user;
        address collateral;
        address debtAsset;
        uint256 collateralToWithdraw;
        uint256 minOut;
        address router;
        RevokePermit revokePermit;
        bytes swapData;
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                          STORAGE                           */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:°.´:•˚°.*°.˚:*.´+°.•°:´*.´•*.•°.•*/

    /// @dev Bitmask of `PAUSE_OPEN` and `PAUSE_CLOSE`, so one leg can be halted without
    /// trapping users who need the other.
    uint256 public paused;

    /// @dev Swap routers the owner has approved. Enumerable so a caller can read the whole set
    /// and filter routes up front, instead of discovering `RouterNotAllowed()` after the user
    /// has already signed.
    EnumerableSetLib.AddressSet private _allowedRouters;

    /// @dev keccak256 of the flash-loan payload encoded at entry, verified in the callback and
    /// cleared once the leg completes. Held for the whole callback, so it doubles as the
    /// reentrancy guard over the arbitrary router call. Transient, so a stuck value can never
    /// brick the contract across transactions.
    bytes32 private transient _pendingDataHash;

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        CONSTRUCTOR                         */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    constructor(address owner_) {
        _initializeOwner(owner_);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        ENTRY POINTS                        */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Opens a leveraged position for the caller. `marginAmount` of `collateral` is pulled from
    /// the caller (may be 0 to lever an existing position), `flashAmount` of `debtAsset` is flash
    /// borrowed and swapped into collateral, and the caller ends up owing exactly `flashAmount`
    /// to Aave. `swapData` must swap `flashAmount` of `debtAsset` into `collateral` with this
    /// contract as the recipient. `delegation` must delegate at least `flashAmount` of borrowing
    /// power on the variable debt token of `debtAsset` — sign the exact amount per transaction
    /// rather than leaving a standing max delegation.
    function openPosition(
        address collateral,
        address debtAsset,
        uint256 marginAmount,
        uint256 flashAmount,
        uint256 minCollateralOut,
        address router,
        uint256 deadline,
        bytes calldata swapData,
        Permit calldata marginPermit,
        Permit calldata delegation
    ) external {
        _preflight(PAUSE_OPEN, collateral, debtAsset, router);
        if (block.timestamp > deadline) revert Expired();
        if (flashAmount == 0 || minCollateralOut == 0) revert ZeroAmount();

        // 1. Pull the caller's margin up front, so the callback only has to supply.
        if (marginAmount != 0) {
            if (marginPermit.value != 0) {
                IERC2612(collateral).permit(
                    msg.sender,
                    address(this),
                    marginPermit.value,
                    marginPermit.deadline,
                    marginPermit.v,
                    marginPermit.r,
                    marginPermit.s
                );
            }
            collateral.safeTransferFrom(msg.sender, address(this), marginAmount);
        }

        // 2. Take the credit delegation that lets the callback borrow on the caller's behalf.
        if (delegation.value != 0) {
            ICreditDelegationToken(_POOL.getReserveVariableDebtToken(debtAsset)).delegationWithSig(
                msg.sender,
                address(this),
                delegation.value,
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
                _MODE_OPEN,
                OpenParams({
                    user: msg.sender, // bound to the caller — the callback can never act for anyone else
                    collateral: collateral,
                    debtAsset: debtAsset,
                    margin: marginAmount,
                    minCollateralOut: minCollateralOut,
                    router: router,
                    swapData: swapData
                })
            )
        );
    }

    /// @dev Closes the caller's position, using an aToken `permit` at nonce N and `revokePermit`
    /// clearing it at N+1. `repayAmount` may be max to repay the entire variable debt; anything
    /// smaller is a partial close, and Aave's health-factor check inside `withdraw` bounds
    /// `collateralToWithdraw`. `collateralToWithdraw` may be max to drain the whole balance.
    function closePosition(
        address collateral,
        address debtAsset,
        uint256 repayAmount,
        uint256 collateralToWithdraw,
        uint256 minOut,
        address router,
        bytes calldata swapData,
        Permit calldata permit,
        RevokePermit calldata revokePermit
    ) external {
        _preflight(PAUSE_CLOSE, collateral, debtAsset, router);
        if (repayAmount == 0 || collateralToWithdraw == 0 || minOut == 0) revert ZeroAmount();

        // An unlisted reserve yields address(0) here, whose `balanceOf` reads as 0 and trips NoDebt.
        uint256 debt = _POOL.getReserveVariableDebtToken(debtAsset).balanceOf(msg.sender);
        if (debt == 0) revert NoDebt();

        // Partial close: flash only what the caller wants repaid, never more than the
        // live debt — a stale frontend quote can't over-borrow the flash loan.
        if (repayAmount < debt) debt = repayAmount;

        // Consume the aToken permit up front: a bad or front-run signature reverts before
        // the flash loan and repay are paid for. Only the revoke stays in the callback —
        // it must run after the transferFrom.
        if (permit.value != 0) {
            IERC2612(_POOL.getReserveAToken(collateral)).permit(
                msg.sender, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s
            );
        }

        _flash(
            debtAsset,
            debt,
            abi.encode(
                _MODE_CLOSE,
                CloseParams({
                    user: msg.sender, // bound to the caller — the callback can never act for anyone else
                    collateral: collateral,
                    debtAsset: debtAsset,
                    collateralToWithdraw: collateralToWithdraw,
                    minOut: minOut,
                    router: router,
                    revokePermit: revokePermit,
                    swapData: swapData
                })
            )
        );
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                 MORPHO FLASH LOAN CALLBACK                 */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(_MORPHO)) revert NotMorpho();
        bytes32 expected = _pendingDataHash;

        // `data` is byte-for-byte the payload this contract abi.encode'd at entry: a mode word
        // followed by the offset of the params struct.
        uint256 mode;
        uint256 params;
        assembly ("memory-safe") {
            // Copy calldata into memory and then validate the keccak256 hash of data. Doesn't
            // update the free memory pointer, saving the memory expansion cost.
            calldatacopy(mload(0x40), data.offset, data.length)

            if or(xor(keccak256(mload(0x40), data.length), expected), iszero(expected)) {
                mstore(0x00, 0xdab1e993) // `UnexpectedCallback()`.
                revert(0x1c, 0x04)
            }

            mode := calldataload(data.offset)
            params := add(data.offset, calldataload(add(data.offset, 0x20)))
        }

        if (mode == _MODE_OPEN) _open(assets, params);
        else _close(assets, params);

        _pendingDataHash = bytes32(0);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                        FLASH LOAN LEGS                     */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    function _open(uint256 assets, uint256 params) private {
        OpenParams calldata p;
        assembly ("memory-safe") {
            p := params
        }

        // Cache the fields read more than once; each is a calldataload rather than a memory load.
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

        // 2. Supply everything we hold — the caller's margin plus the swap output — to Aave on
        //    behalf of the user. The aTokens are minted straight to the user's account.
        _approveMax(collateral, address(_POOL), afterBalance);
        _POOL.supply(collateral, afterBalance, user, _REFERRAL_NONE);

        // 3. Borrow exactly the flash amount on the user's credit, using the delegation taken at
        //    entry. Aave's health-factor check runs inside borrow(), so an over-levered request
        //    reverts the whole transaction — there is no partial state to unwind.
        _POOL.borrow(debtAsset, assets, _VARIABLE_RATE, _REFERRAL_NONE, user);

        // 4. Let Morpho pull the repayment, then return whatever the router left unspent.
        _approveMax(debtAsset, address(_MORPHO), assets);

        uint256 leftover = debtAsset.balanceOf(address(this)) - assets;
        if (leftover != 0) debtAsset.safeTransfer(user, leftover);

        emit PositionOpened(user, collateral, debtAsset, p.margin, afterBalance, assets);
    }

    function _close(uint256 assets, uint256 params) private {
        CloseParams calldata p;
        assembly ("memory-safe") {
            p := params
        }

        address user = p.user;
        address collateral = p.collateral;
        address debtAsset = p.debtAsset;
        address aToken = _POOL.getReserveAToken(collateral);

        // 1. Repay Aave debt to unlock the collateral.
        _approveMax(debtAsset, address(_POOL), assets);
        uint256 debtRepaid = _POOL.repay(debtAsset, assets, _VARIABLE_RATE, user);

        // 2. Pull the aTokens we intend to swap; the permit was already consumed at entry.
        uint256 pull = p.collateralToWithdraw;
        if (pull == type(uint256).max) pull = aToken.balanceOf(user);
        if (pull == 0) revert ZeroAmount();

        aToken.safeTransferFrom(user, address(this), pull);

        // deadline == 0 marks "no permit was granted" (caller relied on a standing
        // allowance), so there is nothing to clear.
        if (p.revokePermit.deadline != 0) {
            IERC2612(aToken).permit(
                user, address(this), 0, p.revokePermit.deadline, p.revokePermit.v, p.revokePermit.r, p.revokePermit.s
            );
        }

        uint256 collateralAmount = _POOL.withdraw(collateral, type(uint256).max, address(this));

        // 3. Swap the collateral back into the debt asset.
        uint256 beforeBalance = debtAsset.balanceOf(address(this));
        _swap(collateral, p.router, collateralAmount, p.swapData);
        uint256 afterBalance = debtAsset.balanceOf(address(this));

        // 4. Enforce the user's slippage bound, then ensure the flash loan is fully covered.
        uint256 swapOutput = afterBalance - beforeBalance;
        uint256 minOut = p.minOut;
        if (swapOutput < minOut) revert InsufficientOutput(swapOutput, minOut);
        if (afterBalance < assets) revert InsufficientOutput(afterBalance, assets);

        // 5. Let Morpho pull the repayment, then return the excess debt asset and any unswapped
        //    collateral, leaving this contract with zero balances. Both transfers are skipped
        //    when there is nothing to send — the common case for collateral, which the router
        //    usually consumes in full.
        _approveMax(debtAsset, address(_MORPHO), assets);

        uint256 returned = afterBalance - assets;
        if (returned != 0) debtAsset.safeTransfer(user, returned);

        uint256 collateralLeft = collateral.balanceOf(address(this));
        if (collateralLeft != 0) collateral.safeTransfer(user, collateralLeft);

        emit PositionClosed(user, collateral, debtAsset, debtRepaid, collateralAmount, returned);
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                      INTERNAL HELPERS                      */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Shared entry-point checks. Reading `_pendingDataHash` here is the reentrancy guard:
    /// the callback holds it set for its whole duration, including the router call.
    function _preflight(uint256 pauseBit, address collateral, address debtAsset, address router) private view {
        if (_pendingDataHash != bytes32(0)) revert Reentrancy();
        if (paused & pauseBit != 0) revert Paused();
        if (collateral == debtAsset) revert SameAsset();
        // Load-bearing check: `router` receives an arbitrary call with caller-supplied calldata
        // in the callback, so it must be a vetted aggregator only.
        if (!_allowedRouters.contains(router)) revert RouterNotAllowed();
    }

    /// @dev Commits to `data`, flash borrows, and confirms the callback ran to completion.
    function _flash(address token, uint256 assets, bytes memory data) private {
        _pendingDataHash = keccak256(data);
        _MORPHO.flashLoan(token, assets, data);
        if (_pendingDataHash != bytes32(0)) revert ExpectedState();
    }

    /// @dev Swaps through an allowlisted router. The approval is exact-amount and revoked
    /// immediately after, so no allowance to a router outlives the call.
    function _swap(address tokenIn, address router, uint256 amountIn, bytes calldata swapData) private {
        tokenIn.safeApproveWithRetry(router, amountIn);
        router.callContract(swapData);
        tokenIn.safeApproveWithRetry(router, 0);
    }

    /// @dev Tops up a standing max allowance for Morpho and the Aave Pool. Only ever called with
    /// those two trusted, hardcoded spenders — never a router. Reading the allowance is far
    /// cheaper than the SSTORE and Approval event an exact-amount approve costs every call.
    function _approveMax(address token, address spender, uint256 amount) private {
        if (IERC20(token).allowance(address(this), spender) < amount) {
            token.safeApproveWithRetry(spender, type(uint256).max);
        }
    }

    /*´:°•.°+.*•´.*:˚.°*.˚•´.°:°•.°•.*•´.*:˚.°*.˚•´.°:°•.°+.*•´.*:*/
    /*                           ADMIN                            */
    /*.•°:°.´+˚.*°.˚:*.´•*.+°.•°:´*.´•*.•°.•°:°.´:•˚°.*°.˚:*.´+°.•*/

    /// @dev Allows or disallows several routers at once; one bad entry reverts the whole batch.
    /// Only audited aggregator entry points belong here — they receive caller-supplied calldata.
    function setRouters(address[] calldata routers, bool allowed) external onlyOwner {
        for (uint256 i; i < routers.length; ++i) {
            address router = routers[i];
            if (router == address(0)) revert ZeroAddress();
            if (allowed) _allowedRouters.add(router);
            else _allowedRouters.remove(router);
            emit RouterSet(router, allowed);
        }
    }

    /// @dev Returns whether `router` may be passed to `openPosition` or `closePosition`.
    function allowedRouters(address router) external view returns (bool) {
        return _allowedRouters.contains(router);
    }

    /// @dev Returns every allowlisted router. Lets a caller filter swap routes up front instead
    /// of discovering `RouterNotAllowed()` after the user has signed a permit.
    function getAllowedRouters() external view returns (address[] memory) {
        return _allowedRouters.values();
    }

    /// @dev Sets the pause bitmask. Pass `PAUSE_OPEN | PAUSE_CLOSE` to halt both legs, 0 to
    /// resume. Halting opens while leaving closes live is the intended emergency posture.
    function setPause(uint256 bits) external onlyOwner {
        paused = bits;
        emit PauseSet(bits);
    }

    /// @dev Sweeps tokens accidentally sent here. The contract holds no user funds at rest, so
    /// this can only ever recover stray donations.
    function rescueToken(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit TokenRescued(token, to, token.safeTransferAll(to));
    }
}
