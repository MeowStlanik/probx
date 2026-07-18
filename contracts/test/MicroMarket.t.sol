// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

contract MicroMarketTest is MiniTest, TestHarness {
    function testLifecycleOpenLockResolveArchive() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(400_000);
        assertEq(uint256(market.status()), uint256(MicroMarket.Status.Open), "not open");

        vm.warp(20);
        market.lock();
        assertEq(uint256(market.status()), uint256(MicroMarket.Status.Locked), "not locked");
        market.resolve(1);
        assertEq(uint256(market.status()), uint256(MicroMarket.Status.Resolved), "not resolved");
        market.archive();
        assertEq(uint256(market.status()), uint256(MicroMarket.Status.Archived), "not archived");
    }

    function testCannotBuyOutsideOpenWindow() external {
        _deploy();
        vm.warp(9);
        _createOpenMarket(400_000);

        MicroBoostEngine.Quote memory quote = engine.quoteTicket(address(market), 1, 100 * 1e6, 10_000);
        assertTrue(quote.accepted, "quote should be arithmetic-only");

        vm.expectRevert(abi.encodeWithSignature("Error(string)", "MARKET_NOT_OPEN"));
        user.buy(address(market), 1, 100 * 1e6, 10_000);
    }

    function testBuyMovesYesPriceOnchain() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);

        uint256 yesBefore = market.yesPrice();
        uint256 noBefore = market.noPrice();
        // Mid 0.50 quoted with OVERROUND_BPS = 10_800 → 0.54 each side.
        assertEq(yesBefore, 540_000, "seed yes");
        assertEq(noBefore, 540_000, "seed no");

        // Small risk so LP reserve can accept the ticket.
        user.buy(address(market), 1, 1e6, 10_000);

        uint256 yesAfter = market.yesPrice();
        uint256 noAfter = market.noPrice();
        assertTrue(yesAfter > yesBefore, "YES buy must raise yesPrice");
        assertTrue(noAfter < noBefore, "YES buy must lower noPrice");
        assertEq(yesAfter + noAfter, 1_080_000, "prices must sum to overround scale");
        assertTrue(market.totalYesRisk() > 0, "yes risk tracked");
    }

    function testBuyNoMovesOddsOpposite() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);

        user.buy(address(market), 2, 1e6, 10_000);
        assertTrue(market.yesPrice() < 500_000, "NO buy lowers yesPrice");
        assertTrue(market.noPrice() > 500_000, "NO buy raises noPrice");
        assertTrue(market.totalNoRisk() > 0, "no risk tracked");
    }
}
