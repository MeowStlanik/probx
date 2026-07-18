// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PositionTicket {
    enum TicketStatus {
        None,
        Open,
        Settled,
        Cancelled
    }

    struct Ticket {
        address market;
        address owner;
        uint8 outcome;
        uint256 riskAmount;
        uint256 boostBps;
        uint256 quotedPrice;
        uint256 payout;
        uint256 reservedAmount;
        uint256 fee;
        TicketStatus status;
    }

    string public constant name = "ProbX Locked Position Ticket";
    string public constant symbol = "PXLT";

    address public owner;
    address public engine;
    uint256 public totalSupply;

    mapping(uint256 => Ticket) private tickets;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event EngineSet(address indexed engine);
    event TicketMinted(uint256 indexed ticketId, address indexed owner, address indexed market);
    event TicketSettled(uint256 indexed ticketId);
    event TicketCancelled(uint256 indexed ticketId);

    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    modifier onlyEngine() {
        require(msg.sender == engine, "ONLY_ENGINE");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setEngine(address engine_) external onlyOwner {
        engine = engine_;
        emit EngineSet(engine_);
    }

    function mint(address to, Ticket calldata ticket) external onlyEngine returns (uint256 ticketId) {
        require(to != address(0), "ZERO_TO");
        require(ticket.status == TicketStatus.Open, "BAD_STATUS");
        ticketId = ++totalSupply;
        tickets[ticketId] = ticket;
        tickets[ticketId].owner = to;
        ownerOf[ticketId] = to;
        balanceOf[to] += 1;
        emit Transfer(address(0), to, ticketId);
        emit TicketMinted(ticketId, to, ticket.market);
    }

    function markSettled(uint256 ticketId) external onlyEngine {
        require(tickets[ticketId].status == TicketStatus.Open, "NOT_OPEN");
        tickets[ticketId].status = TicketStatus.Settled;
        emit TicketSettled(ticketId);
    }

    function markCancelled(uint256 ticketId) external onlyEngine {
        require(tickets[ticketId].status == TicketStatus.Open, "NOT_OPEN");
        tickets[ticketId].status = TicketStatus.Cancelled;
        emit TicketCancelled(ticketId);
    }

    function getTicket(uint256 ticketId) external view returns (Ticket memory) {
        return tickets[ticketId];
    }

    function approve(address, uint256) external pure {
        revert("SOULBOUND");
    }

    function setApprovalForAll(address, bool) external pure {
        revert("SOULBOUND");
    }

    function transferFrom(address, address, uint256) external pure {
        revert("SOULBOUND");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("SOULBOUND");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("SOULBOUND");
    }

    function getApproved(uint256) external pure returns (address) {
        return address(0);
    }

    function isApprovedForAll(address, address) external pure returns (bool) {
        return false;
    }
}
