// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// @title LiquidityPool suite (tests 13–17)
/// @notice Deposit/withdraw shares; free capital stays withdrawable while reserved.
contract LiquidityPoolTest is MiniTest, TestHarness {
    /// @notice 13 — deposit mints shares; withdraw returns available assets
    function test_13_Lp_DepositMintsSharesAndWithdraw() external {
        _deploy();
        uint256 shares = pool.sharesOf(address(this));
        assertEq(shares, 1_000_000 * 1e6, "bad shares");
        uint256 assets = pool.withdraw(10_000 * 1e6);
        assertEq(assets, 10_000 * 1e6, "bad withdraw");
    }

    /// @notice 14 — tiny open reserve must NOT freeze the whole vault
    function test_14_Lp_FreeCapitalWithdrawableWhileReserved() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        user.buy(address(market), 1, 100 * 1e6, 20_000);

        uint256 reserved = pool.reservedAssets();
        assertTrue(reserved > 0, "need open reserve");
        uint256 available = pool.availableAssets();
        assertTrue(available > 0, "free capital must remain");

        // Small withdraw of free capital succeeds (share NAV may include fees/risk).
        uint256 out = pool.withdraw(1_000 * 1e6);
        assertTrue(out > 0, "free withdraw");
        assertTrue(out <= available, "did not pull reserved");
        assertEq(pool.reservedAssets(), reserved, "reserve untouched");
    }

    /// @notice Full share burn that would pull reserved capital reverts.
    function test_14b_Lp_CannotWithdrawThroughReserve() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        user.buy(address(market), 1, 100 * 1e6, 20_000);

        uint256 shares = pool.sharesOf(address(this));
        // 100% of shares prices against managed (includes reserved) → exceeds available.
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "INSUFFICIENT_AVAILABLE"));
        pool.withdraw(shares);
    }

    /// @notice After reserve is fully released, full withdraw works again.
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

    /// @notice Late deposit allowed while reserved — capital is free liquidity.
    function test_16_Lp_DepositAllowedWhileReserved() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        user.buy(address(market), 1, 100 * 1e6, 10_000);
        assertTrue(pool.reservedAssets() > 0, "need open reserve");

        uint256 reservedBefore = pool.reservedAssets();
        uint256 availableBefore = pool.availableAssets();
        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(pool), type(uint256).max);
        uint256 minted = pool.deposit(100e6);
        assertTrue(minted > 0, "deposit while reserved");
        assertEq(pool.reservedAssets(), reservedBefore, "reserve unchanged");
        assertEq(pool.availableAssets(), availableBefore + 100e6, "free capital grew");
    }

    /// @notice Deposit works again after reserve is released.
    function test_17_Lp_DepositAfterReserveCleared() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 10_000);
        vm.warp(50);
        market.resolve(2);
        engine.settleTicket(ticketId);
        assertEq(pool.reservedAssets(), 0, "reserve clear");

        usdc.mint(address(this), 500e6);
        usdc.approve(address(pool), type(uint256).max);
        uint256 minted = pool.deposit(500e6);
        assertTrue(minted > 0, "deposit after clear");
    }
}
