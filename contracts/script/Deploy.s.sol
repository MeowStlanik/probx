// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/MockUSDC.sol";
import "../src/LiquidityPool.sol";
import "../src/InsuranceFund.sol";
import "../src/FeeRouter.sol";
import "../src/PositionTicket.sol";
import "../src/MicroBoostEngine.sol";
import "../src/OracleAdapter.sol";
import "../src/MicroMarketFactory.sol";

/// @notice Local/anvil helper. Production Arc deploy uses `scripts/deploy-arc.mjs`.
///         Must wire marketRegistry + insurance feeRouter or buys/fees break.
contract Deploy {
    struct Deployment {
        MockUSDC usdc;
        LiquidityPool liquidityPool;
        InsuranceFund insuranceFund;
        FeeRouter feeRouter;
        PositionTicket positionTicket;
        MicroBoostEngine microBoostEngine;
        OracleAdapter oracleAdapter;
        MicroMarketFactory marketFactory;
    }

    function run(address treasury, address resolver) external returns (Deployment memory deployment) {
        deployment.usdc = new MockUSDC();
        deployment.liquidityPool = new LiquidityPool(address(deployment.usdc));
        deployment.insuranceFund = new InsuranceFund(address(deployment.usdc));
        deployment.feeRouter = new FeeRouter(
            address(deployment.usdc),
            address(deployment.liquidityPool),
            address(deployment.insuranceFund),
            treasury
        );
        deployment.positionTicket = new PositionTicket();
        deployment.microBoostEngine = new MicroBoostEngine(
            address(deployment.usdc),
            address(deployment.liquidityPool),
            address(deployment.feeRouter),
            address(deployment.positionTicket)
        );
        deployment.oracleAdapter = new OracleAdapter(resolver);
        deployment.marketFactory =
            new MicroMarketFactory(address(deployment.microBoostEngine), address(deployment.oracleAdapter));

        deployment.liquidityPool.setEngine(address(deployment.microBoostEngine));
        deployment.liquidityPool.setFeeRouter(address(deployment.feeRouter));
        deployment.feeRouter.setEngine(address(deployment.microBoostEngine));
        deployment.insuranceFund.setEngine(address(deployment.microBoostEngine));
        deployment.insuranceFund.setFeeRouter(address(deployment.feeRouter));
        deployment.positionTicket.setEngine(address(deployment.microBoostEngine));
        // Critical: only factory markets can trade against the LP.
        deployment.microBoostEngine.setMarketRegistry(address(deployment.marketFactory));
    }
}
