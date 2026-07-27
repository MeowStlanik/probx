// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// @notice Regression for audit P0-1: the book could be walked to the MIN_PRICE rail
///         with minimum-size tickets, after which the attacker bought the other side
///         at a price far below fair value and extracted LP capital.
///
/// @dev Every assertion here is written against surface that exists both before and
///      after the fix (fairMidYes / yesPrice / noPrice / quoteTicket), so these tests
///      fail on an *assertion* against the vulnerable contract rather than failing to
///      compile. A test that only fails to compile proves nothing.
contract BookManipulationTest is MiniTest, TestHarness {
    uint8 internal constant YES = 1;
    uint8 internal constant NO = 2;
    uint256 internal constant MIN_TICKET = 250_000; // RiskLimits.MIN_USER_RISK_PER_TICKET
    uint256 internal constant SCALE = 1e6;

    function _mod(uint256 x, uint256 n) internal pure returns (uint256) {
        return n == 0 ? 0 : x % n;
    }

    /// @notice The exact attack from the audit: 11 tickets of 0.25 USDC (2.75 USDC of
    ///         total risk) walked fair mid from 50% to the 5% floor, so YES quoted 5.4%.
    ///         The book must never quote a side below its seed fair value.
    function test_23_MinTicketsCannotWalkBookToRail() external {
        _deployWithLp(100_000 * 1e6);
        vm.warp(10);
        uint256 seedMid = 500_000;
        MicroMarket m = _createOpenMarket(seedMid);
        assertEq(m.fairMidYes(), seedMid, "seed mid");

        // 11 minimum-size NO tickets — 2.75 USDC of risk in total.
        for (uint256 i = 0; i < 11; i++) {
            user.buy(address(m), NO, MIN_TICKET, 10_000);
        }

        // Pre-fix this lands at fairMidYes == 50_000 and yesPrice == 54_000.
        assertTrue(
            m.yesPrice() >= seedMid,
            "2.75 USDC of dust walked YES below its seed fair value"
        );
        assertTrue(
            m.noPrice() >= SCALE - seedMid,
            "NO quoted below its seed fair value"
        );
    }

    /// @notice The economic consequence, stated directly: after any amount of one-sided
    ///         flow, entering the opposite side at 1x boost must still be non-positive EV
    ///         when measured against the seed probability. Overround is what pays for the
    ///         book; a book that can be pushed past its own margin is a free money printer.
    function test_24_NoPositiveEvEntryAfterOneSidedFlow() external {
        _deployWithLp(100_000 * 1e6);
        vm.warp(10);
        uint256 seedMid = 500_000;
        MicroMarket m = _createOpenMarket(seedMid);

        for (uint256 i = 0; i < 11; i++) {
            user.buy(address(m), NO, MIN_TICKET, 10_000);
        }

        uint256 risk = 100 * 1e6; // RiskLimits.MAX_USER_RISK_PER_TICKET
        MicroBoostEngine.Quote memory q = engine.quoteTicket(address(m), YES, risk, 10_000);

        // EV = payout × P(seed) − risk. Require EV ≤ 0, i.e. payout × seedMid ≤ risk × SCALE.
        // Pre-fix: payout ≈ 1851 USDC → EV ≈ +826 USDC on a single ticket.
        assertTrue(
            q.payout * seedMid <= risk * SCALE,
            "positive-EV entry available after walking the book"
        );
    }

    /// @notice Same invariant under arbitrary two-sided flow, arbitrary sizes, arbitrary seed.
    ///         The pricing engine had no fuzz coverage at all — the bug lived exactly there.
    function testFuzz_bookNeverQuotesBelowSeedFair(uint256 seed) external {
        _deployWithLp(100_000 * 1e6);
        vm.warp(10);

        // Seed mid anywhere in [MIN_PRICE, MAX_PRICE].
        uint256 seedMid = 50_000 + _mod(seed, 900_001);
        MicroMarket m = _createOpenMarket(seedMid);

        uint256 s = seed;
        uint256 spent;
        for (uint256 i = 0; i < 12; i++) {
            s = uint256(keccak256(abi.encode(s, i)));
            uint8 outcome = (s & 1) == 0 ? YES : NO;
            // Any legal ticket size: [MIN_USER_RISK_PER_TICKET, MAX_USER_RISK_PER_TICKET].
            uint256 risk = MIN_TICKET + _mod(s >> 8, 100 * 1e6 - MIN_TICKET + 1);
            // Actor was minted 10_000 USDC; leave headroom for fees.
            if (spent + risk > 8_000 * 1e6) break;
            spent += risk;

            MicroBoostEngine.Quote memory q = engine.quoteTicket(address(m), outcome, risk, 10_000);
            if (!q.accepted) continue;
            user.buy(address(m), outcome, risk, 10_000);

            assertTrue(m.yesPrice() >= seedMid, "YES quoted below seed fair value");
            assertTrue(m.noPrice() >= SCALE - seedMid, "NO quoted below seed fair value");
        }
    }

    /// @notice Odds must move against the capital underwriting them, not against a fixed
    ///         2 USDC constant. The same trade into a 10x deeper pool must move mid less.
    function test_25_BookDepthScalesWithPoolCapital() external {
        uint256 risk = 100 * 1e6;

        _deployWithLp(100_000 * 1e6);
        vm.warp(10);
        MicroMarket small = _createOpenMarket(500_000);
        user.buy(address(small), YES, risk, 10_000);
        uint256 shallowMove = small.fairMidYes() - 500_000;

        _deployWithLp(1_000_000 * 1e6);
        vm.warp(10);
        MicroMarket deep = _createOpenMarket(500_000);
        user.buy(address(deep), YES, risk, 10_000);
        uint256 deepMove = deep.fairMidYes() - 500_000;

        assertTrue(shallowMove > 0, "trade must still move the book");
        assertTrue(
            deepMove < shallowMove,
            "book depth ignores pool capital: same trade moves a 10x deeper book equally"
        );
    }
}
