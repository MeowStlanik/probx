// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MicroMarket.sol";
import "./PositionTicket.sol";
import "./LiquidityPool.sol";
import "./FeeRouter.sol";
import "./libraries/QuoteMath.sol";
import "./libraries/RiskLimits.sol";

interface IERC20LikeForEngine {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract MicroBoostEngine {
    using QuoteMath for uint256;

    uint8 private constant OUTCOME_YES = 1;
    uint8 private constant OUTCOME_NO = 2;

    struct Quote {
        uint256 price;
        uint256 payout;
        uint256 requiredReserve;
        uint256 fee;
        uint256 totalDebit;
        uint256 maxAvailableBoostBps;
        bool accepted;
        string reason;
    }

    struct MarketExposure {
        uint256 totalUserRisk;
        uint256 payoutIfYes;
        uint256 payoutIfNo;
        uint256 reserveIfYes;
        uint256 reserveIfNo;
        uint256 lpReserveAllocated;
    }

    uint256 public constant BPS = 10_000;
    uint256 public constant BASE_FEE_BPS = 30;
    /// @dev Per unit of boost above 1x (was 40 = 0.4%). Order-of-magnitude higher so
    ///      boost is funded by fee income / book margin, not free LP risk.
    uint256 public constant BOOST_FEE_BPS = 400;

    IERC20LikeForEngine public immutable usdc;
    LiquidityPool public liquidityPool;
    FeeRouter public feeRouter;
    PositionTicket public positionTicket;
    address public owner;
    bool public paused;

    mapping(address => MarketExposure) public marketExposure;
    mapping(address => uint256) public userReserveUsed;

    event PausedSet(bool paused);
    event TicketBought(
        uint256 indexed ticketId,
        address indexed buyer,
        address indexed market,
        uint8 outcome,
        uint256 riskAmount,
        uint256 boostBps,
        uint256 payout,
        uint256 reserve
    );
    event TicketSettled(uint256 indexed ticketId, bool won, uint256 amount);
    event TicketCancelled(uint256 indexed ticketId, uint256 refunded);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier notPaused() {
        require(!paused, "PAUSED");
        _;
    }

