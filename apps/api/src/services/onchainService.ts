import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  parseUnits,
  stringToHex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LpSnapshot, Market, MarketStatus, Outcome, PriceQuote, Ticket } from "../db/schema.js";
import { runtimeFile } from "../runtimePaths.js";
/** Bundled with the API so Vercel serverless always has Arc addresses (fs paths often miss). */
import bundledArcDeployment from "../config/arc-deployment.json";

interface DemoMarketDeployment {
  id?: string;
  label?: string;
  role?: DemoMarketRole;
  market: string;
}

type DemoMarketRole = "open" | "btc_price" | "london_weather" | "near_lock" | "resolved" | "legacy";

type MarketUiState = {
  hidden: string[];
  pinned?: string[];
};

const marketUiStatePath = runtimeFile("market-ui-state.json");
const initialMarketUiState = loadMarketUiState();
const hiddenMarketAddresses = new Set<string>(initialMarketUiState.hidden);
let pinnedMarketAddresses: Set<string> | undefined = initialMarketUiState.pinned
  ? new Set(initialMarketUiState.pinned)
  : undefined;

interface Deployment {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  rpcUrls?: string[];
  explorerUrl: string;
  deployer: string;
  usdc: string;
  liquidityPool: string;
  insuranceFund: string;
  feeRouter: string;
  positionTicket: string;
  microBoostEngine: string;
  oracleAdapter: string;
  marketFactory: string;
  demoMarket: string;
  demoMarkets?: DemoMarketDeployment[];
  lpSeedUsdc: string;
  deployedAt: string;
  fromBlock?: number | string;
  deploymentBlock?: number | string;
  blockNumber?: number | string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const deployment = loadDeployment();
const hasDeployment = Boolean(deployment?.microBoostEngine && deployment.demoMarket);
const arcRpcUrls = buildRpcUrls(deployment);
const arcTransport = buildRpcTransport(arcRpcUrls);

const arcChain = defineChain({
  id: deployment?.chainId ?? 5_042_002,
  name: deployment?.chainName ?? "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: arcRpcUrls } },
  blockExplorers: { default: { name: "ArcScan", url: deployment?.explorerUrl ?? "https://testnet.arcscan.app" } }
});

const publicClient = createPublicClient({
  chain: arcChain,
  transport: arcTransport
});

const engineAbi = [
  {
    type: "function",
    name: "quoteTicket",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "outcome", type: "uint8" },
      { name: "riskAmount", type: "uint256" },
      { name: "boostBps", type: "uint256" }
    ],
    outputs: [
      {
        name: "quote",
        type: "tuple",
        components: [
          { name: "price", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "requiredReserve", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "totalDebit", type: "uint256" },
          { name: "maxAvailableBoostBps", type: "uint256" },
          { name: "accepted", type: "bool" },
          { name: "reason", type: "string" }
        ]
      }
    ]
  },
  {
    type: "function",
    name: "settleTicket",
    stateMutability: "nonpayable",
    inputs: [{ name: "ticketId", type: "uint256" }],
    outputs: []
  },
  {
    type: "event",
    name: "TicketBought",
    inputs: [
      { name: "ticketId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "market", type: "address", indexed: true },
      { name: "outcome", type: "uint8", indexed: false },
      { name: "riskAmount", type: "uint256", indexed: false },
      { name: "boostBps", type: "uint256", indexed: false },
      { name: "payout", type: "uint256", indexed: false },
      { name: "reserve", type: "uint256", indexed: false }
    ]
  }
] as const;

const poolAbi = [
  { type: "function", name: "managedAssets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "reservedAssets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "lockedUserRisk", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "availableAssets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "totalFeesEarned", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] }
] as const;

const marketAbi = [
  { type: "function", name: "open", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "question", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "rulesHash", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
  { type: "function", name: "openTime", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "lockTime", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "observationStart", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "observationEnd", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "yesPrice", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "noPrice", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "status", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "winningOutcome", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "resolve", stateMutability: "nonpayable", inputs: [{ name: "outcome", type: "uint8" }], outputs: [] },
  { type: "function", name: "cancel", stateMutability: "nonpayable", inputs: [{ name: "reason", type: "string" }], outputs: [] }
] as const;

const factoryAbi = [
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "question", type: "string" },
      { name: "rulesHash", type: "bytes32" },
      { name: "openTime", type: "uint64" },
      { name: "lockTime", type: "uint64" },
      { name: "observationStart", type: "uint64" },
      { name: "observationEnd", type: "uint64" },
      { name: "yesPrice", type: "uint256" }
    ],
    outputs: [{ name: "market", type: "address" }]
  },
  {
    type: "function",
    name: "getMarkets",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "market", type: "address" },
          { name: "metadataHash", type: "bytes32" },
          { name: "createdAt", type: "uint64" }
        ]
      }
    ]
  },
  {
    type: "event",
    name: "MarketCreated",
    inputs: [
      { name: "marketId", type: "uint256", indexed: true },
      { name: "market", type: "address", indexed: true },
      { name: "question", type: "string", indexed: false },
      { name: "metadataHash", type: "bytes32", indexed: true }
    ]
  }
] as const;

const ticketAbi = [
  {
    type: "function",
    name: "getTicket",
    stateMutability: "view",
    inputs: [{ name: "ticketId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "market", type: "address" },
          { name: "owner", type: "address" },
          { name: "outcome", type: "uint8" },
          { name: "riskAmount", type: "uint256" },
          { name: "boostBps", type: "uint256" },
          { name: "quotedPrice", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "reservedAmount", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "status", type: "uint8" }
        ]
      }
    ]
  }
] as const;

export function onchainEnabled(): boolean {
  return hasDeployment;
}

export function getDeployment() {
  return deployment;
}

export async function getOnchainContracts() {
  return {
    mode: hasDeployment ? "arc-testnet" : "demo",
    ...deployment
  };
}

export async function getOnchainLpStats(): Promise<LpSnapshot> {
  assertDeployment();
  const [tvl, reservedLiquidity, lockedUserRisk, availableLiquidity, feesEarned] = await Promise.all([
    publicClient.readContract({ address: addr(deployment.liquidityPool), abi: poolAbi, functionName: "managedAssets" }),
    publicClient.readContract({ address: addr(deployment.liquidityPool), abi: poolAbi, functionName: "reservedAssets" }),
    publicClient.readContract({ address: addr(deployment.liquidityPool), abi: poolAbi, functionName: "lockedUserRisk" }),
    publicClient.readContract({ address: addr(deployment.liquidityPool), abi: poolAbi, functionName: "availableAssets" }),
    publicClient.readContract({ address: addr(deployment.liquidityPool), abi: poolAbi, functionName: "totalFeesEarned" })
  ]);

  return {
    tvl: usdcNumber(tvl),
    reservedLiquidity: usdcNumber(reservedLiquidity),
    lockedUserRisk: usdcNumber(lockedUserRisk),
    availableLiquidity: usdcNumber(availableLiquidity),
    feesEarned: usdcNumber(feesEarned),
    dailyVolume: 0,
    simulatedApy: 0
  };
}

export async function listOnchainMarkets(options: {
  /** Include finished markets for resolve/hide (cron). UI list hides RESOLVED without tickets. */
  forCycle?: boolean;
} = {}): Promise<Market[]> {
  assertDeployment();
  const known = await listKnownMarkets({ includeHidden: Boolean(options.forCycle) });
  const markets = await Promise.all(known.map((item) => readOnchainMarket(item)));
  const all = markets.filter((market): market is Market => Boolean(market)).sort(compareDemoMarkets);
  if (options.forCycle) return all;

  // Public markets desk:
  // - only open / locked / observation (never RESOLVED/CANCELLED)
  // - BTC + London weather only (no demo "GREEN signal" / admin leftovers)
  // - one freshest market each so the grid stays 2 cards centered
  // Portfolio still loads tickets by address for claims.
  const live = all.filter(
    (market) =>
      market.status === "OPEN" || market.status === "LOCKED" || market.status === "OBSERVATION"
  );
  return collapseAutoCycleMarkets(live).sort(compareDemoMarkets);
}

/**
 * Keep at most one BTC and one London-weather market (prefer OPEN, then newest openTime).
 * Drop non-reference markets (demo GREEN, arc-block, etc.) from the public desk.
 */
function collapseAutoCycleMarkets(markets: Market[]): Market[] {
  const isBtc = (m: Market) => m.demoRole === "btc_price" || m.category === "crypto-candle";
  const isWeather = (m: Market) => m.demoRole === "london_weather" || m.category === "weather";

  const btc = markets.filter(isBtc);
  const weather = markets.filter(isWeather);

  const pickOne = (group: Market[]): Market[] => {
    if (group.length <= 1) return group;
    const rank = (status: string) =>
      status === "OPEN" ? 0 : status === "LOCKED" ? 1 : status === "OBSERVATION" ? 2 : 3;
    const sorted = [...group].sort((a, b) => {
      const byStatus = rank(a.status) - rank(b.status);
      if (byStatus !== 0) return byStatus;
      const aOpen = Date.parse(a.openTime || "") || 0;
      const bOpen = Date.parse(b.openTime || "") || 0;
      return bOpen - aOpen;
    });
    return [sorted[0]!];
  };

  // BTC then weather — stable two-card desk (no third demo market)
  return [...pickOne(btc), ...pickOne(weather)];
}

