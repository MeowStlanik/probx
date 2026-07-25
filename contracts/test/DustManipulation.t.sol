// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// Regression: dust trades used to move the book for free via MIN_IMPACT floor.
/// Now MIN_USER_RISK_PER_TICKET rejects sub-0.25 USDC stakes with MIN_RISK.
contract DustManipulationTest is MiniTest, TestHarness {
    function test_19_Dust_MinRiskBlocksManipulation() external {
        _deployWithLp(15 * 1e6);
        vm.warp(10);
        MicroMarket m = _createOpenMarket(500_000);

        uint256 yesBefore = m.yesPrice();

        // Dust buys of 0.000001 USDC must be rejected.
        for (uint256 i = 0; i < 40; i++) {
            MicroBoostEngine.Quote memory q = engine.quoteTicket(address(m), 2, 1, 10_000);
            assertTrue(!q.accepted, "dust quote should reject");
            assertTrue(
                keccak256(bytes(q.reason)) == keccak256(bytes("MIN_RISK")),
                "expected MIN_RISK"
            );
        }

        assertEq(m.yesPrice(), yesBefore, "price must not move without accepted fills");

        // Minimum stake is accepted.
        MicroBoostEngine.Quote memory ok = engine.quoteTicket(address(m), 1, 250_000, 10_000);
        assertTrue(ok.accepted, ok.reason);
    }
}
