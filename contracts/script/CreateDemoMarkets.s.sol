// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/MicroMarketFactory.sol";

contract CreateDemoMarkets {
    function run(address factory) external returns (address market) {
        uint64 openTime = uint64(block.timestamp);
        uint64 lockTime = openTime + 5;
        uint64 observationStart = lockTime;
        uint64 observationEnd = observationStart + 30;

        market = MicroMarketFactory(factory).createMarket(
            "Will the next demo signal be GREEN?",
            keccak256("Demo Oracle emits GREEN; RED or timeout resolves NO"),
            openTime,
            lockTime,
            observationStart,
            observationEnd,
            400_000
        );
        MicroMarket(market).open();
    }
}
