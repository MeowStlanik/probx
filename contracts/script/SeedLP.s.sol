// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/MockUSDC.sol";

contract SeedLP {
    function run(address usdc, address, address lp, uint256 amount) external {
        MockUSDC(usdc).mint(lp, amount);
    }
}
