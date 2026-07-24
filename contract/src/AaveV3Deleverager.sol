// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

// Solady, install with: forge install vectorized/solady
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LibCall} from "solady/utils/LibCall.sol";

/*//////////////////////////////////////////////////////////////
                        MORPHO BLUE
////////////////////////////////////////////////--------------*/

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/*//////////////////////////////////////////////////////////////
                          AAVE V3
////////////////////////////////////////////////--------------*/

interface IPool {
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IPoolDataProvider {
    function getReserveTokensAddresses(address asset)
        external
        view
        returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress);
}

interface IATokenPermit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function allowance(address owner, address spender) external view returns (uint256);
}

/*//////////////////////////////////////////////////////////////
                        DELEVERAGER
////////////////////////////////////////////////--------------*/

/// @title AaveV3Deleverager
/// @notice Closes an Aave V3 position in one transaction using a zero-fee Morpho Blue flash loan.
///         Flash borrow the debt token, repay Aave to free collateral, withdraw it,
///         swap it back to the debt token through a router you pick, repay the flash loan,
///         and send whatever is left to the user.
contract AaveV3Deleverager is Ownable, ReentrancyGuardTransient {
    using SafeTransferLib for address;
    using LibCall for address;

    // Hardcoded to Ethereum mainnet: Morpho Blue, Aave V3 Pool, Aave V3 ProtocolDataProvider.
    IMorpho private constant MORPHO = IMorpho(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    IPool private constant POOL = IPool(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2);
    IPoolDataProvider private constant DATA_PROVIDER = IPoolDataProvider(0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD);

    uint256 private constant VARIABLE_RATE = 2;

    uint256 public paused;

    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct CloseParams {
        address user;
        address collateral;
        address debtAsset;
        uint256 minOut;
        address router;
        Permit permit;
        bytes swapData;
    }

    event PositionClosed(
        address indexed user,
        address indexed collateral,
        address indexed debtAsset,
        uint256 debtRepaid,
        uint256 collateralWithdrawn,
        uint256 returnedToUser
    );

    error NotMorpho();
    error NoDebt();
    error SameAsset();
    error Paused();
    error InsufficientOutput(uint256 have, uint256 need);

    constructor(address _owner) {
        _initializeOwner(_owner);
    }

    /*//////////////////////////////////////////////////////////////
                            ENTRY POINT
    ////////////////////////////////////////////////--------------*/

    /// @notice Close your position in one transaction using Morpho Flash Loans & EIP-2612 Permit.
    function closePositionWithPermit(
        address collateral,
        address debtAsset,
        uint256 minOut,
        address router,
        bytes calldata swapData,
        Permit calldata permit
    ) external nonReentrant {
        if (paused != 0) revert Paused();

        if (collateral == debtAsset) revert SameAsset();

        (,, address vDebt) = DATA_PROVIDER.getReserveTokensAddresses(debtAsset);
        uint256 debt = vDebt.balanceOf(msg.sender);
        if (debt == 0) revert NoDebt();

        bytes memory data = abi.encode(
            CloseParams({
                user: msg.sender,
                collateral: collateral,
                debtAsset: debtAsset,
                minOut: minOut,
                router: router,
                permit: permit,
                swapData: swapData
            })
        );

        // Flash loan exact debt amount from Morpho Blue
        MORPHO.flashLoan(debtAsset, debt, data);
    }

    /*//////////////////////////////////////////////////////////////
                        MORPHO FLASH LOAN CALLBACK
    ////////////////////////////////////////////////--------------*/

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(MORPHO)) revert NotMorpho();
        CloseParams memory p = abi.decode(data, (CloseParams));

        (address aToken,,) = DATA_PROVIDER.getReserveTokensAddresses(p.collateral);

        // 1. Repay Aave debt to unlock collateral.
        // Repay the explicit flash-loaned `assets` (the full debt read at entry): Aave forbids
        // the type(uint256).max repay-all sentinel when onBehalfOf (p.user) != msg.sender (this
        // contract) — it reverts with NoExplicitAmountToRepayOnBehalf. Same-block repay, so the
        // debt index is unchanged and `assets` clears the position exactly.
        p.debtAsset.safeApproveWithRetry(address(POOL), assets);
        POOL.repay(p.debtAsset, assets, VARIABLE_RATE, p.user);
        p.debtAsset.safeApproveWithRetry(address(POOL), 0);

        // 2. Consume Permit & Pull aTokens
        if (p.permit.value > 0) {
            IATokenPermit(aToken)
                .permit(p.user, address(this), p.permit.value, p.permit.deadline, p.permit.v, p.permit.r, p.permit.s);
        }

        uint256 aBal = aToken.balanceOf(p.user);
        aToken.safeTransferFrom(p.user, address(this), aBal);
        uint256 collateralAmount = POOL.withdraw(p.collateral, type(uint256).max, address(this));

        uint256 beforeBalance = p.debtAsset.balanceOf(address(this));

        // 3. Swap collateral -> debt asset
        p.collateral.safeApproveWithRetry(p.router, collateralAmount);
        (p.router).callContract(p.swapData);
        p.collateral.safeApproveWithRetry(p.router, 0);

        // 4. Verify swap output covers flash loan
        uint256 afterBalance = p.debtAsset.balanceOf(address(this));
        if ((afterBalance - beforeBalance) < p.minOut) revert InsufficientOutput(afterBalance, p.minOut);

        // 5. Approve Morpho Blue to pull flash loan repayment
        p.debtAsset.safeApproveWithRetry(address(MORPHO), assets);

        // 6. Return excess debt asset & collateral to user
        uint256 returned = afterBalance - assets;
        if (returned > 0) {
            p.debtAsset.safeTransfer(p.user, returned);
        }
        p.collateral.safeTransferAll(p.user);

        emit PositionClosed(p.user, p.collateral, p.debtAsset, assets, collateralAmount, returned);
    }

    function setPause(bool c) external onlyOwner {
        paused = c ? 1 : 0;
    }
}
