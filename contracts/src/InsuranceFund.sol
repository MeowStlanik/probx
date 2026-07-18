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
    uint256 public totalFeesReceived;

    event EngineSet(address indexed engine);
    event FeesReceived(address indexed sender, uint256 amount);
    event ShortfallCovered(address indexed to, uint256 amount);

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

    function receiveFees(uint256 amount) external {
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
}
