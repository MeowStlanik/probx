// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";
import "../src/libraries/RiskLimits.sol";

/// @dev Non-owner caller for access-control checks (MiniTest has no prank).
contract InsuranceAttacker {
    function tryWithdraw(InsuranceFund fund, address to, uint256 amount) external {
        fund.withdraw(to, amount);
    }
}

/// @title Audit-fix suite (tests 15–18)
/// @notice Covers the post-audit contract changes:
///         15–16: InsuranceFund.withdraw (fees no longer locked forever; owner-only)
///         17:    quoteTicket.maxAvailableBoostBps clamped to protocol cap
///         18:    core Micro Boost invariant — LP loses exactly the reserve on a win
contract FixesTest is MiniTest, TestHarness {
    /// @notice 15 — insurance fees accrue on buys and the owner can withdraw them.
    ///         Before the fix, coverShortfall (onlyEngine, never called) was the only
    ///         exit, so 20% of every ticket fee was locked in the contract forever.
    function test_15_Insurance_OwnerCanWithdrawAccruedFees() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        user.buy(address(market), 1, 100 * 1e6, 20_000);

        uint256 accrued = usdc.balanceOf(address(insuranceFund));
        assertTrue(accrued > 0, "insurance fees did not accrue on buy");

        address sink = address(0xFEE5);
        insuranceFund.withdraw(sink, accrued);
        assertEq(usdc.balanceOf(address(insuranceFund)), 0, "fund not emptied");
        assertEq(usdc.balanceOf(sink), accrued, "withdrawn amount mismatch");
    }

    /// @notice 16 — withdraw is owner-only: a stranger cannot drain the fund.
    function test_16_Insurance_WithdrawRevertsForNonOwner() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);
        user.buy(address(market), 1, 100 * 1e6, 20_000);

        InsuranceAttacker attacker = new InsuranceAttacker();
        uint256 accrued = usdc.balanceOf(address(insuranceFund));
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "ONLY_OWNER"));
        attacker.tryWithdraw(insuranceFund, address(attacker), accrued);
    }

    /// @notice 17 — quoteTicket must never advertise a boost above the protocol cap.
    ///         With a huge LP and a tiny stake, raw QuoteMath.maxBoostBps is far above
    ///         5x; before the fix the Quote struct returned that raw value while
    ///         buyTicket would reject anything above MAX_BOOST_BPS with BOOST_CAP.
    function test_17_Quote_MaxBoostClampedToProtocolCap() external {
        _deploy(); // 1,000,000 USDC LP vs 1 USDC risk => raw max boost >> 5x
        vm.warp(10);
        _createOpenMarket(500_000);

        MicroBoostEngine.Quote memory quote = engine.quoteTicket(address(market), 1, 1e6, 10_000);
        assertTrue(quote.accepted, "baseline quote should be accepted");
        assertEq(
            quote.maxAvailableBoostBps,
            RiskLimits.MAX_BOOST_BPS,
            "quote must clamp max boost to protocol cap"
        );
        // Consistency: the standalone getter must agree with the quote field.
        assertEq(
            engine.maxAvailableBoost(address(market), 1, 1e6),
            quote.maxAvailableBoostBps,
            "getter and quote field disagree"
        );
    }

    /// @notice 18 — core Micro Boost economics: on a winning ticket the LP's net USDC
    ///         loss equals exactly the reserved amount (payout − stake), no more, no
    ///         less. This is the invariant the whole reserve model rests on; tests
    ///         05/07 check reserve bookkeeping and the user's payout but never assert
    ///         the pool-side delta directly.
    function test_18_Lp_NetLossOnWinEqualsReserve() external {
        _deploy();
        vm.warp(10);
        _createOpenMarket(500_000);

        uint256 poolBefore = usdc.balanceOf(address(pool));
        uint256 ticketId = user.buy(address(market), 1, 100 * 1e6, 20_000);
        PositionTicket.Ticket memory position = ticket.getTicket(ticketId);

        vm.warp(20);
        market.resolve(1);
        engine.settleTicket(ticketId);

        uint256 poolAfter = usdc.balanceOf(address(pool));
        // Buy adds stake, fee routing adds the LP fee share, win pays out full payout:
        // net = stake + lpFeeShare − payout = lpFeeShare − reserve.
        uint256 lpFeeShare = (position.fee * feeRouter.lpShareBps()) / feeRouter.BPS();
        assertEq(
            poolBefore + lpFeeShare - poolAfter,
            position.reservedAmount,
            "LP net loss on win must equal reserved amount"
        );
        // And nothing stays locked or reserved afterwards.
        assertEq(pool.reservedAssets(), 0, "reserve not fully released");
        assertEq(pool.lockedUserRisk(), 0, "risk not fully unlocked");
    }
}
