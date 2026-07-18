// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MicroMarket.sol";

contract MicroMarketFactory {
    struct MarketInfo {
        address market;
        bytes32 metadataHash;
        uint64 createdAt;
    }

    address public owner;
    address public engine;
    address public oracle;
    MarketInfo[] private markets;

    event MarketCreated(
        uint256 indexed marketId,
        address indexed market,
        string question,
        bytes32 indexed metadataHash
    );
    event EngineSet(address indexed engine);
    event OracleSet(address indexed oracle);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    constructor(address engine_, address oracle_) {
        owner = msg.sender;
        engine = engine_;
        oracle = oracle_;
    }

    function setEngine(address engine_) external onlyOwner {
        engine = engine_;
        emit EngineSet(engine_);
    }

    function setOracle(address oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleSet(oracle_);
    }

    function createMarket(
        string calldata question,
        bytes32 rulesHash,
        uint64 openTime,
        uint64 lockTime,
        uint64 observationStart,
        uint64 observationEnd,
        uint256 yesPrice
    ) external onlyOwner returns (address market) {
        market = address(
            new MicroMarket(
                msg.sender,
                engine,
                oracle,
                question,
                rulesHash,
                openTime,
                lockTime,
                observationStart,
                observationEnd,
                yesPrice
            )
        );
        markets.push(MarketInfo({ market: market, metadataHash: rulesHash, createdAt: uint64(block.timestamp) }));
        emit MarketCreated(markets.length - 1, market, question, rulesHash);
    }

    function getMarkets() external view returns (MarketInfo[] memory) {
        return markets;
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function marketAt(uint256 id) external view returns (MarketInfo memory) {
        return markets[id];
    }
}