export async function getOnchainMarket(id: string): Promise<Market | undefined> {
  assertDeployment();
  // Prefer direct address read (works for finished/hidden rounds users still open from Portfolio).
  try {
    const asAddr = getAddress(id);
    const market = await readOnchainMarket({
      id: asAddr,
      label: "On-chain market",
      role: "legacy",
      market: asAddr
    });
    if (market) return market;
  } catch {
    // id may be a short demo slug
  }
  const item = findDemoMarket(id);
  if (!item) return undefined;
  // Include hidden markets when fetched by id (claim / portfolio deep-link).
  return readOnchainMarket(item);
}

async function readOnchainMarket(item: DemoMarketDeployment): Promise<Market | undefined> {
  const market = addr(item.market);
  const [
    question,
    rulesHash,
    openTime,
    lockTime,
    observationStart,
    observationEnd,
    yesPrice,
    noPrice,
    status,
    winningOutcome
  ] = await Promise.all([
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "question" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "rulesHash" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "openTime" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "lockTime" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "observationStart" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "observationEnd" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "yesPrice" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "noPrice" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "status" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "winningOutcome" })
  ]);
  // TicketBought volume for desk stats; live odds come from on-chain yesPrice/noPrice.
  // Cap log scan so a single market detail never stalls navigation on a slow RPC.
  const tradeStats = await Promise.race([
    marketTradeStats(market).catch(() => emptyMarketTradeStats()),
    new Promise<ReturnType<typeof emptyMarketTradeStats>>((resolve) =>
      setTimeout(() => resolve(emptyMarketTradeStats()), 1_500)
    )
  ]);
  const role = classifyDemoMarket(item, question);
  const liveYes = Number(yesPrice) / 1_000_000;
  const liveNo = Number(noPrice) / 1_000_000;

  return {
    id: demoMarketId(item),
    question,
    rules: demoRules(role, question),
    category: demoCategory(role),
    status: displayedMarketStatus(Number(status), lockTime),
    // On-chain market odds — updated by MicroMarket.applyTradeImpact after each buy.
    yesPrice: liveYes,
    noPrice: liveNo,
    ticketYesPrice: liveYes,
    ticketNoPrice: liveNo,
    openTime: unixToIso(openTime),
    lockTime: unixToIso(lockTime),
    observationStart: unixToIso(observationStart),
    observationEnd: unixToIso(observationEnd),
    resolutionSource: demoResolutionSource(role),
    winningOutcome: Number(winningOutcome) === 1 ? "YES" : Number(winningOutcome) === 2 ? "NO" : undefined,
    volume: tradeStats.volume,
    ticketCount: tradeStats.ticketCount,
    yesVolume: tradeStats.yesVolume,
    noVolume: tradeStats.noVolume,
    maxBoost: 5,
    rulesHash,
    contractAddress: market,
    demoRole: role
  };
}

export async function quoteOnchainTicket(id: string, params: URLSearchParams): Promise<PriceQuote | undefined> {
  assertDeployment();
  const item = findDemoMarket(id);
  if (!item) return undefined;
  const outcome = normalizeOutcome(params.get("outcome"));
  const riskAmount = Number(params.get("amount") ?? "1");
  const boost = Number(params.get("boost") ?? "1");
  const risk = parseUnits(String(riskAmount), 6);
  const boostBps = BigInt(Math.round(boost * 10_000));
  const outcomeId = outcome === "YES" ? 1 : 2;

  const quote = await publicClient.readContract({
    address: addr(deployment.microBoostEngine),
    abi: engineAbi,
    functionName: "quoteTicket",
    args: [addr(item.market), outcomeId, risk, boostBps]
  });

  return {
    marketId: demoMarketId(item),
    outcome,
    riskAmount,
    boost,
    payout: usdcNumber(quote.payout),
    requiredReserve: usdcNumber(quote.requiredReserve),
    fee: usdcNumber(quote.fee),
    accepted: quote.accepted,
    reason: quote.reason,
    maxAvailableBoost: Number(quote.maxAvailableBoostBps) / 10_000
  };
}

async function marketTradeStats(market: `0x${string}`): Promise<{
  volume: number;
  ticketCount: number;
  yesVolume: number;
  noVolume: number;
}> {
  const logs = await ticketBoughtLogsForMarket(market);
  let totalRisk = 0n;
  let yesRisk = 0n;
  let noRisk = 0n;
  for (const log of logs) {
    const risk = log.args.riskAmount ?? 0n;
    totalRisk += risk;
    if (log.args.outcome === 1) yesRisk += risk;
    if (log.args.outcome === 2) noRisk += risk;
  }
  return {
    volume: usdcNumber(totalRisk),
    ticketCount: logs.length,
    yesVolume: usdcNumber(yesRisk),
    noVolume: usdcNumber(noRisk)
  };
}

function emptyMarketTradeStats(): {
  volume: number;
  ticketCount: number;
  yesVolume: number;
  noVolume: number;
} {
  return {
    volume: 0,
    ticketCount: 0,
    yesVolume: 0,
    noVolume: 0
  };
}

type TicketBoughtLogArgs = {
  buyer?: `0x${string}`;
  market?: `0x${string}`;
};

type TicketBoughtLog = {
  args: {
    ticketId?: bigint;
    buyer?: `0x${string}`;
    market?: `0x${string}`;
    outcome?: number;
    riskAmount?: bigint;
  };
};

async function ticketBoughtLogsForMarket(market: `0x${string}`, chunkOnFailure = false) {
  const latestBlock = await publicClient.getBlockNumber();
  const fromBlock = recentTicketScanFromBlock(latestBlock);
  if (fromBlock > latestBlock) return [];
  const args = { market };
  try {
    return await publicClient.getLogs({
      address: addr(deployment.microBoostEngine),
      event: engineAbi[2],
      args,
      fromBlock,
      toBlock: latestBlock
    }) as TicketBoughtLog[];
  } catch {
    return chunkOnFailure ? ticketBoughtLogsChunked(args, fromBlock, latestBlock) : [];
  }
}

async function ticketBoughtLogsForBuyer(buyer: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
  const args = { buyer };
  try {
    return await publicClient.getLogs({
      address: addr(deployment.microBoostEngine),
      event: engineAbi[2],
      args,
      fromBlock,
      toBlock
    }) as TicketBoughtLog[];
  } catch {
    return ticketBoughtLogsChunked(args, fromBlock, toBlock);
  }
}

async function ticketBoughtLogsChunked(args: TicketBoughtLogArgs, fromBlock: bigint, toBlock: bigint) {
  const chunkSize = configuredLogChunkSize();
  const logs: TicketBoughtLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
    try {
      logs.push(...await publicClient.getLogs({
        address: addr(deployment.microBoostEngine),
        event: engineAbi[2],
        args,
        fromBlock: start,
        toBlock: end
      }) as TicketBoughtLog[]);
    } catch {
      // Keep the UI responsive even if one public RPC refuses an old/pruned range.
    }
  }
  return logs;
}

async function ticketMarketSnapshot(marketAddress: string): Promise<{
  question: string;
  status: MarketStatus;
  winningOutcome?: Outcome;
}> {
  const market = addr(marketAddress);
  const [question, status, lockTime, winningOutcome] = await Promise.all([
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "question" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "status" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "lockTime" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "winningOutcome" })
  ]);
  return {
    question,
    status: displayedMarketStatus(Number(status), lockTime),
    winningOutcome: Number(winningOutcome) === 1 ? "YES" : Number(winningOutcome) === 2 ? "NO" : undefined
  };
}

type TicketCacheEntry = {
  scannedToBlock: bigint;
  tickets: Map<string, Ticket>;
};

const ticketCache = new Map<string, TicketCacheEntry>();

export async function ticketsForUserOnchain(user: string): Promise<Ticket[]> {
  assertDeployment();
  const buyer = addr(user);
  const cacheKey = buyer.toLowerCase();
  const latestBlock = await publicClient.getBlockNumber();
  const existing = ticketCache.get(cacheKey);
  const fromBlock = existing ? existing.scannedToBlock + 1n : recentTicketScanFromBlock(latestBlock);

  if (!existing || fromBlock <= latestBlock) {
    const logs = fromBlock <= latestBlock
      ? await ticketBoughtLogsForBuyer(buyer, fromBlock, latestBlock)
      : [];

    const tickets = existing?.tickets ?? new Map<string, Ticket>();
    for (const log of logs) {
      const ticket = await ticketFromBoughtLog(log.args.ticketId, tickets);
      if (ticket) tickets.set(ticket.id, ticket);
    }
    if (tickets.size > 0) {
      await refreshCachedTicketPositions(tickets);
    }
    ticketCache.set(cacheKey, { scannedToBlock: latestBlock, tickets });
  }

  const current = ticketCache.get(cacheKey);
  return [...(current?.tickets.values() ?? [])].sort(compareTicketIdsDesc);
}

