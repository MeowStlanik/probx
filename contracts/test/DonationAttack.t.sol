// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MiniTest.sol";
import "./TestHarness.sol";

/// Direct USDC transfer to the pool must not inflate share price (internalAssets ledger).
contract DonationAttackTest is MiniTest, TestHarness {
    function test_21_Donation_DoesNotInflateSharePrice() external {
        _deployWithLp(1_000 * 1e6);

        uint256 managedBefore = pool.managedAssets();
        uint256 sharesBefore = pool.totalShares();
        assertEq(managedBefore, 1_000 * 1e6, "seed managed");
        assertEq(sharesBefore, 1_000 * 1e6, "seed shares");

        // Attacker donates 100 USDC straight to the pool.
        usdc.mint(address(this), 100 * 1e6);
        require(usdc.transfer(address(pool), 100 * 1e6), "donate");

        // Token balance rose, but managedAssets / internal ledger did not.
        assertEq(usdc.balanceOf(address(pool)), 1_100 * 1e6, "balance should include donation");
        assertEq(pool.managedAssets(), managedBefore, "managedAssets inflated by donation");
        assertEq(pool.internalAssets(), managedBefore, "internalAssets inflated");

        // Next depositor still mints 1:1 against un-inflated book.
        usdc.mint(address(this), 100 * 1e6);
        usdc.approve(address(pool), 100 * 1e6);
        uint256 minted = pool.deposit(100 * 1e6);
        assertEq(minted, 100 * 1e6, "depositor shares inflated by donation");
    }
}
