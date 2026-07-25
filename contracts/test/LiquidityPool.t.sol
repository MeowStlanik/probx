// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// @title LiquidityPool suite (tests 13–14)
/// @notice Deposit/withdraw shares and withdraw blocked while reserved.
contract LiquidityPoolTest is MiniTest, TestHarness {
    /// @notice 13 — deposit mints shares; withdraw returns available assets
    function test_13_Lp_DepositMintsSharesAndWithdraw() external {
        _deploy();
        uint256 shares = pool.sharesOf(address(this));
        assertEq(shares, 1_000_000 * 1e6, "bad shares");
        uint256 assets = pool.withdraw(10_000 * 1e6);
        assertEq(assets, 10_000 * 1e6, "bad withdraw");
    }

    /// @notice 14 — no withdraw while any reserve is open (anti bank-run)
    function test_14_Lp_WithdrawBlockedByReservedAssets() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        user.buy(address(market), 1, 100 * 1e6, 20_000);

        // Even a tiny partial withdraw is blocked while reservedAssets > 0.
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "ACTIVE_EXPOSURE"));
        pool.withdraw(1);

        uint256 shares = pool.sharesOf(address(this));
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "ACTIVE_EXPOSURE"));
        pool.withdraw(shares);
    }

    /// @notice After reserve is fully released, withdraw works again.
    function test_15_Lp_WithdrawAfterReserveCleared() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 10_000);
        vm.warp(50);
        market.resolve(2); // NO wins → settle loss releases reserve
        engine.settleTicket(ticketId);
        assertEq(pool.reservedAssets(), 0, "reserve should be clear");
        uint256 out = pool.withdraw(1_000 * 1e6);
        assertTrue(out > 0, "withdraw after clear");
    }
}