async function ticketFromBoughtLog(ticketId: bigint | undefined, tickets: Map<string, Ticket>): Promise<Ticket | undefined> {
  if (ticketId === undefined) return undefined;
  return ticketFromChainId(ticketId, tickets.get(ticketKey(ticketId))?.createdAt);
}

async function refreshCachedTicketPositions(tickets: Map<string, Ticket>): Promise<void> {
  await Promise.all(
    [...tickets.keys()].map(async (id) => {
      const ticket = await ticketFromChainId(ticketIdNumber(id), tickets.get(id)?.createdAt);
      if (ticket) tickets.set(id, ticket);
    })
  );
}

async function ticketFromChainId(ticketId: bigint, createdAt = new Date().toISOString()): Promise<Ticket | undefined> {
  if (ticketId <= 0n) return undefined;
  const position = await publicClient.readContract({
    address: addr(deployment.positionTicket),
    abi: ticketAbi,
    functionName: "getTicket",
    args: [ticketId]
  });
  const marketSnapshot = await ticketMarketSnapshot(position.market);
  const ticketStatusValue = ticketStatus(Number(position.status));
  const winningOutcome = marketSnapshot.winningOutcome;
  const ticketOutcome = position.outcome === 1 ? "YES" : "NO";
  const result = ticketResult(ticketStatusValue, marketSnapshot.status, ticketOutcome, winningOutcome);
  // Only claimable when there is money to claim (WIN payout or REFUND). Losses are not claimable.
  const claimAmount = claimableAmount(result, usdcNumber(position.payout), usdcNumber(position.riskAmount));
  const claimable =
    ticketStatusValue === "OPEN" &&
    (marketSnapshot.status === "RESOLVED" || marketSnapshot.status === "CANCELLED") &&
    (result === "WIN" || result === "REFUND") &&
    (claimAmount ?? 0) > 0;

  const opening = await ensureTicketOpeningMeta({
    ticketId: ticketId.toString(),
    marketAddress: position.market,
    marketQuestion: marketSnapshot.question,
    outcome: ticketOutcome,
    createdAt
  });

  return {
    id: `PXLT-${ticketId.toString()}`,
    owner: position.owner,
    marketId: marketIdForAddress(position.market),
    marketQuestion: marketSnapshot.question,
    marketStatus: marketSnapshot.status,
    winningOutcome,
    outcome: ticketOutcome,
    riskAmount: usdcNumber(position.riskAmount),
    boost: Number(position.boostBps) / 10_000,
    quotedPrice: Number(position.quotedPrice) / 1_000_000,
    payout: usdcNumber(position.payout),
    requiredReserve: usdcNumber(position.reservedAmount),
    fee: usdcNumber(position.fee),
    status: ticketStatusValue,
    claimable,
    claimAmount,
    claimLabel: claimLabelFor(result, claimAmount),
    result,
    createdAt,
    openReferencePrice: opening?.referencePrice,
    openReferenceFeed: opening?.referenceFeed,
    openReferenceLabel: opening?.referenceLabel,
    openThreshold: opening?.threshold,
    openReferenceSource: opening?.source
  };
}

function configuredTicketFromBlock(): bigint {
  return parseBlockNumber(
    process.env.ARC_FROM_BLOCK
      ?? deployment.fromBlock
      ?? deployment.deploymentBlock
      ?? deployment.blockNumber
      ?? 0
  );
}

function recentTicketScanFromBlock(latestBlock: bigint): bigint {
  const configured = configuredTicketFromBlock();
  const recentWindow = configuredRecentScanBlocks();
  const recent = latestBlock > recentWindow ? latestBlock - recentWindow : 0n;
  return configured > recent ? configured : recent;
}

function configuredRecentScanBlocks(): bigint {
  const parsed = parseBlockNumber(process.env.ARC_RECENT_SCAN_BLOCKS ?? 250_000);
  return parsed > 0n ? parsed : 250_000n;
}

function configuredLogChunkSize(): bigint {
  const parsed = parseBlockNumber(process.env.ARC_LOG_CHUNK_SIZE ?? 50_000);
  if (parsed <= 0n) return 9_000n;
  return parsed > 9_000n ? 9_000n : parsed;
}

