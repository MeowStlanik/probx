// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20LikeForInsurance {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract InsuranceFund {
    IERC20LikeForInsurance public immutable usdc;
    address public owner;
    address public engine;
    address public feeRouter;
    uint256 public totalFeesReceived;

    event EngineSet(address indexed engine);
    event FeeRouterSet(address indexed feeRouter);
    event FeesReceived(address indexed sender, uint256 amount);
    event ShortfallCovered(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier onlyEngine() {
        require(msg.sender == engine, "ONLY_ENGINE");
        _;
    }

    constructor(address usdc_) {
        require(usdc_ != address(0), "ZERO_USDC");
        usdc = IERC20LikeForInsurance(usdc_);
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

    /// @notice Accounting hook after FeeRouter has transferred USDC into this fund.
    ///         Only FeeRouter — owner cannot inflate totalFeesReceived without USDC.
    function receiveFees(uint256 amount) external {
        require(msg.sender == feeRouter, "ONLY_FEE_ROUTER");
        totalFeesReceived += amount;
        emit FeesReceived(msg.sender, amount);
    }

    function fundBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function coverShortfall(address to, uint256 amount) external onlyEngine {
        require(usdc.transfer(to, amount), "TRANSFER");
        emit ShortfallCovered(to, amount);
    }

    /// @notice Owner can recover accrued insurance funds. Without this, fees routed
    ///         here (20% of every ticket fee) are locked forever, since coverShortfall
    ///         is onlyEngine and the engine never calls it.
    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "ZERO_TO");
        require(usdc.transfer(to, amount), "TRANSFER");
        emit Withdrawn(to, amount);
    }
}
