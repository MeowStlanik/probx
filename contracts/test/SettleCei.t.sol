// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// @notice Regression for audit F: settleTicket must mark settled/cancelled before pool pay.
///         We assert post-conditions: ticket terminal + exposure cleared + correct balances.
///         (Ordering itself is CEI; a re-settle attempt reverts NOT_OPEN.)
contract SettleCeiTest is MiniTest, TestHarness {
    function test_23_SettleWin_MarksBeforePay_IdempotentGuard() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        uint256 ticketId = user.buy(address(market), 1, 10 * 1e6, 10_000);

        vm.warp(50);
        market.resolve(1);
        engine.settleTicket(ticketId);

        PositionTicket.Ticket memory t = ticket.getTicket(ticketId);
        assertEq(uint256(t.status), uint256(PositionTicket.TicketStatus.Settled), "must be settled");
        (uint256 lpAlloc, ) = _exposureLp(address(market));
        assertEq(lpAlloc, 0, "exposure cleared");

        // Second settle must not pay again.
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "NOT_OPEN"));
        engine.settleTicket(ticketId);
    }

    function test_24_SettleCancel_MarksBeforeRefund() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        uint256 balBefore = usdc.balanceOf(address(user));
        uint256 fee = engine.calculateFee(10 * 1e6, 10_000);
        uint256 ticketId = user.buy(address(market), 1, 10 * 1e6, 10_000);

        market.cancel("test");
        engine.settleTicket(ticketId);

        PositionTicket.Ticket memory t = ticket.getTicket(ticketId);
        assertEq(uint256(t.status), uint256(PositionTicket.TicketStatus.Cancelled), "must be cancelled");
        // Risk refunded, fee kept.
        assertEq(usdc.balanceOf(address(user)), balBefore - fee, "risk refunded once");

        vm.expectRevert(abi.encodeWithSignature("Error(string)", "NOT_OPEN"));
        engine.settleTicket(ticketId);
    }

    function _exposureLp(address mkt) internal view returns (uint256 lpAlloc, uint256 totalRisk) {
        (uint256 totalUserRisk, , , , , uint256 lpReserveAllocated) = engine.marketExposure(mkt);
        return (lpReserveAllocated, totalUserRisk);
    }
}