function parseBlockNumber(value: string | number | bigint): bigint {
  if (typeof value === "bigint") return value >= 0n ? value : 0n;
  if (typeof value === "number") return value > 0 ? BigInt(Math.floor(value)) : 0n;
  const trimmed = value.trim();
  if (!trimmed) return 0n;
  try {
    const parsed = BigInt(trimmed);
    return parsed >= 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function compareTicketIdsDesc(a: Ticket, b: Ticket): number {
  return Number(ticketIdNumber(b.id) - ticketIdNumber(a.id));
}

function ticketKey(ticketId: bigint): string {
  return `PXLT-${ticketId.toString()}`;
}

function ticketIdNumber(id: string): bigint {
  const numericPart = id.replace(/^PXLT-/, "");
  try {
    return BigInt(numericPart);
  } catch {
    return 0n;
  }
}

function clampNumber(value: unknown, min: number, max: number, fallbackValue: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackValue;
  return Math.min(max, Math.max(min, parsed));
}

function clampInteger(value: unknown, min: number, max: number, fallbackValue: number): number {
  return Math.round(clampNumber(value, min, max, fallbackValue));
}

export async function resolveMarketOnchain(id: string, outcome: Outcome) {
  assertDeployment();
  const item = findDemoMarket(id);
  if (!item) return undefined;
  const market = addr(item.market);
  const [status, lockTime] = await Promise.all([
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "status" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "lockTime" })
  ]);
  const statusNumber = Number(status);
  if (statusNumber !== 1 && statusNumber !== 2) {
    return {
      error: `Market cannot be resolved from ${contractStatus(statusNumber)} status. Select an open/locked market or create a new demo market.`
    };
  }
  if (statusNumber === 1 && Math.floor(Date.now() / 1000) < Number(lockTime)) {
    return {
      error: `Market is not locked yet. It can resolve after ${new Date(Number(lockTime) * 1000).toISOString()}.`
    };
  }
  const hash = await resolverWallet().writeContract({
    address: market,
    abi: marketAbi,
    functionName: "resolve",
    args: [outcome === "YES" ? 1 : 2]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status, market: await getOnchainMarket(id) };
}

export async function resolveReferenceMarketOnchain(id: string) {
  assertDeployment();
  const market = await getOnchainMarket(id);
  if (!market) return undefined;

  const data = await getDemoReferenceData();
  const obsStartMs = Date.parse(market.observationStart || "") || 0;

  // Permanent market rule: YES if end-of-observation print is higher than start-of-observation.
  // (Not vs price at market create — that was confusing on titles.)
  const q = (market.question || "").toLowerCase();
  const isBtc =
    market.demoRole === "btc_price" ||
    market.category === "crypto-candle" ||
    /\bbtc\b/.test(q) ||
    q.includes("bitcoin");
  const isWeather =
    market.demoRole === "london_weather" ||
    market.category === "weather" ||
    q.includes("london") ||
    q.includes("temp") ||
    q.includes("weather");

  if (isBtc) {
    const observedValue = data.btcUsd?.price;
    // If history has no sample near obs start, use end-ε fallback so resolve never stalls.
    const openValue =
      valueNearTime(data.btcUsd?.history, obsStartMs) ??
      valueNearTime(data.btcUsd?.history, Date.now() - 60_000) ??
      observedValue;
    if (!Number.isFinite(openValue) || !Number.isFinite(observedValue)) {
      return { error: "BTC reference is unavailable.", market };
    }
    const outcome: Outcome = (observedValue as number) > (openValue as number) ? "YES" : "NO";
    const result = await resolveMarketOnchain(id, outcome);
    return {
      ...result,
      outcome,
      observedValue,
      threshold: openValue,
      openValue,
      referenceSource: data.btcUsd?.source ?? "Coinbase spot"
    };
  }

  if (isWeather) {
    const observedValue = data.londonWeather?.temperatureC;
    const openValue =
      valueNearTime(data.londonWeather?.history, obsStartMs) ??
      valueNearTime(data.londonWeather?.history, Date.now() - 60_000) ??
      observedValue;
    if (!Number.isFinite(openValue) || !Number.isFinite(observedValue)) {
      return { error: "Weather reference is unavailable.", market };
    }
    const outcome: Outcome = (observedValue as number) > (openValue as number) ? "YES" : "NO";
    const result = await resolveMarketOnchain(id, outcome);
    return {
      ...result,
      outcome,
      observedValue,
      threshold: openValue,
      openValue,
      referenceSource: data.londonWeather?.source ?? "Open-Meteo"
    };
  }

  return { error: "Selected market is not a BTC/weather reference market.", market };
}

/** Closest sample at/after t, else nearest before. */
function valueNearTime(
  history: Array<{ value: number; at: number }> | undefined,
  t: number
): number | undefined {
  if (!history?.length || !Number.isFinite(t) || t <= 0) return undefined;
  let best: { value: number; dist: number } | undefined;
  for (const p of history) {
    if (!Number.isFinite(p?.value) || !Number.isFinite(p?.at)) continue;
    const dist = Math.abs(p.at - t);
    // Prefer samples at or after observation open when close
    const score = p.at >= t - 2_000 ? dist : dist + 60_000;
    if (!best || score < best.dist) best = { value: p.value, dist: score };
  }
  return best?.value;
}

export async function cancelMarketOnchain(id: string, reason: string) {
  assertDeployment();
  const item = findDemoMarket(id);
  if (!item) return undefined;
  const status = Number(await publicClient.readContract({ address: addr(item.market), abi: marketAbi, functionName: "status" }));
  if (status === 3 || status === 5) {
    return { error: "Market is already final and cannot be cancelled." };
  }
  const hash = await resolverWallet().writeContract({
    address: addr(item.market),
    abi: marketAbi,
    functionName: "cancel",
    args: [reason]
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status, market: await getOnchainMarket(id), reason };
}

export async function settleMarketTicketsOnchain(id: string) {
  assertDeployment();
  const item = findDemoMarket(id);
  if (!item) return undefined;
  const market = addr(item.market);
  const rawStatus = Number(await publicClient.readContract({ address: market, abi: marketAbi, functionName: "status" }));
  if (rawStatus !== 3 && rawStatus !== 4) {
    return { error: "Market must be resolved or cancelled before tickets can be settled." };
  }

  const logs = await ticketBoughtLogsForMarket(market, true);
  const wallet = resolverWallet();
  const settled: Array<{ ticketId: string; hash: string; status: string }> = [];
  const skipped: string[] = [];

  for (const log of logs) {
    const ticketId = log.args.ticketId;
    if (ticketId === undefined) continue;
    const position = await publicClient.readContract({
      address: addr(deployment.positionTicket),
      abi: ticketAbi,
      functionName: "getTicket",
      args: [ticketId]
    });
    if (Number(position.status) !== 1) {
      skipped.push(ticketId.toString());
      continue;
    }
    const hash = await wallet.writeContract({
      address: addr(deployment.microBoostEngine),
      abi: engineAbi,
      functionName: "settleTicket",
      args: [ticketId]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    settled.push({ ticketId: ticketId.toString(), hash, status: receipt.status });
  }

  return {
    market: await getOnchainMarket(id),
    settledCount: settled.length,
    skippedCount: skipped.length,
    settled,
    skipped
  };
}

export async function createMarketOnchain(body: {
  question?: unknown;
  yesPrice?: unknown;
  yesPricePercent?: unknown;
  lockSeconds?: unknown;
  observationSeconds?: unknown;
  sniperBufferSeconds?: unknown;
  lockPauseSeconds?: unknown;
  demoRole?: unknown;
}) {
  assertDeployment();
  const wallet = resolverWallet();
  const now = Math.floor(Date.now() / 1000);
  const rawQuestion = typeof body.question === "string" && body.question.trim()
    ? body.question.trim()
    : "Will the next admin-created demo signal be GREEN?";
  const requestedRole = normalizeDemoMarketRole(body.demoRole) ?? classifyQuestion(rawQuestion);
  // BTC / weather markets always get a concrete numeric threshold so auto-resolve works.
  const { question, role } = await materializeReferenceQuestion(rawQuestion, requestedRole);
  // Entry window, sniper buffer (lock before entry ends), pause, then observation.
  // Pad entry for create+open tx latency so the UI still shows a long OPEN window
  // after the market appears in the list (~10–20s later).
  const entrySeconds = clampInteger(body.lockSeconds, 30, 86_400, 75);
  const sniperBuffer = clampInteger(
    body.sniperBufferSeconds ?? process.env.MARKET_SNIPER_BUFFER_SECONDS,
    3,
    30,
    5
  );
  const lockPause = clampInteger(
    body.lockPauseSeconds ?? process.env.MARKET_LOCK_PAUSE_SECONDS,
    0,
    60,
    10
  );
  const observationSeconds = clampInteger(body.observationSeconds, 15, 86_400, 60);
  let yesPricePercent = Number(body.yesPricePercent ?? body.yesPrice ?? 50);
  // If caller did not pass a price, estimate fair mid from live feed for reference markets.
  if (body.yesPricePercent === undefined && body.yesPrice === undefined) {
    yesPricePercent = await estimateFairYesPercent(role);
  }
  // Constructor treats this as fair mid; contract applies overround margin on-chain.
  const yesPrice = BigInt(Math.round(clampNumber(yesPricePercent, 5, 95, 50) * 10_000));
  // Start open at "now" — do not backdate (that ate OPEN time before the market was listed).
  const openTime = BigInt(now);
  // Extra slack so lock is still ~55–65s after create+open confirmations.
  const txSlack = clampInteger(process.env.MARKET_CREATE_TX_SLACK_SECONDS, 0, 45, 18);
  const openDuration = Math.max(45, entrySeconds - sniperBuffer + txSlack);
  const lockTime = BigInt(now + openDuration);
  // Pause after lock so late prints cannot bleed into observation.
  const observationStart = lockTime + BigInt(lockPause);
  const observationEnd = observationStart + BigInt(observationSeconds);
  const rulesHash = keccak256(stringToHex(`${question}:${now}:${wallet.account.address}`));

  const createHash = await wallet.writeContract({
    address: addr(deployment.marketFactory),
    abi: factoryAbi,
    functionName: "createMarket",
    args: [question, rulesHash, openTime, lockTime, observationStart, observationEnd, yesPrice]
  });
  const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
  if (createReceipt.status !== "success") {
    return { createHash, status: createReceipt.status, error: "createMarket transaction failed" };
  }

  const logs = parseEventLogs({ abi: factoryAbi, logs: createReceipt.logs, eventName: "MarketCreated" });
  const marketAddress = logs[0]?.args.market;
  if (!marketAddress) {
    return { createHash, status: createReceipt.status, error: "MarketCreated event not found" };
  }

  const openHash = await wallet.writeContract({
    address: addr(marketAddress),
    abi: marketAbi,
    functionName: "open"
  });
  const openReceipt = await publicClient.waitForTransactionReceipt({ hash: openHash });
  const item: DemoMarketDeployment = {
    id: getAddress(marketAddress),
    label: "Admin-created market",
    role,
    market: getAddress(marketAddress)
  };
  exposeMarketInUi(item.market);

  return {
    createHash,
    openHash,
    status: openReceipt.status,
    marketAddress: item.market,
    market: await readOnchainMarket(item)
  };
}

function exposeMarketInUi(marketAddress: string): void {
  const key = addr(marketAddress).toLowerCase();
  hiddenMarketAddresses.delete(key);
  if (pinnedMarketAddresses) pinnedMarketAddresses.add(key);
  saveMarketUiState();
}

export async function hideMarketOnchain(id: string) {
  assertDeployment();
  const item = findDemoMarket(id);
  if (!item) return undefined;
  hiddenMarketAddresses.add(addr(item.market).toLowerCase());
  pinnedMarketAddresses?.delete(addr(item.market).toLowerCase());
  saveMarketUiState();
  return { status: "hidden", marketAddress: addr(item.market), hiddenCount: hiddenMarketAddresses.size };
}

export async function resetDemoMarketsOnchain() {
  assertDeployment();
  const existing = await listKnownMarkets({ includeHidden: true });
  for (const item of existing) hiddenMarketAddresses.add(addr(item.market).toLowerCase());

  const templates = await demoMarketTemplates();
  const created = [];
  for (const template of templates) {
    const result = await createMarketOnchain(template);
    if ("marketAddress" in result && result.marketAddress) {
      const marketAddress = addr(result.marketAddress);
      hiddenMarketAddresses.delete(marketAddress.toLowerCase());
      created.push(result);
    }
  }

  pinnedMarketAddresses = new Set(created
    .map((item) => item.marketAddress)
    .filter(Boolean)
    .map((market) => addr(market as string).toLowerCase()));
  saveMarketUiState();

  return {
    status: "success",
    createdCount: created.length,
    hiddenCount: hiddenMarketAddresses.size,
    markets: created.map((item) => item.market)
  };
}

type DemoReferenceData = {
  btcUsd?: Awaited<ReturnType<typeof fetchBtcSpot>>;
  londonWeather?: Awaited<ReturnType<typeof fetchWeather>>;
  updatedAt: string;
};

type HistoryPoint = { value: number; at: number };

let btcReferenceCache: { expiresAt: number; data: DemoReferenceData["btcUsd"] } | undefined;
let weatherReferenceCache: { expiresAt: number; data: NonNullable<DemoReferenceData["londonWeather"]> } | undefined;
let btcHistoryCache: { expiresAt: number; points: HistoryPoint[] } | undefined;
let weatherHistoryCache: { expiresAt: number; points: HistoryPoint[] } | undefined;
const btcTickHistory: HistoryPoint[] = [];
const weatherTickHistory: HistoryPoint[] = [];

export async function getDemoReferenceData() {
  const [btc, weather, btcHistory, weatherHistory] = await Promise.allSettled([
    fetchCachedBtcSpot(),
    fetchCachedWeather(),
    fetchCachedBtcHistory(),
    fetchCachedWeatherHistory()
  ]);
  const btcData = btc.status === "fulfilled" ? btc.value : undefined;
  if (btcData && Number.isFinite(btcData.price)) {
    pushTick(btcTickHistory, btcData.price, Date.parse(btcData.updatedAt) || Date.now(), 800);
  }
  const weatherData = weather.status === "fulfilled" ? weather.value : undefined;
  if (weatherData && Number.isFinite(weatherData.temperatureC)) {
    pushTick(
      weatherTickHistory,
      weatherData.temperatureC,
      Date.parse(weatherData.updatedAt) || Date.now(),
      2_500
    );
  }

  const btcCandles = btcHistory.status === "fulfilled" ? btcHistory.value : [];
  const weatherSeries = weatherHistory.status === "fulfilled" ? weatherHistory.value : [];
  const weatherFromFeed =
    weatherData?.history && weatherData.history.length >= 4
      ? weatherData.history
      : weatherSeries;

  return {
    btcUsd: btcData
      ? {
          ...btcData,
          history: mergeHistory(btcCandles, btcTickHistory, 1).slice(-90)
        }
      : undefined,
    londonWeather: weatherData
      ? {
          ...weatherData,
          history: mergeHistory(weatherFromFeed, weatherTickHistory, 15).slice(-120)
        }
      : undefined,
    updatedAt: new Date().toISOString()
  };
}

async function fetchCachedBtcSpot() {
  const now = Date.now();
  // Coinbase Exchange public ticker is cacheable ~1s; keep server cache slightly under that.
  if (btcReferenceCache && btcReferenceCache.expiresAt > now) return btcReferenceCache.data;
  const data = await fetchBtcSpot();
  btcReferenceCache = { data, expiresAt: now + 900 };
  return data;
}

/** Last good weather kept for full-time resilience when upstream APIs flake. */
let weatherStaleCache: { data: NonNullable<DemoReferenceData["londonWeather"]>; savedAt: number } | undefined;
const WEATHER_STALE_MAX_MS = 45 * 60_000;

async function fetchCachedWeather() {
  const now = Date.now();
  if (weatherReferenceCache && weatherReferenceCache.expiresAt > now) return weatherReferenceCache.data;
  try {
    const data = await fetchWeather("London", 51.5072, -0.1276);
    weatherReferenceCache = { data, expiresAt: now + 8_000 };
    weatherStaleCache = { data, savedAt: now };
    return data;
  } catch (error) {
    if (weatherStaleCache && now - weatherStaleCache.savedAt < WEATHER_STALE_MAX_MS) {
      // Serve last good reading so charts/resolve keep working through outages.
      return {
        ...weatherStaleCache.data,
        source: `${weatherStaleCache.data.source} (cached)`,
        updatedAt: new Date().toISOString()
      };
    }
    throw error;
  }
}

async function fetchCachedBtcHistory(): Promise<HistoryPoint[]> {
  const now = Date.now();
  if (btcHistoryCache && btcHistoryCache.expiresAt > now) return btcHistoryCache.points;
  const points = await fetchBtcCandles();
  btcHistoryCache = { points, expiresAt: now + 20_000 };
  return points;
}

async function fetchCachedWeatherHistory(): Promise<HistoryPoint[]> {
  const now = Date.now();
  if (weatherHistoryCache && weatherHistoryCache.expiresAt > now) return weatherHistoryCache.points;
  const points = await fetchWeatherHistory(51.5072, -0.1276);
  weatherHistoryCache = { points, expiresAt: now + 30_000 };
  return points;
}

function pushTick(series: HistoryPoint[], value: number, at: number, minGapMs: number): void {
  const last = series[series.length - 1];
  if (last && Math.abs(last.value - value) < 0.0001 && at - last.at < minGapMs) return;
  if (last && at < last.at) return;
  // Update last sample in place when still inside the gap window.
  if (last && at - last.at < minGapMs) {
    series[series.length - 1] = { value, at: Math.max(last.at, at) };
    return;
  }
  series.push({ value, at });
  if (series.length > 200) series.splice(0, series.length - 200);
}

/** Merge candle/history base with recent live ticks (preserves base curve). */
function mergeHistory(base: HistoryPoint[], ticks: HistoryPoint[], bucketMinutes = 1): HistoryPoint[] {
  const bucketMs = Math.max(1, bucketMinutes) * 60_000;
  const byBucket = new Map<number, HistoryPoint>();
  for (const point of base) {
    if (!Number.isFinite(point.value) || !Number.isFinite(point.at)) continue;
    byBucket.set(Math.floor(point.at / bucketMs), { value: point.value, at: point.at });
  }
  let series = [...byBucket.values()].sort((a, b) => a.at - b.at);

  const lastBaseAt = series.length ? series[series.length - 1].at : 0;
  // Only stitch ticks from the last base bucket forward (live tail).
  const tailStart = lastBaseAt > 0 ? lastBaseAt - bucketMs : 0;
  const recentTicks = ticks
    .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.at) && point.at >= tailStart)
    .sort((a, b) => a.at - b.at);

  for (const tick of recentTicks) {
    const last = series[series.length - 1];
    if (!last) {
      series.push({ value: tick.value, at: tick.at });
      continue;
    }
    if (tick.at < last.at) continue;
    // Update last sample if still inside the same base bucket / few seconds.
    if (tick.at - last.at < Math.min(bucketMs, 8_000) || Math.floor(tick.at / bucketMs) === Math.floor(last.at / bucketMs)) {
      series[series.length - 1] = { value: tick.value, at: Math.max(last.at, tick.at) };
    } else {
      series.push({ value: tick.value, at: tick.at });
    }
  }

  if (series.length > 120) series = series.slice(-120);
  return series;
}

function resolverWallet() {
  // Accept common aliases so Vercel env can use DEPLOYER_* or ORACLE_*
  const key =
    process.env.ORACLE_PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    process.env.ARC_DEPLOYER_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "ORACLE_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY / PRIVATE_KEY) is required for create/resolve/cancel"
    );
  }
  const normalized = key.startsWith("0x") ? key : `0x${key}`;
  return createWalletClient({
    account: privateKeyToAccount(normalized as `0x${string}`),
    chain: arcChain,
    transport: arcTransport
  });
}


