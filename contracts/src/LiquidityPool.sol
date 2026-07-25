// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20LikeForPool {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice LP vault for Micro Boost reserves.
/// @dev Share pricing uses `internalAssets` (accounting ledger), NOT raw token
///      balance — so direct USDC donations cannot inflate share price (ERC-4626
///      donation attack).
contract LiquidityPool {
    IERC20LikeForPool public immutable usdc;
    address public owner;
    address public engine;
    address public feeRouter;

    uint256 public totalShares;
    /// @dev Accounting base for share price / managedAssets. Ignores donated tokens.
    uint256 public internalAssets;
    uint256 public reservedAssets;
    uint256 public lockedUserRisk;
    uint256 public totalFeesEarned;
    uint256 public totalUserLossesReceived;
    mapping(address => uint256) public sharesOf;

    event Deposited(address indexed lp, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lp, uint256 assets, uint256 shares);
    event EngineSet(address indexed engine);
    event FeeRouterSet(address indexed feeRouter);
    event Reserved(uint256 amount);
    event UserRiskLocked(uint256 amount);
    event ReserveReleased(uint256 amount);
    event PayoutPaid(address indexed to, uint256 payout, uint256 reserveUsed, uint256 riskUsed);
    event LossSettled(uint256 riskKept, uint256 reserveReleased);
    event RiskRefunded(address indexed to, uint256 riskAmount, uint256 reserveReleased);
    event FeesCredited(uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier onlyEngine() {
        require(msg.sender == engine, "ONLY_ENGINE");
        _;
    }

    modifier onlyFeeRouter() {
        require(msg.sender == feeRouter, "ONLY_FEE_ROUTER");
        _;
    }

    constructor(address usdc_) {
        require(usdc_ != address(0), "ZERO_USDC");
        usdc = IERC20LikeForPool(usdc_);
        owner = msg.sender;
    }

    function setEngine(address engine_) external onlyOwner {
        engine = engine_;
        emit EngineSet(engine_);
    }

    function setFeeRouter(address feeRouter_) external onlyOwner {
        feeRouter = feeRouter_;
        emit FeeRouterSet(feeRouter_);
    }

    /// @notice Raw token balance — debug / dashboard only. Do not use for share pricing.
    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice LP-owned assets (excludes locked user risk). Based on internal ledger.
    function managedAssets() public view returns (uint256) {
        return internalAssets - lockedUserRisk;
    }

    function availableAssets() public view returns (uint256) {
        return internalAssets - lockedUserRisk - reservedAssets;
    }

    function deposit(uint256 amount) external returns (uint256 mintedShares) {
        require(amount > 0, "ZERO_AMOUNT");
        uint256 assetsBefore = managedAssets();
        require(usdc.transferFrom(msg.sender, address(this), amount), "TRANSFER_FROM");
        if (totalShares == 0 || assetsBefore == 0) {
            mintedShares = amount;
        } else {
            mintedShares = (amount * totalShares) / assetsBefore;
        }
        require(mintedShares > 0, "ZERO_SHARES");
        sharesOf[msg.sender] += mintedShares;
        totalShares += mintedShares;
        internalAssets += amount;
        emit Deposited(msg.sender, amount, mintedShares);
    }

    function withdraw(uint256 shares) external returns (uint256 assets) {
        require(shares > 0, "ZERO_SHARES");
        require(sharesOf[msg.sender] >= shares, "SHARES");
        assets = (shares * managedAssets()) / totalShares;
        require(availableAssets() >= assets, "RESERVED");
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        internalAssets -= assets;
        require(usdc.transfer(msg.sender, assets), "TRANSFER");
        emit Withdrawn(msg.sender, assets, shares);
    }

    function reserveForTicket(uint256 amount) external onlyEngine {
        require(availableAssets() >= amount, "INSUFFICIENT_RESERVE");
        reservedAssets += amount;
        emit Reserved(amount);
    }

    function lockUserRisk(uint256 amount) external onlyEngine {
        lockedUserRisk += amount;
        // User stake sits on the pool but is not LP equity — still counted in internalAssets
        // because buyTicket transfers risk USDC into the pool.
        internalAssets += amount;
        emit UserRiskLocked(amount);
    }

    function releaseReserve(uint256 amount) external onlyEngine {
        require(reservedAssets >= amount, "RESERVE");
        reservedAssets -= amount;
        emit ReserveReleased(amount);
    }

    function payPayout(address to, uint256 payout, uint256 reservedAmount, uint256 riskAmount)
        external
        onlyEngine
    {
        require(reservedAssets >= reservedAmount, "RESERVE");
        require(lockedUserRisk >= riskAmount, "RISK");
        reservedAssets -= reservedAmount;
        lockedUserRisk -= riskAmount;
        // Net LP loss on a win is payout - risk (the reserved amount).
        // risk was already in internalAssets via lockUserRisk; remove full payout.
        require(internalAssets >= payout, "INTERNAL");
        internalAssets -= payout;
        require(usdc.transfer(to, payout), "TRANSFER");
        emit PayoutPaid(to, payout, reservedAmount, riskAmount);
    }

    function settleLoss(uint256 riskAmount, uint256 reservedAmount) external onlyEngine {
        require(reservedAssets >= reservedAmount, "RESERVE");
        require(lockedUserRisk >= riskAmount, "RISK");
        reservedAssets -= reservedAmount;
        lockedUserRisk -= riskAmount;
        // Losing user stake stays as LP equity (already in internalAssets from lockUserRisk).
        totalUserLossesReceived += riskAmount;
        emit LossSettled(riskAmount, reservedAmount);
    }

    function refundRisk(address to, uint256 riskAmount, uint256 reservedAmount) external onlyEngine {
        require(reservedAssets >= reservedAmount, "RESERVE");
        require(lockedUserRisk >= riskAmount, "RISK");
        reservedAssets -= reservedAmount;
        lockedUserRisk -= riskAmount;
        require(internalAssets >= riskAmount, "INTERNAL");
        internalAssets -= riskAmount;
        require(usdc.transfer(to, riskAmount), "TRANSFER");
        emit RiskRefunded(to, riskAmount, reservedAmount);
    }

    function creditFee(uint256 amount) external onlyFeeRouter {
        // FeeRouter transfers USDC into the pool before calling this.
        internalAssets += amount;
        totalFeesEarned += amount;
        emit FeesCredited(amount);
    }
}
