// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

contract LiquidityPoolTest is MiniTest, TestHarness {
    function testDepositMintsSharesAndWithdrawReturnsAvailableAssets() external {
        _deploy();
        uint256 shares = pool.sharesOf(address(this));
        assertEq(shares, 1_000_000 * 1e6, "bad shares");
        uint256 assets = pool.withdraw(10_000 * 1e6);
        assertEq(assets, 10_000 * 1e6, "bad withdraw");
    }

    function testWithdrawBlockedByReservedAssets() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        user.buy(address(market), 1, 100 * 1e6, 20_000);

        uint256 shares = pool.sharesOf(address(this));
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "RESERVED"));
        pool.withdraw(shares);
    }
}