function buildRpcUrls(config?: Deployment): string[] {
  const envUrls = (process.env.ARC_RPC_URLS ?? process.env.NEXT_PUBLIC_ARC_RPC_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return Array.from(new Set([
    ...envUrls,
    ...(Array.isArray(config?.rpcUrls) ? config.rpcUrls : []),
    config?.rpcUrl,
    "https://rpc.testnet.arc.network",
    "https://arc-testnet.drpc.org"
  ].filter(Boolean) as string[])).filter(isStableArcRpcUrl);
}

function isStableArcRpcUrl(url: string): boolean {
  return !url.includes("quicknode") && !url.includes("blockdaemon");
}

function buildRpcTransport(urls: string[]) {
  // Batch concurrent eth_calls into one JSON-RPC request (a market read is 10
  // calls; a list is 10×N). Not every gateway accepts batch arrays, so each URL
  // gets a [batched, plain] pair inside fallback() — if the batched transport
  // errors, viem automatically degrades to plain per-call requests instead of
  // taking the whole read path down. RPC_BATCH=0 disables batching entirely.
  if (process.env.RPC_BATCH === "0") {
    const plain = urls.map((url) => http(url));
    return plain.length === 1 ? plain[0] : fallback(plain, { rank: false });
  }
  const transports = urls.flatMap((url) => [
    http(url, { batch: { batchSize: 25, wait: 16 } }),
    http(url)
  ]);
  return fallback(transports, { rank: false });
}

function loadDeployment(): Deployment {
  const candidates = [
    process.env.PROBX_DEPLOYMENT_PATH,
    // Next Root Directory = apps/web (Vercel)
    resolve(process.cwd(), "src/lib/deployment.json"),
    resolve(process.cwd(), "../web/src/lib/deployment.json"),
    resolve(process.cwd(), "apps/web/src/lib/deployment.json"),
    // Next to this module (src/config or dist/config)
    resolve(__dirname, "../config/arc-deployment.json"),
    resolve(__dirname, "../../../web/src/lib/deployment.json"),
    resolve(__dirname, "../../../../apps/web/src/lib/deployment.json"),
    resolve(__dirname, "../../../../web/src/lib/deployment.json"),
    resolve(process.cwd(), "docs/DEPLOYMENT_ARC_TESTNET.json"),
    resolve(process.cwd(), "../../docs/DEPLOYMENT_ARC_TESTNET.json")
  ].filter(Boolean) as string[];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Deployment;
      if (parsed?.microBoostEngine && parsed?.demoMarket) return parsed;
    } catch {
      // fall through to bundled
    }
  }
  // Always available after Next bundles this module (no fs needed)
  return bundledArcDeployment as Deployment;
}