    constructor(address usdc_, address liquidityPool_, address feeRouter_, address positionTicket_) {
        require(usdc_ != address(0), "ZERO_USDC");
        require(liquidityPool_ != address(0), "ZERO_POOL");
        require(feeRouter_ != address(0), "ZERO_ROUTER");
        require(positionTicket_ != address(0), "ZERO_TICKET");
        usdc = IERC20LikeForEngine(usdc_);
        liquidityPool = LiquidityPool(liquidityPool_);
        feeRouter = FeeRouter(feeRouter_);
        positionTicket = PositionTicket(positionTicket_);
        owner = msg.sender;
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function quoteTicket(address market, uint8 outcome, uint256 riskAmount, uint256 boostBps)
        public
        view
        returns (Quote memory quote)
    {
        if (riskAmount == 0) {
            return _rejectedQuote("ZERO_RISK");
        }
        if (riskAmount > RiskLimits.MAX_USER_RISK_PER_TICKET) {
            return _rejectedQuote("RISK_CAP");
        }
        if (boostBps < BPS || boostBps > RiskLimits.MAX_BOOST_BPS) {
            return _rejectedQuote("BOOST_CAP");
        }

        uint256 price = MicroMarket(market).priceForOutcome(outcome);
        uint256 payout = QuoteMath.payout(riskAmount, price, boostBps);
        uint256 requiredReserve = payout - riskAmount;
        uint256 fee = calculateFee(riskAmount, boostBps);
        uint256 maxBoost = QuoteMath.maxBoostBps(riskAmount, price, liquidityPool.availableAssets());

        quote = Quote({
            price: price,
            payout: payout,
            requiredReserve: requiredReserve,
            fee: fee,
            totalDebit: riskAmount + fee,
            maxAvailableBoostBps: maxBoost,
            accepted: true,
            reason: "OK"
        });

        if (payout > RiskLimits.MAX_PAYOUT_PER_TICKET) {
            quote.accepted = false;
            quote.reason = "PAYOUT_CAP";
        } else if (liquidityPool.availableAssets() < requiredReserve) {
            quote.accepted = false;
            quote.reason = "INSUFFICIENT_RESERVE";
        } else if (!_withinCaps(market, msg.sender, outcome, requiredReserve)) {
            quote.accepted = false;
            quote.reason = "EXPOSURE_CAP";
        } else if (!_solventAfter(market, outcome, riskAmount, payout, requiredReserve)) {
            quote.accepted = false;
            quote.reason = "MARKET_SOLVENCY";
        }
    }

    function buyTicket(address market, uint8 outcome, uint256 riskAmount, uint256 boostBps)
        external
        notPaused
        returns (uint256 ticketId)
    {
        require(MicroMarket(market).canBuy(), "MARKET_NOT_OPEN");
        Quote memory quote = quoteTicket(market, outcome, riskAmount, boostBps);
        require(quote.accepted, quote.reason);

        liquidityPool.reserveForTicket(quote.requiredReserve);
        require(usdc.transferFrom(msg.sender, address(this), quote.totalDebit), "TRANSFER_FROM");
        require(usdc.transfer(address(liquidityPool), riskAmount), "RISK_TRANSFER");
        liquidityPool.lockUserRisk(riskAmount);
        require(usdc.transfer(address(feeRouter), quote.fee), "FEE_TRANSFER");
        feeRouter.routeFee(quote.fee);

        PositionTicket.Ticket memory ticket = PositionTicket.Ticket({
            market: market,
            owner: msg.sender,
            outcome: outcome,
            riskAmount: riskAmount,
            boostBps: boostBps,
            quotedPrice: quote.price,
            payout: quote.payout,
            reservedAmount: quote.requiredReserve,
            fee: quote.fee,
            status: PositionTicket.TicketStatus.Open
        });

        ticketId = positionTicket.mint(msg.sender, ticket);
        _addExposure(market, msg.sender, outcome, riskAmount, quote.payout, quote.requiredReserve);

        // Move on-chain YES/NO odds after the fill so subsequent quotes are not stuck at seed.
        // Ticket keeps `quotedPrice` from this fill for settlement math.
        MicroMarket(market).applyTradeImpact(outcome, riskAmount);

        emit TicketBought(
            ticketId,
            msg.sender,
            market,
            outcome,
            riskAmount,
            boostBps,
            quote.payout,
            quote.requiredReserve
        );
    }

    function settleTicket(uint256 ticketId) public {
        PositionTicket.Ticket memory ticket = positionTicket.getTicket(ticketId);
        require(ticket.status == PositionTicket.TicketStatus.Open, "NOT_OPEN");

        MicroMarket market = MicroMarket(ticket.market);
        MicroMarket.Status status = market.status();
        if (status == MicroMarket.Status.Cancelled) {
            liquidityPool.refundRisk(ticket.owner, ticket.riskAmount, ticket.reservedAmount);
            _removeExposure(ticket);
            positionTicket.markCancelled(ticketId);
            emit TicketCancelled(ticketId, ticket.riskAmount);
            return;
        }

        require(status == MicroMarket.Status.Resolved, "NOT_RESOLVED");
        bool won = market.winningOutcome() == ticket.outcome;
        if (won) {
            liquidityPool.payPayout(ticket.owner, ticket.payout, ticket.reservedAmount, ticket.riskAmount);
            emit TicketSettled(ticketId, true, ticket.payout);
        } else {
            liquidityPool.settleLoss(ticket.riskAmount, ticket.reservedAmount);
            emit TicketSettled(ticketId, false, 0);
        }
        _removeExposure(ticket);
        positionTicket.markSettled(ticketId);
    }

    function settleBatch(uint256[] calldata ticketIds) external {
        // One bad ticket must not revert the whole batch: settle each via an
        // external self-call and skip failures (they can be retried later).
        for (uint256 i = 0; i < ticketIds.length; i++) {
            try this.settleTicket(ticketIds[i]) {} catch {}
        }
    }

    function calculateFee(uint256 riskAmount, uint256 boostBps) public pure returns (uint256) {
        uint256 boostPremiumBps = ((boostBps - BPS) * BOOST_FEE_BPS) / BPS;
        return (riskAmount * (BASE_FEE_BPS + boostPremiumBps)) / BPS;
    }

    function maxAvailableBoost(address market, uint8 outcome, uint256 riskAmount)
        external
        view
        returns (uint256)
    {
        uint256 price = MicroMarket(market).priceForOutcome(outcome);
        uint256 rawMax = QuoteMath.maxBoostBps(riskAmount, price, liquidityPool.availableAssets());
        if (rawMax > RiskLimits.MAX_BOOST_BPS) return RiskLimits.MAX_BOOST_BPS;
        if (rawMax < BPS) return BPS;
        return rawMax;
    }

    function _rejectedQuote(string memory reason) internal pure returns (Quote memory) {
        return Quote({
            price: 0,
            payout: 0,
            requiredReserve: 0,
            fee: 0,
            totalDebit: 0,
            maxAvailableBoostBps: BPS,
            accepted: false,
            reason: reason
        });
    }

    function _withinCaps(address market, address user, uint8 outcome, uint256 newReserve)
        internal
        view
        returns (bool)
    {
        uint256 tvl = liquidityPool.managedAssets();
        MarketExposure memory exposure = marketExposure[market];
        if (
            exposure.lpReserveAllocated + newReserve
                > RiskLimits.cap(tvl, RiskLimits.MAX_LP_RESERVE_PER_MARKET_BPS)
        ) {
            return false;
        }
        if (userReserveUsed[user] + newReserve > RiskLimits.cap(tvl, RiskLimits.MAX_LP_RESERVE_PER_USER_BPS)) {
            return false;
        }
        if (
            outcome == OUTCOME_YES
                && exposure.reserveIfYes + newReserve
                    > RiskLimits.cap(tvl, RiskLimits.MAX_LP_RESERVE_PER_OUTCOME_BPS)
        ) {
            return false;
        }
        if (
            outcome == OUTCOME_NO
                && exposure.reserveIfNo + newReserve
                    > RiskLimits.cap(tvl, RiskLimits.MAX_LP_RESERVE_PER_OUTCOME_BPS)
        ) {
            return false;
        }
        return true;
    }

    function _solventAfter(
        address market,
        uint8 outcome,
        uint256 riskAmount,
        uint256 payout,
        uint256 reserve
    ) internal view returns (bool) {
        MarketExposure memory exposure = marketExposure[market];
        uint256 payoutIfYes = exposure.payoutIfYes;
        uint256 payoutIfNo = exposure.payoutIfNo;
        if (outcome == OUTCOME_YES) {
            payoutIfYes += payout;
        } else {
            payoutIfNo += payout;
        }
        uint256 maxPayout = payoutIfYes > payoutIfNo ? payoutIfYes : payoutIfNo;
        return maxPayout <= exposure.totalUserRisk + riskAmount + exposure.lpReserveAllocated + reserve;
    }

    function _addExposure(
        address market,
        address user,
        uint8 outcome,
        uint256 riskAmount,
        uint256 payout,
        uint256 reserve
    ) internal {
        MarketExposure storage exposure = marketExposure[market];
        exposure.totalUserRisk += riskAmount;
        exposure.lpReserveAllocated += reserve;
        userReserveUsed[user] += reserve;
        if (outcome == OUTCOME_YES) {
            exposure.payoutIfYes += payout;
            exposure.reserveIfYes += reserve;
        } else {
            exposure.payoutIfNo += payout;
            exposure.reserveIfNo += reserve;
        }
    }

    function _removeExposure(PositionTicket.Ticket memory ticket) internal {
        MarketExposure storage exposure = marketExposure[ticket.market];
        exposure.totalUserRisk -= ticket.riskAmount;
        exposure.lpReserveAllocated -= ticket.reservedAmount;
        userReserveUsed[ticket.owner] -= ticket.reservedAmount;
        if (ticket.outcome == OUTCOME_YES) {
            exposure.payoutIfYes -= ticket.payout;
            exposure.reserveIfYes -= ticket.reservedAmount;
        } else {
            exposure.payoutIfNo -= ticket.payout;
            exposure.reserveIfNo -= ticket.reservedAmount;
        }
    }
}
