// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

contract SettlementTest is MiniTest, TestHarness {
    function testYesWins() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(400_000);
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 30_000);

        vm.warp(20);
        market.resolve(1);
        engine.settleTicket(ticketId);

        PositionTicket.Ticket memory position = ticket.getTicket(ticketId);
        assertEq(uint256(position.status), uint256(PositionTicket.TicketStatus.Settled), "not settled");
        // Mid 0.40 → quoted YES = 0.40 × 1.08 = 0.432.
        // payout = 100e6 × 1e6 × 30_000 / (432_000 × 10_000) = 694_444_444 (floor).
        assertEq(usdc.balanceOf(address(user)), 10_000 * 1e6 - 100 * 1e6 - engine.calculateFee(100 * 1e6, 30_000) + 694_444_444, "bad yes payout");
    }

    function testNoWins() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(400_000);
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 30_000);

        vm.warp(20);
        market.resolve(2);
        engine.settleTicket(ticketId);

        PositionTicket.Ticket memory position = ticket.getTicket(ticketId);
        assertEq(uint256(position.status), uint256(PositionTicket.TicketStatus.Settled), "not settled");
        assertEq(pool.totalUserLossesReceived(), 100 * 1e6, "pool did not keep risk");
    }

    function testCancelMarketRefundsRiskAndReleasesReserve() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        uint256 fee = engine.calculateFee(100 * 1e6, 20_000);
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 20_000);
        market.cancel("demo oracle stale");
        engine.settleTicket(ticketId);

        assertEq(usdc.balanceOf(address(user)), 10_000 * 1e6 - fee, "risk not refunded");
        assertEq(pool.reservedAssets(), 0, "reserve not released");
        assertEq(pool.lockedUserRisk(), 0, "risk not unlocked");
    }

    function testBatchSettlementAndFeeRouting() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        uint256 firstTicketId = user.buy(address(market), 1, 100 * 1e6, 20_000);
        uint256 secondTicketId = user.buy(address(market), 2, 50 * 1e6, 10_000);

        vm.warp(20);
        market.resolve(1);
        uint256[] memory ids = new uint256[](2);
        ids[0] = firstTicketId;
        ids[1] = secondTicketId;
        engine.settleBatch(ids);

        assertEq(pool.reservedAssets(), 0, "reserve remains");
        assertTrue(pool.totalFeesEarned() > 0, "lp fees not credited");
        assertTrue(insuranceFund.totalFeesReceived() > 0, "insurance fees not credited");
    }
}