function assertDeployment(): void {
  if (!hasDeployment) {
    throw new Error("Arc deployment is not configured");
  }
}

function loadMarketUiState(): MarketUiState {
  try {
    if (!existsSync(marketUiStatePath)) return { hidden: [] };
    const parsed = JSON.parse(readFileSync(marketUiStatePath, "utf8")) as Partial<MarketUiState>;
    return {
      hidden: normalizeAddressList(parsed.hidden),
      pinned: Array.isArray(parsed.pinned) ? normalizeAddressList(parsed.pinned) : undefined
    };
  } catch {
    return { hidden: [] };
  }
}

function saveMarketUiState(): void {
  mkdirSync(dirname(marketUiStatePath), { recursive: true });
  writeFileSync(
    marketUiStatePath,
    JSON.stringify({
      hidden: Array.from(hiddenMarketAddresses),
      pinned: pinnedMarketAddresses ? Array.from(pinnedMarketAddresses) : undefined
    }, null, 2),
    "utf8"
  );
}

function normalizeAddressList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (typeof value !== "string") return [];
    try {
      return [getAddress(value).toLowerCase()];
    } catch {
      return [];
    }
  });
}

function deployedDemoMarkets(): DemoMarketDeployment[] {
  const configured = Array.isArray(deployment.demoMarkets)
    ? deployment.demoMarkets.filter((item) => item?.market)
    : [];
  if (configured.length > 0) return configured;
  return deployment.demoMarket
    ? [{ id: "mkt_demo_green", label: "Legacy demo market", role: "legacy", market: deployment.demoMarket }]
    : [];
}

async function listKnownMarkets(options: { includeHidden?: boolean } = {}): Promise<DemoMarketDeployment[]> {
  const markets = uniqueDemoMarkets([...(await factoryMarkets()), ...deployedDemoMarkets()]);
  return markets.filter((market) => {
    const key = addr(market.market).toLowerCase();
    if (pinnedMarketAddresses && !pinnedMarketAddresses.has(key)) return false;
    return options.includeHidden || !hiddenMarketAddresses.has(key);
  });
}

async function factoryMarkets(): Promise<DemoMarketDeployment[]> {
  if (!deployment.marketFactory) return [];
  try {
    const markets = await publicClient.readContract({
      address: addr(deployment.marketFactory),
      abi: factoryAbi,
      functionName: "getMarkets"
    });
    return markets.slice(-configuredMarketListLimit()).reverse().map((item, index) => ({
      id: getAddress(item.market),
      label: `Recent factory market ${index + 1}`,
      role: "legacy",
      market: getAddress(item.market)
    }));
  } catch {
    return [];
  }
}

function configuredMarketListLimit(): number {
  const parsed = Number(process.env.ARC_MARKET_LIST_LIMIT ?? "18");
  if (!Number.isFinite(parsed) || parsed <= 0) return 18;
  return Math.min(50, Math.max(3, Math.floor(parsed)));
}

/** Fixed titles — resolve compares end vs start of observation, not create-time spot. */
const BTC_OBS_QUESTION = "Will BTC finish observation higher than it started?";
const WEATHER_OBS_QUESTION = "Will London temp finish observation higher than it started?";

async function demoMarketTemplates() {
  // Hackathon demo set: only the two auto-resolving reference markets.
  const lockSeconds = clampInteger(process.env.DEMO_MARKET_LOCK_SECONDS, 45, 86_400, 3_600);
  const btcFair = await estimateFairYesPercent("btc_price");
  const weatherFair = await estimateFairYesPercent("london_weather");
  return [
    {
      question: BTC_OBS_QUESTION,
      demoRole: "btc_price",
      yesPricePercent: btcFair,
      lockSeconds,
      observationSeconds: 60
    },
    {
      question: WEATHER_OBS_QUESTION,
      demoRole: "london_weather",
      yesPricePercent: weatherFair,
      lockSeconds,
      observationSeconds: 60
    }
  ];
}

/**
 * Fair mid YES% from live feed structure (not a flat 50/50 seed).
 * BTC 1-minute up/down ≈ coin-flip with a small drift tilt from recent ticks.
 * Weather "≥ current temp" over 1 minute is sticky → YES slightly favoured.
 */
async function estimateFairYesPercent(role: DemoMarketRole): Promise<number> {
  try {
    const data = await getDemoReferenceData();
    if (role === "btc_price") {
      const history = data.btcUsd?.history ?? [];
      if (history.length >= 4) {
        const last = history[history.length - 1]!.value;
        const prev = history[Math.max(0, history.length - 6)]!.value;
        if (prev > 0 && last > 0) {
          const ret = (last - prev) / prev;
          // Mild drift tilt: ±3pp around 50% for short windows.
          return clampNumber(50 + ret * 1000, 42, 58, 50);
        }
      }
      return 50;
    }
    if (role === "london_weather") {
      // Temperature is highly autocorrelated over 60s; "≥ now" has modest YES edge.
      const history = data.londonWeather?.history ?? [];
      if (history.length >= 3) {
        const last = history[history.length - 1]!.value;
        const prev = history[0]!.value;
        const delta = last - prev;
        return clampNumber(54 + delta * 2, 48, 62, 54);
      }
      return 54;
    }
  } catch {
    // fall through
  }
  return role === "london_weather" ? 54 : 50;
}

/**
 * Force fixed BTC/weather titles (no create-time spot in the question).
 * Resolution uses observation start vs end prints from the live feed.
 */
async function materializeReferenceQuestion(
  question: string,
  role: DemoMarketRole
): Promise<{ question: string; role: DemoMarketRole }> {
  if (role === "btc_price") {
    return { question: BTC_OBS_QUESTION, role };
  }
  if (role === "london_weather") {
    return { question: WEATHER_OBS_QUESTION, role };
  }
  return { question, role };
}

/**
 * Coinbase Exchange public ticker (cache-control max-age≈1s).
 * Public rate limit is generous (~10 rps/IP); we poll ~1 Hz server-side.
 * Retail api.coinbase.com/v2 spot is cached up to 60s — too slow for live charts.
 */
async function fetchBtcSpot() {
  try {
    const response = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/ticker", {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`BTC exchange ticker HTTP ${response.status}`);
    const payload = await response.json() as { price?: string; time?: string; bid?: string; ask?: string };
    const price = Number(payload.price ?? 0);
    if (!Number.isFinite(price) || price <= 0) throw new Error("invalid BTC price");
    return {
      symbol: "BTC-USD",
      price,
      bid: Number(payload.bid ?? 0) || undefined,
      ask: Number(payload.ask ?? 0) || undefined,
      source: "Coinbase Exchange ticker",
      updatedAt: payload.time ? new Date(payload.time).toISOString() : new Date().toISOString()
    };
  } catch {
    // Fallback to retail spot if exchange endpoint is blocked.
    const response = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`BTC spot HTTP ${response.status}`);
    const payload = await response.json() as { data?: { amount?: string; currency?: string } };
    return {
      symbol: "BTC-USD",
      price: Number(payload.data?.amount ?? 0),
      source: "Coinbase retail spot",
      updatedAt: new Date().toISOString()
    };
  }
}

/** 1-minute candles for chart history: [time, low, high, open, close, volume] */
async function fetchBtcCandles(): Promise<HistoryPoint[]> {
  const response = await fetch("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60", {
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`BTC candles HTTP ${response.status}`);
  const rows = await response.json() as Array<[number, number, number, number, number, number]>;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      at: Number(row[0]) * 1_000,
      value: Number(row[4]) // close
    }))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.value) && point.value > 0)
    .sort((a, b) => a.at - b.at)
    .slice(-60);
}

/**
 * Weather with a real curve for charts:
 * 1) Open-Meteo current + 24h hourly (free, no key)
 * 2) MET Norway locationforecast as fallback (dense timeseries)
 * Timeouts avoid hung requests making /api/demo-data look empty.
 */
