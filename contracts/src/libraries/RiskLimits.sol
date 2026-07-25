// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library RiskLimits {
    uint256 internal constant BPS = 10_000;
    /// @dev Minimum stake per ticket (0.25 USDC). Prevents dust trades that only
    ///      hit the price-impact floor and manipulate the book for free.
    uint256 internal constant MIN_USER_RISK_PER_TICKET = 250_000; // 0.25 USDC
    uint256 internal constant MAX_USER_RISK_PER_TICKET = 100 * 1e6;
    uint256 internal constant MAX_PAYOUT_PER_TICKET = 2_500 * 1e6;
    /// @dev Hard protocol cap (5x). Economic boost for a given book is lower:
    ///      roughly 1 + overround margin (~1.08x) is self-funded; above that is LP spend.
    uint256 internal constant MAX_BOOST_BPS = 50_000;
    uint256 internal constant MAX_LP_RESERVE_PER_MARKET_BPS = 8_000;
    uint256 internal constant MAX_LP_RESERVE_PER_OUTCOME_BPS = 8_000;
    uint256 internal constant MAX_LP_RESERVE_PER_USER_BPS = 8_000;

    function cap(uint256 tvl, uint256 capBps) internal pure returns (uint256) {
        return (tvl * capBps) / BPS;
    }
}
