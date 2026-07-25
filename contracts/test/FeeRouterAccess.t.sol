// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// @notice Stranger that tries to call routeFee (audit I).
contract FeeRouterStranger {
    function tryRoute(FeeRouter router, uint256 amount) external {
        router.routeFee(amount);
    }
}

/// @notice Regression for audit I: routeFee is engine-only.
contract FeeRouterAccessTest is MiniTest, TestHarness {
    function test_22_RouteFee_OnlyEngine() external {
        _deploy();
        // Seed some USDC on the router so a successful route would move funds.
        usdc.mint(address(feeRouter), 1e6);

        FeeRouterStranger stranger = new FeeRouterStranger();
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "ONLY_ENGINE"));
        stranger.tryRoute(feeRouter, 1e6);

        // Engine path still works (via buy which calls routeFee).
        vm.warp(10);
        _createOpenMarket(500_000);
        user.buy(address(market), 1, 1e6, 10_000);
        assertTrue(feeRouter.totalFeesRouted() > 0, "engine must still route fees");
    }
}
