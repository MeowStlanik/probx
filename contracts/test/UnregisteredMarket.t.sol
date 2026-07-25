// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";
import "../src/MicroBoostEngine.sol";

/// @dev Spoof market that always looks buyable and resolves YES for the buyer.
contract FakeMarket {
    uint8 public constant OUTCOME_YES = 1;
    uint8 public winningOutcome_ = 1;
    uint8 public status_ = 1; // Open
    uint256 public yesPrice = 50_000; // 5% → huge payout
    uint256 public noPrice = 1_030_000;

    function canBuy() external pure returns (bool) {
        return true;
    }

    function priceForOutcome(uint8 outcome) external view returns (uint256) {
        if (outcome == OUTCOME_YES) return yesPrice;
        return noPrice;
    }

    function applyTradeImpact(uint8, uint256) external pure {}

    function status() external view returns (uint8) {
        return status_;
    }

    function winningOutcome() external view returns (uint8) {
        return winningOutcome_;
    }

    function markResolved() external {
        status_ = 3; // Resolved
    }
}

/// @notice Fake markets must not drain the LP via buyTicket/settleTicket.
contract UnregisteredMarketTest is MiniTest, TestHarness {
    function test_RevertUnregisteredMarket_buy() external {
        _deploy();
        FakeMarket fake = new FakeMarket();

        vm.expectRevert(abi.encodeWithSignature("Error(string)", "UNREGISTERED_MARKET"));
        user.buy(address(fake), 1, 50 * 1e6, 10_000);
    }

    function test_QuoteRejectsUnregisteredMarket() external {
        _deploy();
        FakeMarket fake = new FakeMarket();
        MicroBoostEngine.Quote memory q = engine.quoteTicket(address(fake), 1, 50 * 1e6, 10_000);
        assertTrue(!q.accepted, "quote should reject");
        assertTrue(keccak256(bytes(q.reason)) == keccak256(bytes("UNREGISTERED_MARKET")), "bad reason");
    }

    function test_RegisteredMarketStillWorks() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 10_000);
        assertTrue(ticketId > 0, "registered buy failed");
    }
}
