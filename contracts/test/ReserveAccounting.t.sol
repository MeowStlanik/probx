// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

contract ReserveAccountingTest is MiniTest, TestHarness {
    function testReserveIncreasesOnTicketBuy() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);

        uint256 reservedBefore = pool.reservedAssets();
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 20_000);
        assertTrue(ticketId > 0, "ticket not minted");
        // Mid 0.50 → quoted YES = 0.54; payout = 100e6 × 2 / 0.54 = 370_370_370 (floor);
        // reserve = payout − stake = 270_370_370.
        assertEq(pool.reservedAssets(), reservedBefore + 270_370_370, "reserve mismatch");
        assertEq(pool.lockedUserRisk(), 100 * 1e6, "risk not locked");
    }

    function testReserveReleasesOnLosingTicket() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 20_000);

        vm.warp(20);
        market.resolve(2);
        engine.settleTicket(ticketId);

        assertEq(pool.reservedAssets(), 0, "reserve not released");
        assertEq(pool.lockedUserRisk(), 0, "risk not unlocked");
        assertEq(pool.totalUserLossesReceived(), 100 * 1e6, "loss not retained");
    }

    function testReservePaysWinningTicket() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 20_000);
        uint256 balanceBefore = usdc.balanceOf(address(user));

        vm.warp(20);
        market.resolve(1);
        engine.settleTicket(ticketId);

        // payout = 100e6 × 2 / 0.54 = 370_370_370 (see reserve test above).
        assertEq(usdc.balanceOf(address(user)), balanceBefore + 370_370_370, "winner payout mismatch");
        assertEq(pool.reservedAssets(), 0, "reserve not released");
    }

    function testCannotBuyIfReserveInsufficient() external {
        _deployWithoutLp();
        vm.warp(10);
        _createOpenMarket(500_000);

        vm.expectRevert(abi.encodeWithSignature("Error(string)", "INSUFFICIENT_RESERVE"));
        user.buy(address(market), 1, 100 * 1e6, 10_000);
    }
}
