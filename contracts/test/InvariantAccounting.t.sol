// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "../src/MockUSDC.sol";
import "../src/LiquidityPool.sol";

/// @title Vault accounting invariants + fuzz coverage
/// @notice Direct engine/feeRouter = this contract so we can fuzz pool bookkeeping
///         without the full market stack. Guards:
///         1) reservedAssets + lockedUserRisk <= internalAssets
///         2) availableAssets = internal - locked - reserved (identity)
///         3) withdraw never spends reserved liquidity
///         4) settlement paths never drive accounting below zero (reverts instead)
contract InvariantAccountingTest is MiniTest {
    MockUSDC internal usdc;
    LiquidityPool internal pool;

    uint256 internal constant SEED_LP = 1_000_000 * 1e6;

    function setUp() public {
        usdc = new MockUSDC();
        pool = new LiquidityPool(address(usdc));
        pool.setEngine(address(this));
        pool.setFeeRouter(address(this));
        usdc.mint(address(this), type(uint128).max);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(SEED_LP);
        _assertCoreInvariants();
    }

    // ─── Invariant helpers ───────────────────────────────────────────────────

    /// @dev Core bookkeeping identities that must hold after every successful op.
    function _assertCoreInvariants() internal view {
        uint256 internalAssets = pool.internalAssets();
        uint256 reserved = pool.reservedAssets();
        uint256 locked = pool.lockedUserRisk();
        uint256 managed = pool.managedAssets();
        uint256 available = pool.availableAssets();

        // Outstanding reserves + locked risk never exceed the accounting ledger.
        require(reserved + locked <= internalAssets, "INV: reserved+locked > internal");

        // managedAssets = internalAssets - lockedUserRisk
        require(managed == internalAssets - locked, "INV: managed mismatch");

        // availableAssets = internal - locked - reserved  (never underflows: checked above)
        require(available == internalAssets - locked - reserved, "INV: available mismatch");

        // reserved is always fully collateralised by LP equity (managed assets).
        // reserved <= managed  ⇔  reserved + locked <= internal  (same as first check)
        require(reserved <= managed, "INV: reserved > managed");

        // Share supply consistency when empty
        if (pool.totalShares() == 0) {
            require(managed == 0 || locked > 0, "INV: empty shares with managed equity");
        }
    }

    function _mod(uint256 x, uint256 m) internal pure returns (uint256) {
        if (m == 0) return 0;
        return x % m;
    }

    // ─── Explicit invariant unit checks ──────────────────────────────────────

    function test_invariant_seedState() external view {
        _assertCoreInvariants();
        assertEq(pool.availableAssets(), SEED_LP, "seed available");
        assertEq(pool.reservedAssets(), 0, "seed reserved");
        assertEq(pool.lockedUserRisk(), 0, "seed locked");
    }

    function test_invariant_reserveThenRelease() external {
        pool.reserveForTicket(100e6);
        _assertCoreInvariants();
        pool.releaseReserve(100e6);
        _assertCoreInvariants();
        assertEq(pool.reservedAssets(), 0, "released");
    }

    function test_invariant_winSettlementDoesNotUnderflow() external {
        // Simulate buy: lock user risk + reserve max LP payout.
        uint256 risk = 50e6;
        uint256 reserve = 150e6; // payout = 200e6
        pool.lockUserRisk(risk);
        // Risk USDC is already "in" internal via lockUserRisk accounting; mint+transfer to pool for realism.
        usdc.transfer(address(pool), risk);
        pool.reserveForTicket(reserve);
        _assertCoreInvariants();

        address winner = address(0xBEEF);
        pool.payPayout(winner, risk + reserve, reserve, risk);
        _assertCoreInvariants();
        assertEq(pool.reservedAssets(), 0, "reserve cleared");
        assertEq(pool.lockedUserRisk(), 0, "risk cleared");
        assertEq(usdc.balanceOf(winner), risk + reserve, "winner paid");
    }

    function test_invariant_lossSettlementDoesNotUnderflow() external {
        uint256 risk = 40e6;
        uint256 reserve = 80e6;
        pool.lockUserRisk(risk);
        usdc.transfer(address(pool), risk);
        pool.reserveForTicket(reserve);
        _assertCoreInvariants();

        pool.settleLoss(risk, reserve);
        _assertCoreInvariants();
        assertEq(pool.reservedAssets(), 0, "reserve cleared");
        assertEq(pool.lockedUserRisk(), 0, "risk cleared");
        assertEq(pool.totalUserLossesReceived(), risk, "loss retained");
    }

    function test_invariant_withdrawBlockedWhenFullyReserved() external {
        uint256 avail = pool.availableAssets();
        pool.reserveForTicket(avail);
        _assertCoreInvariants();
        // All capital is reserved → available == 0 → any withdraw fails.
        assertEq(pool.availableAssets(), 0, "no free capital");
        uint256 shares = pool.sharesOf(address(this));
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "INSUFFICIENT_AVAILABLE"));
        pool.withdraw(shares);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "INSUFFICIENT_AVAILABLE"));
        pool.withdraw(1);
        _assertCoreInvariants();
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────

    /// @notice reservedAssets never exceeds available capacity at reserve time,
    ///         and post-state always satisfies reserved <= managed.
    function testFuzz_reserveWithinAvailable(uint256 amountSeed) external {
        uint256 avail = pool.availableAssets();
        if (avail == 0) return;
        uint256 amount = _mod(amountSeed, avail) + 1; // 1..avail
        pool.reserveForTicket(amount);
        _assertCoreInvariants();
        assertTrue(pool.reservedAssets() >= amount, "reserve not applied");
    }

    /// @notice Over-reserve always reverts and leaves state untouched.
    function testFuzz_overReserveReverts(uint256 excessSeed) external {
        uint256 avail = pool.availableAssets();
        uint256 beforeR = pool.reservedAssets();
        uint256 beforeI = pool.internalAssets();
        uint256 amount = avail + 1 + _mod(excessSeed, 1_000_000e6);
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "INSUFFICIENT_RESERVE"));
        pool.reserveForTicket(amount);
        assertEq(pool.reservedAssets(), beforeR, "state mutated on revert");
        assertEq(pool.internalAssets(), beforeI, "internal mutated on revert");
        _assertCoreInvariants();
    }

    /// @notice Free capital remains withdrawable; only pulls through reserved revert.
    function testFuzz_withdrawRespectsAvailableWhileReserved(uint256 reserveSeed, uint256 shareSeed)
        external
    {
        uint256 avail = pool.availableAssets();
        if (avail < 2) return;
        uint256 reserveAmt = _mod(reserveSeed, avail / 2) + 1;
        pool.reserveForTicket(reserveAmt);
        _assertCoreInvariants();

        uint256 free = pool.availableAssets();
        uint256 managed = pool.managedAssets();
        uint256 shares = pool.sharesOf(address(this));
        if (shares == 0 || managed == 0) return;

        // Shares that price to at most free capital must succeed.
        uint256 maxFreeShares = (free * shares) / managed;
        if (maxFreeShares > 0) {
            uint256 tryFree = _mod(shareSeed, maxFreeShares) + 1;
            if (tryFree > maxFreeShares) tryFree = maxFreeShares;
            uint256 out = pool.withdraw(tryFree);
            assertTrue(out > 0, "free withdraw");
            assertTrue(pool.reservedAssets() >= reserveAmt, "reserve ring-fenced");
            _assertCoreInvariants();
        }

        // Full remaining shares (would claim through reserve) must revert.
        uint256 left = pool.sharesOf(address(this));
        if (left > 0 && pool.reservedAssets() > 0) {
            uint256 claim = (left * pool.managedAssets()) / pool.totalShares();
            if (claim > pool.availableAssets()) {
                vm.expectRevert(abi.encodeWithSignature("Error(string)", "INSUFFICIENT_AVAILABLE"));
                pool.withdraw(left);
            }
        }
        _assertCoreInvariants();
    }

    /// @notice Full win settlement: payout = risk + reserve; accounting never goes negative.
    function testFuzz_payPayoutAccounting(uint256 riskSeed, uint256 reserveSeed) external {
        uint256 avail = pool.availableAssets();
        if (avail < 10e6) return;

        uint256 risk = _mod(riskSeed, 100e6) + 1e6; // 1..100 USDC
        uint256 maxReserve = avail > 500e6 ? 500e6 : avail;
        if (maxReserve == 0) return;
        uint256 reserve = _mod(reserveSeed, maxReserve) + 1;

        // Ensure we still have room after locking risk accounting
        if (reserve > pool.availableAssets()) reserve = pool.availableAssets();
        if (reserve == 0) return;

        pool.lockUserRisk(risk);
        usdc.transfer(address(pool), risk);
        // Re-check available after lock (lock doesn't reduce available: internal+=risk, locked+=risk)
        if (reserve > pool.availableAssets()) {
            reserve = pool.availableAssets();
        }
        if (reserve == 0) {
            // unwind risk so later tests in same process aren't poisoned — single-test isolation is fine
            return;
        }
        pool.reserveForTicket(reserve);
        _assertCoreInvariants();

        uint256 payout = risk + reserve;
        address to = address(uint160(0xA11CE));
        pool.payPayout(to, payout, reserve, risk);
        _assertCoreInvariants();
        assertEq(usdc.balanceOf(to), payout, "payout transfer");
        assertEq(pool.reservedAssets(), 0, "reserve residual");
        assertEq(pool.lockedUserRisk(), 0, "risk residual");
    }

    /// @notice Loss settlement releases reserve and keeps risk as LP equity.
    function testFuzz_settleLossAccounting(uint256 riskSeed, uint256 reserveSeed) external {
        uint256 avail = pool.availableAssets();
        if (avail < 10e6) return;

        uint256 risk = _mod(riskSeed, 100e6) + 1e6;
        uint256 reserve = _mod(reserveSeed, avail) + 1;
        if (reserve > pool.availableAssets()) reserve = pool.availableAssets();
        if (reserve == 0) return;

        uint256 internalBefore = pool.internalAssets();
        pool.lockUserRisk(risk);
        usdc.transfer(address(pool), risk);
        pool.reserveForTicket(reserve);
        _assertCoreInvariants();

        pool.settleLoss(risk, reserve);
        _assertCoreInvariants();
        // Risk stays in internalAssets as LP equity
        assertEq(pool.internalAssets(), internalBefore + risk, "risk not retained");
        assertEq(pool.reservedAssets(), 0, "reserve residual");
        assertEq(pool.lockedUserRisk(), 0, "risk residual");
    }

    /// @notice Refund path: user gets risk back; reserve released; no underflow.
    function testFuzz_refundRiskAccounting(uint256 riskSeed, uint256 reserveSeed) external {
        uint256 avail = pool.availableAssets();
        if (avail < 10e6) return;

        uint256 risk = _mod(riskSeed, 100e6) + 1e6;
        uint256 reserve = _mod(reserveSeed, avail) + 1;
        if (reserve > pool.availableAssets()) reserve = pool.availableAssets();
        if (reserve == 0) return;

        pool.lockUserRisk(risk);
        usdc.transfer(address(pool), risk);
        pool.reserveForTicket(reserve);
        _assertCoreInvariants();

        address user = address(uint160(0xCAFE));
        uint256 before = usdc.balanceOf(user);
        pool.refundRisk(user, risk, reserve);
        _assertCoreInvariants();
        assertEq(usdc.balanceOf(user), before + risk, "refund");
        assertEq(pool.reservedAssets(), 0, "reserve residual");
        assertEq(pool.lockedUserRisk(), 0, "risk residual");
    }

    /// @notice Random op sequence keeps invariants (bounded stateful fuzz).
    function testFuzz_opSequence(uint256 seed) external {
        uint256 s = seed;
        for (uint256 i = 0; i < 8; i++) {
            s = uint256(keccak256(abi.encode(s, i)));
            uint256 op = s % 5;
            uint256 avail = pool.availableAssets();
            if (op == 0 && avail > 1e6) {
                // reserve some
                uint256 amt = _mod(s >> 8, avail / 2) + 1;
                pool.reserveForTicket(amt);
            } else if (op == 1 && pool.reservedAssets() > 0) {
                uint256 r = pool.reservedAssets();
                uint256 rel = _mod(s >> 16, r) + 1;
                pool.releaseReserve(rel);
            } else if (op == 2 && pool.reservedAssets() == 0) {
                // deposit more LP (blocked while exposure open)
                uint256 dep = _mod(s >> 24, 10_000e6) + 1e6;
                pool.deposit(dep);
            } else if (
                op == 3 && pool.reservedAssets() == 0 && pool.sharesOf(address(this)) > 0
                    && pool.availableAssets() > 1e6
            ) {
                uint256 sh = pool.sharesOf(address(this));
                uint256 trySh = _mod(s >> 32, sh / 4 + 1) + 1;
                if (trySh > sh) trySh = sh;
                uint256 assetsOut = (trySh * pool.managedAssets()) / pool.totalShares();
                if (assetsOut <= pool.availableAssets() && assetsOut > 0) {
                    pool.withdraw(trySh);
                }
            } else if (op == 4 && avail > 5e6) {
                // mini ticket: lock + reserve + settle loss
                uint256 risk = 1e6;
                uint256 res = _mod(s >> 40, avail / 4) + 1;
                pool.lockUserRisk(risk);
                usdc.transfer(address(pool), risk);
                if (res > pool.availableAssets()) res = pool.availableAssets();
                if (res > 0) {
                    pool.reserveForTicket(res);
                    pool.settleLoss(risk, res);
                }
            }
            _assertCoreInvariants();
        }
    }
}
