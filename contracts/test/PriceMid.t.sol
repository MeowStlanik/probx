// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// @notice Regression for audit C: round-trip mid via clamp-saturated yesPrice inverted the book.
///         Seed mid near the rail; large YES buy then min-size YES buy must not raise noPrice.
contract PriceMidTest is MiniTest, TestHarness {
    /// @notice After YES buys near the MAX_PRICE rail, noPrice must be monotonically non-increasing.
    function test_20_YesBuysNearRail_DoNotRaiseNoPrice() external {
        // Large LP so 100 USDC YES + reserve is accepted near expensive odds.
        _deployWithLp(500_000 * 1e6);
        vm.warp(10);
        // Fair mid 92¢ — quoted yes would be 99.36¢ without the old quote clamp.
        MicroMarket m = _createOpenMarket(920_000);

        uint256 mid0 = m.fairMidYes();
        assertEq(mid0, 920_000, "seed mid");
        // Quoted = mid × 1.08 (no secondary clamp on yesPrice).
        assertEq(m.yesPrice(), (920_000 * 10_800) / 10_000, "seed yes quote");
        uint256 no0 = m.noPrice();

        // Large YES buy saturates mid toward MAX_PRICE.
        user.buy(address(m), 1, 100 * 1e6, 10_000);
        uint256 noAfterLarge = m.noPrice();
        uint256 midAfterLarge = m.fairMidYes();
        assertTrue(midAfterLarge >= mid0, "YES buy must not lower mid");
        assertTrue(noAfterLarge <= no0, "YES buy must not raise noPrice");

        // Series of min-size YES buys must keep noPrice non-increasing (old bug: no jumped up).
        uint256 prevNo = noAfterLarge;
        for (uint256 i = 0; i < 8; i++) {
            user.buy(address(m), 1, 250_000, 10_000); // MIN_USER_RISK_PER_TICKET
            uint256 noNow = m.noPrice();
            assertTrue(
                noNow <= prevNo,
                "min-size YES buy raised noPrice (mid round-trip broken)"
            );
            prevNo = noNow;
        }

        // Mid stays at/near rail. Near the rail quoted YES is clipped to PRICE_SCALE-1
        // for QuoteMath, so sum may be < overround — that is intentional.
        assertTrue(m.fairMidYes() >= midAfterLarge, "mid must not regress on YES buys");
        assertTrue(m.yesPrice() >= m.noPrice(), "YES side still expensive after YES flow");
    }

    /// @notice Probe matching audit numbers: after large YES, dust YES must not invert no.
    function test_21_AuditProbe_YesThenMinYes_NoDoesNotJump() external {
        _deployWithLp(500_000 * 1e6);
        vm.warp(10);
        MicroMarket m = _createOpenMarket(920_000);

        user.buy(address(m), 1, 100 * 1e6, 10_000);
        uint256 noAfter100 = m.noPrice();
        user.buy(address(m), 1, 250_000, 10_000);
        uint256 noAfterMin = m.noPrice();

        // Pre-fix: no went 54_000 → 128_677. Post-fix: no is flat or lower.
        assertTrue(noAfterMin <= noAfter100, "noPrice jumped after min YES (audit C)");
    }

    /// @notice Same defect, asserted through the pre-fix surface only.
    /// @dev test_20/test_21 read `fairMidYes()` and go through TestHarness, so against the
    ///      pre-fix contract they fail to *compile* rather than fail an assertion — which
    ///      proves coupling to the new API, not that the old behaviour is caught. This one
    ///      drives MicroMarket directly and touches only yesPrice/noPrice, so it compiles
    ///      against both versions and goes red on the old algorithm with the audit numbers.
    function test_22_RailInversion_PreFixSurfaceOnly() external {
        vm.warp(10);
        MicroMarket m = new MicroMarket(
            address(this), // owner
            address(this), // engine — lets this test call applyTradeImpact directly
            address(this), // oracle
            "rail probe",
            bytes32(0),
            uint64(10),
            uint64(1000),
            uint64(1000),
            uint64(2000),
            920_000
        );
        m.open();

        // Saturate the book toward the MAX_PRICE rail, then nudge it with a min-size buy.
        m.applyTradeImpact(1, 100_000_000);
        uint256 noAtRail = m.noPrice();
        m.applyTradeImpact(1, 250_000);
        uint256 noAfterMin = m.noPrice();

        // Old algorithm: 54_000 → 128_677 (buying YES made NO 2.4× more expensive).
        assertTrue(
            noAfterMin <= noAtRail,
            "buying YES raised noPrice at the rail (audit C, pre-fix surface)"
        );
    }
}
