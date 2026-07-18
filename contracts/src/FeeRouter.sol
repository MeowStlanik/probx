// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20LikeForFees {
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ILiquidityPoolForFees {
    function creditFee(uint256 amount) external;
}

interface IInsuranceFundForFees {
    function receiveFees(uint256 amount) external;
}

contract FeeRouter {
    uint256 public constant BPS = 10_000;

    IERC20LikeForFees public immutable usdc;
    ILiquidityPoolForFees public liquidityPool;
    IInsuranceFundForFees public insuranceFund;
    address public treasury;
    address public owner;

    uint256 public lpShareBps = 6_000;
    uint256 public insuranceShareBps = 2_000;
    uint256 public treasuryShareBps = 2_000;
    uint256 public totalFeesRouted;

    event FeeSplitSet(uint256 lpShareBps, uint256 insuranceShareBps, uint256 treasuryShareBps);
    event FeeRouted(uint256 amount, uint256 lpAmount, uint256 insuranceAmount, uint256 treasuryAmount);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    constructor(address usdc_, address liquidityPool_, address insuranceFund_, address treasury_) {
        require(usdc_ != address(0), "ZERO_USDC");
        require(liquidityPool_ != address(0), "ZERO_POOL");
        require(insuranceFund_ != address(0), "ZERO_INSURANCE");
        require(treasury_ != address(0), "ZERO_TREASURY");
        usdc = IERC20LikeForFees(usdc_);
        liquidityPool = ILiquidityPoolForFees(liquidityPool_);
        insuranceFund = IInsuranceFundForFees(insuranceFund_);
        treasury = treasury_;
        owner = msg.sender;
    }

    function setFeeSplit(uint256 lpBps, uint256 insuranceBps, uint256 treasuryBps)
        external
        onlyOwner
    {
        require(lpBps + insuranceBps + treasuryBps == BPS, "BAD_SPLIT");
        lpShareBps = lpBps;
        insuranceShareBps = insuranceBps;
        treasuryShareBps = treasuryBps;
        emit FeeSplitSet(lpBps, insuranceBps, treasuryBps);
    }

    function routeFee(uint256 amount) external {
        if (amount == 0) return;
        uint256 lpAmount = (amount * lpShareBps) / BPS;
        uint256 insuranceAmount = (amount * insuranceShareBps) / BPS;
        uint256 treasuryAmount = amount - lpAmount - insuranceAmount;

        require(usdc.transfer(address(liquidityPool), lpAmount), "LP_TRANSFER");
        liquidityPool.creditFee(lpAmount);
        require(usdc.transfer(address(insuranceFund), insuranceAmount), "INSURANCE_TRANSFER");
        insuranceFund.receiveFees(insuranceAmount);
        require(usdc.transfer(treasury, treasuryAmount), "TREASURY_TRANSFER");

        totalFeesRouted += amount;
        emit FeeRouted(amount, lpAmount, insuranceAmount, treasuryAmount);
    }
}
