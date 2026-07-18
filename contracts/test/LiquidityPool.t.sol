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

    /// @notice 14 — cannot withdraw shares while capital is reserved for tickets
    function test_14_Lp_WithdrawBlockedByReservedAssets() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        user.buy(address(market), 1, 100 * 1e6, 20_000);

        uint256 shares = pool.sharesOf(address(this));
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "RESERVED"));
        pool.withdraw(shares);
    }
}
