// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MicroMarket — short YES/NO market with on-chain price discovery
/// @notice Ticket prices live in 1e6 scale (500_000 = 50¢). Each buy moves odds
///         toward the purchased side so the book is not stuck at 50/50.
/// @dev Fair mid is stored in `fairMidYes` and is the single source of truth for
///      impact math. Quoted yesPrice/noPrice are derived with overround; we never
///      recover mid by dividing a clamp-saturated quote (that inverted the book).
contract MicroMarket {
    uint8 public constant OUTCOME_YES = 1;
    uint8 public constant OUTCOME_NO = 2;
    uint256 public constant PRICE_SCALE = 1e6;
    /// @dev Soft bounds on fair mid so a single side cannot go to 0/100 in one demo session.
    uint256 public constant MIN_PRICE = 50_000; // 5%
    uint256 public constant MAX_PRICE = 950_000; // 95%
    /// @dev Book overround (sportsbook margin). Quoted YES+NO ≈ 108% of fair scale.
    ///      Self-funds boost up to ~1.09x; above that the vault subsidises by design.
    uint256 public constant OVERROUND_BPS = 10_800; // 108%
    /// @dev Upper bound for one trade. Impact is linear in stake at fixed depth until this cap;
    ///      there is deliberately no minimum-impact floor for dust trades.
    uint256 public constant MAX_IMPACT = 120_000; // 12%

    /// @dev Max drift of fair mid away from its seed, in bps of the *cheaper* side.
    ///
    ///      This bound is derived, not tuned. Quoted price is mid × OVERROUND_BPS, so a
    ///      book pushed down by d still quotes at or above fair value exactly while
    ///          (mid − d) × OVERROUND_BPS / 10_000  ≥  mid
    ///      i.e. d ≤ mid × (1 − 10_000/OVERROUND_BPS). At 108% that limit is 741 bps;
    ///      700 keeps a margin. Taking min(mid, SCALE−mid) bounds both sides at once,
    ///      because pushing mid *up* makes NO the cheap side by the symmetric amount.
    ///
    ///      Consequence: no reachable book state offers a positive-EV entry at the seed
    ///      probability. Overround is the house edge that funds the book — once flow can
    ///      push price past that edge, the vault is underwriting a free option.
    ///      Enforced by testFuzz_bookNeverQuotesBelowSeedFair.
    uint256 public constant MAX_MID_DRIFT_BPS = 700;

    /// @dev Virtual book depth = LP managed assets / this, floored at MIN_IMPACT_LIQUIDITY.
    ///      Odds move against the capital underwriting them. The previous fixed 2 USDC
    ///      constant meant one minimum ticket (0.25 USDC) moved mid by 6.25 points, so
    ///      2.75 USDC of dust walked the book to the rail regardless of pool size.
    uint256 public constant IMPACT_DEPTH_DIVISOR = 20;
    /// @dev Floor for pools too small to size a book from — a thin pool must not imply
    ///      a cheap book, it is exactly the case an attacker would seek out.
    uint256 public constant MIN_IMPACT_LIQUIDITY = 5_000e6; // 5 000 USDC

    /// @notice Virtual depth used for impact, fixed at creation from LP capital.
    uint256 public immutable impactLiquidity;
    /// @notice Fair mid at creation — the reference the drift band is measured from.
    uint256 public immutable seedMidYes;
    /// @notice Inclusive bounds on fairMidYes for this market's lifetime.
    uint256 public immutable minMidYes;
    uint256 public immutable maxMidYes;

    enum Status {
        Created,
        Open,
        Locked,
        Resolved,
        Cancelled,
        Archived
    }

    string public question;
    bytes32 public rulesHash;
    uint64 public openTime;
    uint64 public lockTime;
    uint64 public observationStart;
    uint64 public observationEnd;
    /// @notice Quoted YES (mid × overround). Used for ticket pricing.
    uint256 public yesPrice;
    /// @notice Quoted NO ( (1−mid) × overround ). Used for ticket pricing.
    uint256 public noPrice;
    /// @notice Fair mid for YES in PRICE_SCALE units — source of truth for impact.
    uint256 public fairMidYes;
    /// @notice Cumulative user risk on YES (token units, 6 decimals).
    uint256 public totalYesRisk;
    /// @notice Cumulative user risk on NO (token units, 6 decimals).
    uint256 public totalNoRisk;
    Status public status;
    uint8 public winningOutcome;

    address public owner;
    address public engine;
    address public oracle;

    event Opened(uint64 openTime, uint64 lockTime);
    event Locked(uint64 lockTime);
    event Resolved(uint8 indexed outcome);
    event Cancelled(string reason);
    event Archived();
    event EngineSet(address indexed engine);
    event OracleSet(address indexed oracle);
    event PricesUpdated(
        uint256 yesPrice,
        uint256 noPrice,
        uint8 indexed outcome,
        uint256 riskAmount,
        uint256 impact
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier onlyEngine() {
        require(msg.sender == engine, "ONLY_ENGINE");
        _;
    }

    modifier onlyOracleOrOwner() {
        require(msg.sender == owner || msg.sender == oracle, "ONLY_ORACLE_OR_OWNER");
        _;
    }

    constructor(
        address owner_,
        address engine_,
        address oracle_,
        string memory question_,
        bytes32 rulesHash_,
        uint64 openTime_,
        uint64 lockTime_,
        uint64 observationStart_,
        uint64 observationEnd_,
        uint256 yesPrice_
    ) {
        require(owner_ != address(0), "ZERO_OWNER");
        require(openTime_ <= lockTime_, "BAD_OPEN");
        require(lockTime_ <= observationStart_, "BAD_LOCK");
        require(observationStart_ <= observationEnd_, "BAD_OBSERVATION");
        require(yesPrice_ >= MIN_PRICE && yesPrice_ <= MAX_PRICE, "BAD_PRICE");
        owner = owner_;
        engine = engine_;
        oracle = oracle_;
        question = question_;
        rulesHash = rulesHash_;
        openTime = openTime_;
        lockTime = lockTime_;
        observationStart = observationStart_;
        observationEnd = observationEnd_;

        // yesPrice_ is the fair mid. Pin the drift band to it before any quote is written.
        seedMidYes = yesPrice_;
        uint256 cheaperSide = yesPrice_ < PRICE_SCALE - yesPrice_ ? yesPrice_ : PRICE_SCALE - yesPrice_;
        uint256 drift = (cheaperSide * MAX_MID_DRIFT_BPS) / 10_000;
        uint256 lo = yesPrice_ - drift;
        uint256 hi = yesPrice_ + drift;
        minMidYes = lo < MIN_PRICE ? MIN_PRICE : lo;
        maxMidYes = hi > MAX_PRICE ? MAX_PRICE : hi;

        impactLiquidity = _sizeBook(engine_);

        // Store mid + quoted prices with overround margin.
        _setQuotedFromMid(yesPrice_);
    }

    /// @dev Read LP capital through the engine so the factory/API call signature is unchanged.
    ///      Same staticcall-with-fallback shape as archive(). A market constructed outside the
    ///      factory (unit tests, a mock engine) simply gets the floor depth — a wrong answer
    ///      here must be conservative, never a deeper-than-real book.
    function _sizeBook(address engine_) private view returns (uint256 depth) {
        depth = MIN_IMPACT_LIQUIDITY;
        if (engine_ == address(0) || engine_.code.length == 0) return depth;

        (bool okPool, bytes memory poolData) =
            engine_.staticcall(abi.encodeWithSignature("liquidityPool()"));
        if (!okPool || poolData.length < 32) return depth;
        address pool = abi.decode(poolData, (address));
        if (pool == address(0) || pool.code.length == 0) return depth;

        (bool okTvl, bytes memory tvlData) =
            pool.staticcall(abi.encodeWithSignature("managedAssets()"));
        if (!okTvl || tvlData.length < 32) return depth;

        uint256 sized = abi.decode(tvlData, (uint256)) / IMPACT_DEPTH_DIVISOR;
        if (sized > depth) depth = sized;
    }

    function setEngine(address engine_) external onlyOwner {
        engine = engine_;
        emit EngineSet(engine_);
    }

    function setOracle(address oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleSet(oracle_);
    }

    function open() external onlyOwner {
        require(status == Status.Created, "BAD_STATUS");
        require(block.timestamp <= lockTime, "LOCKED");
        status = Status.Open;
        emit Opened(openTime, lockTime);
    }

    function lock() external {
        require(msg.sender == owner || msg.sender == engine || msg.sender == oracle, "NOT_AUTHORIZED");
        require(status == Status.Open, "BAD_STATUS");
        require(block.timestamp >= lockTime, "TOO_EARLY");
        status = Status.Locked;
        emit Locked(uint64(block.timestamp));
    }

    function resolve(uint8 outcome) external onlyOracleOrOwner {
        require(outcome == OUTCOME_YES || outcome == OUTCOME_NO, "BAD_OUTCOME");
        require(status == Status.Locked || status == Status.Open, "BAD_STATUS");
        if (status == Status.Open) {
            require(block.timestamp >= lockTime, "NOT_LOCKED");
            status = Status.Locked;
            emit Locked(uint64(block.timestamp));
        }
        // Must wait for the full observation window — not just its start.
        require(block.timestamp >= observationEnd, "OBSERVATION_NOT_ENDED");
        winningOutcome = outcome;
        status = Status.Resolved;
        emit Resolved(outcome);
    }

    function cancel(string calldata reason) external onlyOracleOrOwner {
        require(status != Status.Resolved && status != Status.Archived, "FINAL");
        status = Status.Cancelled;
        emit Cancelled(reason);
    }

    /// @notice Hide a terminal market from listings. Blocked while any LP exposure remains
    ///         so settleTicket can still run (Resolved/Cancelled/Archived all settle).
    function archive() external onlyOwner {
        require(status == Status.Resolved || status == Status.Cancelled, "NOT_FINAL");
        // engine is MicroBoostEngine — marketHasNoExposure(address)
        (bool ok, bytes memory data) =
            engine.staticcall(abi.encodeWithSignature("marketHasNoExposure(address)", address(this)));
        require(ok && data.length >= 32 && abi.decode(data, (bool)), "OPEN_TICKETS");
        status = Status.Archived;
        emit Archived();
    }

    function canBuy() external view returns (bool) {
        return status == Status.Open && block.timestamp >= openTime && block.timestamp < lockTime;
    }

    function priceForOutcome(uint8 outcome) external view returns (uint256) {
        if (outcome == OUTCOME_YES) return yesPrice;
        if (outcome == OUTCOME_NO) return noPrice;
        revert("BAD_OUTCOME");
    }

    /// @notice Called by MicroBoostEngine after a successful buy.
    ///         Moves fair mid up on YES buys and down on NO buys; re-derives quotes.
    function applyTradeImpact(uint8 outcome, uint256 riskAmount) external onlyEngine {
        require(status == Status.Open, "BAD_STATUS");
        require(outcome == OUTCOME_YES || outcome == OUTCOME_NO, "BAD_OUTCOME");
        require(riskAmount > 0, "ZERO_RISK");

        uint256 depth = impactLiquidity + totalYesRisk + totalNoRisk;
        // risk/(2*depth) of full scale — linear at the current depth until MAX_IMPACT;
        // deliberately no MIN_IMPACT floor.
        uint256 impact = (riskAmount * PRICE_SCALE) / (depth * 2);
        if (impact > MAX_IMPACT) impact = MAX_IMPACT;

        // Impact on stored fair mid — never round-trip through clamp-saturated yesPrice.
        // _clampMid holds the drift band, so no side needs its own rail handling here.
        uint256 mid = fairMidYes;
        if (outcome == OUTCOME_YES) {
            mid = _clampMid(mid + impact);
            totalYesRisk += riskAmount;
        } else {
            mid = _clampMid(mid > impact ? mid - impact : 0);
            totalNoRisk += riskAmount;
        }
        _setQuotedFromMid(mid);

        emit PricesUpdated(yesPrice, noPrice, outcome, riskAmount, impact);
    }

    /// @dev The drift band is already intersected with [MIN_PRICE, MAX_PRICE] at construction,
    ///      so clamping to it enforces both the hard rails and the no-free-EV bound.
    function _clampMid(uint256 mid) internal view returns (uint256) {
        if (mid < minMidYes) return minMidYes;
        if (mid > maxMidYes) return maxMidYes;
        return mid;
    }

    /// @dev Store fair mid (impact source of truth), then quoted = mid × overround.
    ///      Quotes may be clipped only for ticket math (QuoteMath requires price < PRICE_SCALE)
    ///      and soft display floors — never fed back into fairMidYes (that was audit C).
    function _setQuotedFromMid(uint256 midYes) internal {
        // Reads immutables (via _clampMid) — legal during construction since solc 0.8.8.
        midYes = _clampMid(midYes);
        fairMidYes = midYes;
        uint256 midNo = PRICE_SCALE - midYes;
        uint256 y = (midYes * OVERROUND_BPS) / 10_000;
        uint256 n = (midNo * OVERROUND_BPS) / 10_000;
        // QuoteMath.payout requires 0 < price < PRICE_SCALE.
        if (y >= PRICE_SCALE) y = PRICE_SCALE - 1;
        if (n >= PRICE_SCALE) n = PRICE_SCALE - 1;
        if (y < MIN_PRICE) y = MIN_PRICE;
        if (n < MIN_PRICE) n = MIN_PRICE;
        yesPrice = y;
        noPrice = n;
    }
}
