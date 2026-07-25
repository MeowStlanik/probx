// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// resolve() must wait for observationEnd, not observationStart.
contract ObservationResolveTest is MiniTest, TestHarness {
    function test_20_Resolve_RevertsBeforeObservationEnd() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);

        // At observationStart (20) resolve must fail.
        vm.warp(20);
        vm.expectRevert(bytes("OBSERVATION_NOT_ENDED"));
        market.resolve(1);

        // One second before end still fails.
        vm.warp(49);
        vm.expectRevert(bytes("OBSERVATION_NOT_ENDED"));
        market.resolve(1);

        // At observationEnd succeeds.
        vm.warp(50);
        market.resolve(1);
        assertEq(uint256(market.status()), uint256(MicroMarket.Status.Resolved), "not resolved");
        assertEq(uint256(market.winningOutcome()), 1, "bad outcome");
    }
}
