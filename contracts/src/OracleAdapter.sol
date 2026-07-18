// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MicroMarket.sol";

contract OracleAdapter {
    uint8 private constant OUTCOME_YES = 1;
    uint8 private constant OUTCOME_NO = 2;

    struct Result {
        bool submitted;
        bool cancelled;
        uint8 outcome;
        uint64 submittedAt;
    }

    address public owner;
    address public resolver;
    mapping(address => Result) public results;

    event ResolverSet(address indexed resolver);
    event ResultSubmitted(address indexed market, uint8 indexed outcome);
    event MarketCancelled(address indexed market, string reason);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier onlyResolver() {
        require(msg.sender == owner || msg.sender == resolver, "ONLY_RESOLVER");
        _;
    }

    constructor(address resolver_) {
        owner = msg.sender;
        resolver = resolver_;
    }

    function setResolver(address resolver_) external onlyOwner {
        resolver = resolver_;
        emit ResolverSet(resolver_);
    }

    function submitResult(address market, uint8 outcome) external onlyResolver {
        require(outcome == OUTCOME_YES || outcome == OUTCOME_NO, "BAD_OUTCOME");
        results[market] = Result({
            submitted: true,
            cancelled: false,
            outcome: outcome,
            submittedAt: uint64(block.timestamp)
        });
        MicroMarket(market).resolve(outcome);
        emit ResultSubmitted(market, outcome);
    }

    function cancelMarket(address market, string calldata reason) external onlyResolver {
        results[market] = Result({
            submitted: true,
            cancelled: true,
            outcome: 0,
            submittedAt: uint64(block.timestamp)
        });
        MicroMarket(market).cancel(reason);
        emit MarketCancelled(market, reason);
    }

    function getResult(address market) external view returns (Result memory) {
        return results[market];
    }
}