async function fetchWeather(city: string, latitude: number, longitude: number) {
  const errors: string[] = [];
  try {
    return await fetchWeatherOpenMeteo(city, latitude, longitude);
  } catch (error) {
    errors.push(`open-meteo: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return await fetchWeatherMetNo(city, latitude, longitude);
  } catch (error) {
    errors.push(`met.no: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return await fetchWeatherOpenMeteoAlt(city, latitude, longitude);
  } catch (error) {
    errors.push(`open-meteo-alt: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`Weather unavailable (${errors.join("; ")})`);
}

async function fetchWeatherOpenMeteo(city: string, latitude: number, longitude: number) {
  return fetchWeatherOpenMeteoHost("https://api.open-meteo.com", city, latitude, longitude, "Open-Meteo");
}

/** Customer CDN mirror — used if primary Open-Meteo is rate-limited. */
async function fetchWeatherOpenMeteoAlt(city: string, latitude: number, longitude: number) {
  return fetchWeatherOpenMeteoHost(
    "https://customer-free.open-meteo.com",
    city,
    latitude,
    longitude,
    "Open-Meteo mirror"
  ).catch(async () =>
    // Simple hourly-only endpoint (lighter, more reliable under load)
    fetchWeatherOpenMeteoHourlyOnly(city, latitude, longitude)
  );
}

async function fetchWeatherOpenMeteoHost(
  host: string,
  city: string,
  latitude: number,
  longitude: number,
  sourceLabel: string
) {
  const base = host.replace(/\/$/, "");
  const url =
    `${base}/v1/forecast?latitude=${latitude}&longitude=${longitude}`
    + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code`
    + `&minutely_15=temperature_2m&past_minutely_15=96&forecast_minutely_15=4`
    + `&hourly=temperature_2m&past_hours=24&forecast_hours=1`
    + `&timezone=UTC`;
  const payload = await fetchJsonWithTimeout<{
    current?: {
      temperature_2m?: number;
      apparent_temperature?: number;
      relative_humidity_2m?: number;
      weather_code?: number;
      time?: string;
    };
    minutely_15?: { time?: string[]; temperature_2m?: Array<number | null> };
    hourly?: { time?: string[]; temperature_2m?: Array<number | null> };
  }>(url, { accept: "application/json" }, 7_000);

  const currentTemp = Number(payload.current?.temperature_2m ?? 0);
  if (!Number.isFinite(currentTemp)) throw new Error(`invalid ${sourceLabel} temperature`);

  const minutely = seriesFromOpenMeteo(payload.minutely_15?.time, payload.minutely_15?.temperature_2m);
  const hourly = seriesFromOpenMeteo(payload.hourly?.time, payload.hourly?.temperature_2m);
  const baseHistory = minutely.length >= 8 ? minutely : hourly;
  const history = appendCurrentPoint(baseHistory, currentTemp);

  return {
    city,
    temperatureC: currentTemp,
    feelsLikeC: Number.isFinite(Number(payload.current?.apparent_temperature))
      ? Number(payload.current?.apparent_temperature)
      : undefined,
    humidity: Number.isFinite(Number(payload.current?.relative_humidity_2m))
      ? Number(payload.current?.relative_humidity_2m)
      : undefined,
    weatherCode: payload.current?.weather_code,
    source: minutely.length >= 8 ? `${sourceLabel} 15m` : `${sourceLabel} hourly`,
    observedAt: payload.current?.time,
    updatedAt: new Date().toISOString(),
    history
  };
}

async function fetchWeatherOpenMeteoHourlyOnly(city: string, latitude: number, longitude: number) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
    + `&current=temperature_2m,relative_humidity_2m`
    + `&hourly=temperature_2m&past_hours=48&forecast_hours=1&timezone=UTC`;
  const payload = await fetchJsonWithTimeout<{
    current?: { temperature_2m?: number; relative_humidity_2m?: number; time?: string };
    hourly?: { time?: string[]; temperature_2m?: Array<number | null> };
  }>(url, { accept: "application/json" }, 6_000);
  const currentTemp = Number(payload.current?.temperature_2m ?? 0);
  if (!Number.isFinite(currentTemp)) throw new Error("invalid Open-Meteo hourly temperature");
  const hourly = seriesFromOpenMeteo(payload.hourly?.time, payload.hourly?.temperature_2m);
  return {
    city,
    temperatureC: currentTemp,
    humidity: Number.isFinite(Number(payload.current?.relative_humidity_2m))
      ? Number(payload.current?.relative_humidity_2m)
      : undefined,
    source: "Open-Meteo hourly-lite",
    observedAt: payload.current?.time,
    updatedAt: new Date().toISOString(),
    history: appendCurrentPoint(hourly, currentTemp)
  };
}

async function fetchWeatherMetNo(city: string, latitude: number, longitude: number) {
  // https://api.met.no/weatherapi/locationforecast/2.0/documentation
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${latitude}&lon=${longitude}`;
  const payload = await fetchJsonWithTimeout<{
    properties?: {
      timeseries?: Array<{
        time?: string;
        data?: { instant?: { details?: { air_temperature?: number; relative_humidity?: number } } };
      }>;
    };
  }>(url, {
    accept: "application/json",
    "user-agent": "ProbXArc/1.0"
  }, 8_000);

  const series = payload.properties?.timeseries ?? [];
  const history: HistoryPoint[] = [];
  for (const row of series) {
    const value = Number(row.data?.instant?.details?.air_temperature);
    const at = Date.parse(row.time ?? "");
    if (!Number.isFinite(value) || !Number.isFinite(at)) continue;
    if (at > Date.now() + 2 * 60 * 60_000) continue;
    history.push({ value, at });
  }
  history.sort((a, b) => a.at - b.at);
  if (!history.length) throw new Error("MET Norway series empty");

  const nowPts = history.filter((point) => point.at <= Date.now());
  const current = nowPts[nowPts.length - 1] ?? history[0];
  const humidity = Number(series[0]?.data?.instant?.details?.relative_humidity);

  return {
    city,
    temperatureC: current.value,
    humidity: Number.isFinite(humidity) ? humidity : undefined,
    source: "MET Norway locationforecast",
    observedAt: new Date(current.at).toISOString(),
    updatedAt: new Date().toISOString(),
    history: history.slice(-72)
  };
}

function appendCurrentPoint(base: HistoryPoint[], currentTemp: number): HistoryPoint[] {
  if (!Number.isFinite(currentTemp)) return base;
  const now = Date.now();
  const last = base[base.length - 1];
  if (!last || Math.abs(last.value - currentTemp) > 0.01 || now - last.at > 60_000) {
    return [...base, { value: currentTemp, at: now }];
  }
  return base;
}

function seriesFromOpenMeteo(
  times?: string[],
  values?: Array<number | null>
): HistoryPoint[] {
  if (!Array.isArray(times) || !Array.isArray(values)) return [];
  const points: HistoryPoint[] = [];
  const len = Math.min(times.length, values.length);
  for (let i = 0; i < len; i++) {
    const value = values[i];
    if (value === null || value === undefined || !Number.isFinite(Number(value))) continue;
    const at = Date.parse(times[i]);
    if (!Number.isFinite(at)) continue;
    // Skip far-future forecast points for chart clarity.
    if (at > Date.now() + 30 * 60_000) continue;
    points.push({ value: Number(value), at });
  }
  return points.sort((a, b) => a.at - b.at);
}

async function fetchWeatherHistory(latitude: number, longitude: number): Promise<HistoryPoint[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
    + `&hourly=temperature_2m&past_hours=36&forecast_hours=0&timezone=UTC`;
  try {
    const payload = await fetchJsonWithTimeout<{
      hourly?: { time?: string[]; temperature_2m?: Array<number | null> };
    }>(url, { accept: "application/json" }, 8_000);
    const points = seriesFromOpenMeteo(payload.hourly?.time, payload.hourly?.temperature_2m);
    if (points.length) return points;
  } catch {
    // fall through to MET Norway
  }
  try {
    const met = await fetchWeatherMetNo("London", latitude, longitude);
    return met.history ?? [];
  } catch {
    return [];
  }
}

async function fetchJsonWithTimeout<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Volume-weighted market odds with a prior so empty markets stay near 50/50
 * and each YES/NO buy visibly shifts share of open interest.
 */
function flowOddsFromVolume(yesVolume: number, noVolume: number): { yes: number; no: number } {
  const prior = 5; // synthetic USDC prior on each side
  const yes = Math.max(0, yesVolume) + prior;
  const no = Math.max(0, noVolume) + prior;
  const total = yes + no;
  const yesPrice = clampNumber(yes / total, 0.02, 0.98, 0.5);
  return { yes: yesPrice, no: 1 - yesPrice };
}

async function ensureTicketOpeningMeta(input: {
  ticketId: string;
  marketAddress: string;
  marketQuestion: string;
  outcome: Outcome;
  createdAt: string;
}) {
  const { getTicketOpening, upsertTicketOpening } = await import("./ticketOpenings.js");
  const existing = getTicketOpening(input.ticketId);
  if (existing?.referencePrice !== undefined) return existing;

  const role = classifyQuestion(input.marketQuestion);
  try {
    const data = await getDemoReferenceData();
    if (role === "btc_price" && data.btcUsd?.price) {
      return upsertTicketOpening({
        ticketId: input.ticketId,
        marketAddress: input.marketAddress,
        outcome: input.outcome,
        referencePrice: data.btcUsd.price,
        referenceFeed: "btc",
        referenceLabel: "BTC/USD at ticket open (settle uses observation end)",
        threshold: parseBtcThreshold(input.marketQuestion),
        source: data.btcUsd.source,
        openedAt: input.createdAt
      });
    }
    if (role === "london_weather" && data.londonWeather?.temperatureC !== undefined) {
      return upsertTicketOpening({
        ticketId: input.ticketId,
        marketAddress: input.marketAddress,
        outcome: input.outcome,
        referencePrice: data.londonWeather.temperatureC,
        referenceFeed: "weather",
        referenceLabel: "London temp at ticket open (settle uses observation end)",
        threshold: parseWeatherThreshold(input.marketQuestion),
        source: data.londonWeather.source,
        openedAt: input.createdAt
      });
    }
  } catch {
    // Opening meta is best-effort for demo UX.
  }
  return existing;
}

export async function recordTicketOpening(body: {
  ticketId?: unknown;
  marketId?: unknown;
  marketAddress?: unknown;
  outcome?: unknown;
  referencePrice?: unknown;
  referenceFeed?: unknown;
  threshold?: unknown;
  source?: unknown;
}) {
  const { upsertTicketOpening } = await import("./ticketOpenings.js");
  const ticketId = String(body.ticketId ?? "").replace(/^PXLT-/i, "").trim();
  if (!ticketId) return { error: "ticketId is required" };
  const referencePrice = Number(body.referencePrice);
  const feed = body.referenceFeed === "weather" ? "weather" as const : body.referenceFeed === "btc" ? "btc" as const : "none" as const;
  const meta = upsertTicketOpening({
    ticketId,
    marketId: typeof body.marketId === "string" ? body.marketId : undefined,
    marketAddress: typeof body.marketAddress === "string" ? body.marketAddress : undefined,
    outcome: body.outcome === "NO" ? "NO" : body.outcome === "YES" ? "YES" : undefined,
    referencePrice: Number.isFinite(referencePrice) ? referencePrice : undefined,
    referenceFeed: feed,
    referenceLabel:
      feed === "btc"
        ? "BTC/USD at ticket open (settle uses observation end)"
        : feed === "weather"
          ? "London temp at ticket open (settle uses observation end)"
          : "Reference at ticket open",
    threshold: Number.isFinite(Number(body.threshold)) ? Number(body.threshold) : undefined,
    source: typeof body.source === "string" ? body.source : undefined,
    openedAt: new Date().toISOString()
  });
  return { status: "ok", opening: meta };
}

function uniqueDemoMarkets(markets: DemoMarketDeployment[]): DemoMarketDeployment[] {
  const seen = new Set<string>();
  return markets.filter((market) => {
    const key = market.market.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findDemoMarket(id: string): DemoMarketDeployment | undefined {
  const configured = deployedDemoMarkets().find((item) => demoMarketId(item) === id || sameAddressSafe(id, item.market));
  if (configured) return configured;
  try {
    const market = getAddress(id);
    return { id: `mkt_${market.slice(2, 10).toLowerCase()}`, label: "Ad hoc demo market", role: "legacy", market };
  } catch {
    return undefined;
  }
}

function demoMarketId(item: DemoMarketDeployment): string {
  return item.id ?? `mkt_${item.market.slice(2, 10).toLowerCase()}`;
}

/** Always use checksum 0x address so portfolio links resolve after hide/archive. */
function marketIdForAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return findDemoMarket(address)?.id ?? address;
  }
}

function classifyDemoMarket(item: DemoMarketDeployment, question: string): DemoMarketRole {
  return item.role && item.role !== "legacy" ? item.role : classifyQuestion(question);
}

function classifyQuestion(question: string): DemoMarketRole {
  const normalized = question.toLowerCase();
  // Fixed titles: "Will BTC finish observation…" / "Will London temp finish…"
  if (/\bbtc\b/.test(normalized) || normalized.includes("bitcoin") || normalized.includes("btc/usd")) {
    return "btc_price";
  }
  if (
    normalized.includes("london") ||
    normalized.includes("weather") ||
    normalized.includes("temp") ||
    normalized.includes("open-meteo")
  ) {
    return "london_weather";
  }
  return "open";
}

function normalizeDemoMarketRole(value: unknown): DemoMarketRole | undefined {
  if (value === "open" || value === "btc_price" || value === "london_weather" || value === "near_lock" || value === "resolved" || value === "legacy") {
    return value;
  }
  return undefined;
}

function parseBtcThreshold(question: string): number {
  const match =
    question.match(/open\s*\(\$?([\d,]+(?:\.\d+)?)\)/i) ||
    question.match(/(?:at or above|above|≥)\s+\$?([\d,]+(?:\.\d+)?)/i) ||
    question.match(/\$([\d,]+(?:\.\d+)?)/);
  return match ? Number(match[1].replace(/,/g, "")) : Number.NaN;
}

function parseWeatherThreshold(question: string): number {
  const match =
    question.match(/open\s*\((-?[\d.]+)\s*°?C?\)/i) ||
    question.match(/at least\s+(-?[\d.]+)\s*°?C/i) ||
    question.match(/≥\s*(-?[\d.]+)\s*°?C/i) ||
    question.match(/(-?[\d.]+)\s*°C/);
  return match ? Number(match[1]) : Number.NaN;
}

function demoCategory(role: DemoMarketRole): Market["category"] {
  if (role === "btc_price") return "crypto-candle";
  if (role === "london_weather") return "weather";
  return "demo-signal";
}

function demoResolutionSource(role: DemoMarketRole): string {
  if (role === "btc_price") return "Auto-resolve from Coinbase BTC/USD after observation";
  if (role === "london_weather") return "Auto-resolve from Open-Meteo London temp after observation";
  return "Manual admin resolve (demo signal)";
}

function demoRules(role?: DemoMarketRole, question?: string): string {
  if (role === "btc_price") {
    return `Bet while OPEN. YES if Coinbase BTC/USD is higher at observation end than at observation start. NO if flat or lower. Claim from Portfolio after resolve.`;
  }
  if (role === "london_weather") {
    return `Bet while OPEN. YES if London temp is higher at observation end than at observation start. NO if flat or lower. Claim from Portfolio after resolve.`;
  }
  if (role === "near_lock") return "Near-lock demo: buy quickly, then resolve after the short observation window.";
  if (role === "resolved") return "Resolved demo market for settlement walkthroughs.";
  return "Manual market: admin resolves YES/NO after lock. Auto-resolve only applies to BTC and London weather markets.";
}

function compareDemoMarkets(a: Market, b: Market): number {
  const rank = { OPEN: 0, LOCKED: 1, RESOLVED: 2, CANCELLED: 3, CREATED: 4, OBSERVATION: 5, ARCHIVED: 6 } as const;
  const rankDiff = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
  if (rankDiff !== 0) return rankDiff;
  return Date.parse(b.lockTime) - Date.parse(a.lockTime);
}

function addr(value: string) {
  return getAddress(value);
}

function sameAddress(a: string, b: string): boolean {
  return getAddress(a) === getAddress(b);
}

function sameAddressSafe(a: string, b: string): boolean {
  try {
    return sameAddress(a, b);
  } catch {
    return false;
  }
}

function usdcNumber(value: bigint): number {
  return Number(formatUnits(value, 6));
}

function unixToIso(value: bigint): string {
  return new Date(Number(value) * 1000).toISOString();
}

function contractStatus(status: number): MarketStatus {
  if (status === 0) return "CREATED";
  if (status === 1) return "OPEN";
  if (status === 2) return "LOCKED";
  if (status === 3) return "RESOLVED";
  if (status === 4) return "CANCELLED";
  return "ARCHIVED";
}

function displayedMarketStatus(status: number, lockTime: bigint): MarketStatus {
  if (status === 1 && Math.floor(Date.now() / 1000) >= Number(lockTime)) return "LOCKED";
  return contractStatus(status);
}

function ticketStatus(status: number): Ticket["status"] {
  if (status === 2) return "SETTLED";
  if (status === 3) return "CANCELLED";
  return "OPEN";
}

function ticketResult(
  ticketStatusValue: Ticket["status"],
  marketStatus: MarketStatus,
  ticketOutcome: Outcome,
  winningOutcome?: Outcome
): Ticket["result"] | undefined {
  // Cancelled markets always refund risk (whether still open or already settled as cancelled).
  if (marketStatus === "CANCELLED") return "REFUND";
  if (ticketStatusValue === "CANCELLED") return "REFUND";
  if (!winningOutcome || marketStatus !== "RESOLVED") return undefined;
  // Show WIN/LOSS as soon as the market resolves so Portfolio can explain claim amounts.
  return ticketOutcome === winningOutcome ? "WIN" : "LOSS";
}

function claimableAmount(
  result: Ticket["result"] | undefined,
  payout: number,
  riskAmount: number
): number | undefined {
  if (result === "WIN") return payout;
  if (result === "REFUND") return riskAmount;
  if (result === "LOSS") return 0;
  return undefined;
}

function claimLabelFor(result: Ticket["result"] | undefined, claimAmount: number | undefined): string | undefined {
  if (result === "WIN") {
    return `Claim ${formatClaimUsdc(claimAmount)} USDC payout`;
  }
  if (result === "REFUND") {
    return `Claim ${formatClaimUsdc(claimAmount)} USDC refund`;
  }
  if (result === "LOSS") {
    return "Close ticket (lost — no payout)";
  }
  return undefined;
}

function formatClaimUsdc(value: number | undefined): string {
  if (!Number.isFinite(value)) return "0.00";
  return (value as number).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function normalizeOutcome(value: string | null): Outcome {
  return value?.toUpperCase() === "NO" ? "NO" : "YES";
}
