// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/MockUSDC.sol";
import "../src/LiquidityPool.sol";
import "../src/InsuranceFund.sol";
import "../src/FeeRouter.sol";
import "../src/PositionTicket.sol";
import "../src/MicroBoostEngine.sol";
import "../src/MicroMarket.sol";
import "../src/MicroMarketFactory.sol";

contract UserActor {
    MockUSDC public immutable usdc;
    MicroBoostEngine public immutable engine;

    constructor(MockUSDC usdc_, MicroBoostEngine engine_) {
        usdc = usdc_;
        engine = engine_;
    }

    function approveEngine(uint256 amount) external {
        usdc.approve(address(engine), amount);
    }

    function buy(address market, uint8 outcome, uint256 riskAmount, uint256 boostBps)
        external
        returns (uint256)
    {
        return engine.buyTicket(market, outcome, riskAmount, boostBps);
    }
}

contract TestHarness {
    MockUSDC internal usdc;
    LiquidityPool internal pool;
    InsuranceFund internal insuranceFund;
    FeeRouter internal feeRouter;
    PositionTicket internal ticket;
    MicroBoostEngine internal engine;
    MicroMarketFactory internal factory;
    MicroMarket internal market;
    UserActor internal user;

    function _deploy() internal {
        _deployWithLp(1_000_000 * 1e6);
    }

    function _deployWithoutLp() internal {
        _deployWithLp(0);
    }

    function _deployWithLp(uint256 lpAmount) internal {
        usdc = new MockUSDC();
        pool = new LiquidityPool(address(usdc));
        insuranceFund = new InsuranceFund(address(usdc));
        feeRouter = new FeeRouter(address(usdc), address(pool), address(insuranceFund), address(this));
        ticket = new PositionTicket();
        engine = new MicroBoostEngine(address(usdc), address(pool), address(feeRouter), address(ticket));
        factory = new MicroMarketFactory(address(engine), address(this));
        pool.setEngine(address(engine));
        pool.setFeeRouter(address(feeRouter));
        insuranceFund.setEngine(address(engine));
        ticket.setEngine(address(engine));

        if (lpAmount > 0) {
            usdc.mint(address(this), lpAmount);
            usdc.approve(address(pool), type(uint256).max);
            pool.deposit(lpAmount);
        }

        user = new UserActor(usdc, engine);
        usdc.mint(address(user), 10_000 * 1e6);
        user.approveEngine(type(uint256).max);
    }

    function _createOpenMarket(uint256 yesPrice) internal returns (MicroMarket createdMarket) {
        address marketAddress = factory.createMarket(
            "Will the next demo signal be GREEN?",
            keccak256("demo-green"),
            10,
            20,
            20,
            50,
            yesPrice
        );
        createdMarket = MicroMarket(marketAddress);
        createdMarket.open();
        market = createdMarket;
    }
}
