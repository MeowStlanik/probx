// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library QuoteMath {
    uint256 internal constant PRICE_SCALE = 1e6;
    uint256 internal constant BPS = 10_000;

    function payout(uint256 riskAmount, uint256 price, uint256 boostBps)
        internal
        pure
        returns (uint256)
    {
        require(price > 0 && price < PRICE_SCALE, "BAD_PRICE");
        require(boostBps >= BPS, "BAD_BOOST");
        return (riskAmount * PRICE_SCALE * boostBps) / (price * BPS);
    }

    function requiredReserve(uint256 riskAmount, uint256 price, uint256 boostBps)
        internal
        pure
        returns (uint256)
    {
        uint256 boostedPayout = payout(riskAmount, price, boostBps);
        require(boostedPayout >= riskAmount, "BAD_PAYOUT");
        return boostedPayout - riskAmount;
    }

    function maxBoostBps(uint256 riskAmount, uint256 price, uint256 availableReserve)
        internal
        pure
        returns (uint256)
    {
        require(riskAmount > 0, "ZERO_RISK");
        require(price > 0 && price < PRICE_SCALE, "BAD_PRICE");
        return ((riskAmount + availableReserve) * price * BPS) / (riskAmount * PRICE_SCALE);
    }
}
