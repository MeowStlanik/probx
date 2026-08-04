// Aliased: a local `createHash` (a tx hash) already exists further down this file.
import { createHash as sha256, randomBytes } from "node:crypto";
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
import type {
  LpSnapshot,
  Market,
  MarketObservationEvidence,
  MarketObservationPoint,
  MarketStatus,
  Outcome,
  PriceQuote,
  Ticket
} from "../db/schema.js";
import { runtimeFile } from "../runtimePaths.js";
/** Bundled with the API so deployment paths cannot hide the Arc addresses. */
import bundledArcDeployment from "../config/arc-deployment.json" with { type: "json" };
import { waitSuccessfulReceipt } from "./txReceipt.js";
import { acquireLock, NamespaceStore, releaseLock } from "./persistentStore.js";

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


const marketOriginStore = new NamespaceStore<{
  fromBlock: string;
  createdAt: string;
}>("market-origin-v1");

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
    // Authoritative "nothing left to settle" check — safer than trusting our cursor.
    type: "function",
    name: "marketHasNoExposure",
    stateMutability: "view",
    inputs: [{ name: "market", type: "address" }],
    outputs: [{ name: "", type: "bool" }]
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

/**
 * TicketBought event looked up by name. Indexing the ABI positionally (engineAbi[2])
 * silently rebinds to a different entry the moment anything is inserted above it.
 */
const ticketBoughtEvent = engineAbi.find(
  (entry) => entry.type === "event" && entry.name === "TicketBought"
) as Extract<(typeof engineAbi)[number], { type: "event" }>;

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

/**
 * Aggregate stats across ALL markets (including resolved/hidden).
 * Cached in memory + KV so the home page stats strip always shows real totals
 * instead of only counting the two currently-visible OPEN markets.
 */
export type AggregateMarketStats = {
  totalVolume: number;
  totalTickets: number;
  totalResolved: number;
  updatedAt: string;
};

let aggregateStatsCache: AggregateMarketStats | null = null;
// Aggregate stats are a headline number (total volume / tickets / resolved), not a
// live feed: they move on the order of minutes. Recomputing every market cycle would
// still launch a full chunked eth_getLogs sweep over ARC_RECENT_SCAN_BLOCKS — the
// single largest RPC cost in the
// app. Ten minutes keeps the number honest and cuts that sweep by ~20x.
const AGGREGATE_STATS_FRESH_MS = (() => {
  const parsed = Number(process.env.AGGREGATE_STATS_FRESH_MS ?? "600000");
  if (!Number.isFinite(parsed)) return 600_000;
  return Math.max(30_000, Math.floor(parsed));
})();
let aggregateStatsCacheAt = 0;
/** Coalesce concurrent refresh calls into one so a burst of home page loads doesn't stampede RPC. */
let refreshInflight: Promise<AggregateMarketStats> | null = null;

export function getCachedAggregateStats(): AggregateMarketStats | null {
  return aggregateStatsCache;
}

/**
 * Compute + save aggregate stats from an already-fetched market list.
 * Volume/tickets prefer engine-wide TicketBought scan (reliable); per-market
 * volume fields are often 0 because Arc RPC rejects eth_getLogs over 10k blocks.
 */
export async function saveAggregateStatsFromMarkets(markets: Market[]): Promise<AggregateMarketStats> {
  let totalVolume = 0;
  let totalTickets = 0;
  let totalResolved = 0;

  for (const m of markets) {
    totalVolume += m.volume || 0;
    totalTickets += m.ticketCount || 0;
    if (m.status === "RESOLVED") totalResolved++;
  }

  const now = Date.now();
  const aggregateFresh =
    aggregateStatsCache && now - aggregateStatsCacheAt < AGGREGATE_STATS_FRESH_MS;
  if (aggregateFresh) {
    // The market cycle runs every ~20s. Reusing the ten-minute engine total avoids
    // a 250k-block chunked eth_getLogs sweep on every cycle.
    return {
      ...aggregateStatsCache!,
      totalResolved: Math.max(aggregateStatsCache!.totalResolved, totalResolved)
    };
  }

  // Prefer one chunked engine-wide log scan — accurate even when per-market
  // tradeStats timed out or failed the 10k-block RPC limit.
  try {
    const engineTotals = await engineTicketBoughtTotals();
    if (engineTotals.ticketCount > 0 || engineTotals.volume > 0) {
      totalVolume = engineTotals.volume;
      totalTickets = engineTotals.ticketCount;
    }
  } catch (error) {
    console.error(
      "[aggregate-stats] engine log scan failed:",
      error instanceof Error ? error.message : error
    );
  }

  const stats: AggregateMarketStats = {
    totalVolume,
    totalTickets,
    totalResolved,
    updatedAt: new Date().toISOString()
  };
  aggregateStatsCache = stats;
  aggregateStatsCacheAt = Date.now();

  try {
    const { NamespaceStore } = await import("./persistentStore.js");
    const store = new NamespaceStore<AggregateMarketStats>("aggregate-stats");
    await store.set("latest", stats);
  } catch (error) {
    console.error("[aggregate-stats] KV save failed:", error instanceof Error ? error.message : error);
  }

  return stats;
}

/** Fetch all markets from chain, then save aggregate stats. Coalesces concurrent calls. */
export async function refreshAggregateStats(): Promise<AggregateMarketStats> {
  if (refreshInflight) return refreshInflight;

  refreshInflight = (async () => {
    try {
      // forCycle includes RESOLVED/hidden so Markets resolved can be non-zero.
      const markets = await listOnchainMarkets({ forCycle: true });
      return await saveAggregateStatsFromMarkets(markets);
    } catch (error) {
      console.error("[aggregate-stats] refresh failed:", error instanceof Error ? error.message : error);
      // Still try engine-wide totals if market list failed.
      try {
        const engineTotals = await engineTicketBoughtTotals();
        const stats: AggregateMarketStats = {
          totalVolume: engineTotals.volume,
          totalTickets: engineTotals.ticketCount,
          totalResolved: aggregateStatsCache?.totalResolved ?? 0,
          updatedAt: new Date().toISOString()
        };
        aggregateStatsCache = stats;
        aggregateStatsCacheAt = Date.now();
        return stats;
      } catch {
        return (
          aggregateStatsCache ?? { totalVolume: 0, totalTickets: 0, totalResolved: 0, updatedAt: "" }
        );
      }
    } finally {
      refreshInflight = null;
    }
  })();

  return refreshInflight;
}

/**
 * Load aggregate stats:
 * 1. In-memory cache (fresh under 30s) → return immediately
 * 2. KV lookup → hydrate cache, return
 * 3. Nothing anywhere → compute from chain inline (blocks 2–3s on cold start only)
 */
export async function getAggregateStats(): Promise<AggregateMarketStats | null> {
  if (aggregateStatsCache && Date.now() - aggregateStatsCacheAt < AGGREGATE_STATS_FRESH_MS) {
    return aggregateStatsCache;
  }
  try {
    const { NamespaceStore } = await import("./persistentStore.js");
    const store = new NamespaceStore<AggregateMarketStats>("aggregate-stats");
    const stored = await store.get("latest");
    if (stored && stored.updatedAt) {
      aggregateStatsCache = stored;
      aggregateStatsCacheAt = Date.now();
      return stored;
    }
  } catch {
    /* non-fatal */
  }
  // Nothing cached — compute inline so home stats work without waiting for cron.
  try {
    return await refreshAggregateStats();
  } catch {
    return aggregateStatsCache;
  }
}

type OnchainMarketListCache = {
  at: number;
  all: Market[];
};

let onchainMarketListCache: OnchainMarketListCache | null = null;
let onchainMarketListInflight: Promise<Market[]> | null = null;
let publicActiveRefreshAt = 0;
let publicActiveRefreshInflight: Promise<void> | null = null;

/**
 * Full market reads are expensive: each market needs ~10 eth_call plus a log query.
 * All HTTP routes and workers share this cache. Market times are immutable, so workers
 * can safely decide when to snapshot/resolve from cached timestamps; successful writes
 * patch the cached market directly instead of forcing another full factory scan.
 */
function onchainMarketListCacheMs(): number {
  const configured = Number(process.env.RPC_MARKET_CACHE_MS ?? 300_000);
  if (!Number.isFinite(configured)) return 300_000;
  return Math.min(10 * 60_000, Math.max(30_000, Math.floor(configured)));
}


function publicActiveMarketCacheMs(): number {
  const configured = Number(process.env.RPC_PUBLIC_MARKET_CACHE_MS ?? 60_000);
  if (!Number.isFinite(configured)) return 60_000;
  return Math.min(2 * 60_000, Math.max(10_000, Math.floor(configured)));
}

function marketCacheKey(market: Pick<Market, "id" | "contractAddress">): string {
  return String(market.contractAddress || market.id).trim().toLowerCase();
}

function rememberOnchainMarket(market: Market): void {
  if (!onchainMarketListCache) {
    onchainMarketListCache = { at: Date.now(), all: [market] };
    return;
  }
  const key = marketCacheKey(market);
  const next = onchainMarketListCache.all.filter((item) => marketCacheKey(item) !== key);
  next.push(market);
  onchainMarketListCache = {
    // Keep the last full-refresh timestamp. Local patches must not postpone the
    // periodic reconciliation forever when markets are created every few minutes.
    at: onchainMarketListCache.at,
    all: next.sort(compareDemoMarkets)
  };
}

export function isMarketHiddenFromUi(id: string): boolean {
  try {
    return hiddenMarketAddresses.has(getAddress(id).toLowerCase());
  } catch {
    return false;
  }
}

function visibleCachedMarkets(all: Market[]): Market[] {
  return all.filter((market) => {
    const raw = market.contractAddress || market.id;
    return !isMarketHiddenFromUi(raw);
  });
}

function applyTimeDerivedStatuses(all: Market[]): Market[] {
  const now = Date.now();
  return all.map((market) => {
    if (market.status !== "OPEN") return market;
    const lockAt = Date.parse(market.lockTime || "");
    if (!Number.isFinite(lockAt) || now < lockAt) return market;
    return { ...market, status: "LOCKED" as MarketStatus };
  });
}

async function refreshMutableOnchainMarket(market: Market): Promise<Market> {
  const address = getAddress(market.contractAddress || market.id);
  const [yesPrice, noPrice, status, winningOutcome] = await Promise.all([
    publicClient.readContract({ address, abi: marketAbi, functionName: "yesPrice" }),
    publicClient.readContract({ address, abi: marketAbi, functionName: "noPrice" }),
    publicClient.readContract({ address, abi: marketAbi, functionName: "status" }),
    publicClient.readContract({ address, abi: marketAbi, functionName: "winningOutcome" })
  ]);
  const statusValue = contractStatus(Number(status));
  const lockAt = Date.parse(market.lockTime || "");
  const displayedStatus =
    statusValue === "OPEN" && Number.isFinite(lockAt) && Date.now() >= lockAt
      ? "LOCKED"
      : statusValue;
  return {
    ...market,
    status: displayedStatus,
    yesPrice: Number(yesPrice) / 1_000_000,
    noPrice: Number(noPrice) / 1_000_000,
    ticketYesPrice: Number(yesPrice) / 1_000_000,
    ticketNoPrice: Number(noPrice) / 1_000_000,
    winningOutcome:
      Number(winningOutcome) === 1 ? "YES" : Number(winningOutcome) === 2 ? "NO" : undefined
  };
}

async function refreshPublicActiveMarkets(all: Market[]): Promise<void> {
  const now = Date.now();
  if (now - publicActiveRefreshAt < publicActiveMarketCacheMs()) return;
  if (publicActiveRefreshInflight) return publicActiveRefreshInflight;

  const candidates = collapseAutoCycleMarkets(
    visibleCachedMarkets(all).filter(
      (market) =>
        market.status === "OPEN" || market.status === "LOCKED" || market.status === "OBSERVATION"
    )
  );

  publicActiveRefreshInflight = (async () => {
    await Promise.all(
      candidates.map(async (market) => {
        const address = market.contractAddress || market.id;
        try {
          const refreshed = await refreshMutableOnchainMarket(market);
          const stats = await Promise.race([
            marketTradeStats(getAddress(address)),
            new Promise<ReturnType<typeof emptyMarketTradeStats>>((resolve) =>
              setTimeout(() => resolve(emptyMarketTradeStats()), 2_000)
            )
          ]);
          refreshed.volume = stats.volume;
          refreshed.ticketCount = stats.ticketCount;
          refreshed.yesVolume = stats.yesVolume;
          refreshed.noVolume = stats.noVolume;
          rememberOnchainMarket(refreshed);
        } catch {
          // Public desk can use the last good cached card.
        }
      })
    );
    publicActiveRefreshAt = Date.now();
  })().finally(() => {
    publicActiveRefreshInflight = null;
  });

  return publicActiveRefreshInflight;
}

async function loadAllOnchainMarkets(): Promise<Market[]> {
  // Include hidden so the cycle can continue settlement, while the public projection
  // below filters them without another factory/RPC read.
  const known = await listKnownMarkets({ includeHidden: true });
  const cachedByAddress = new Map(
    (onchainMarketListCache?.all ?? []).map((market) => [marketCacheKey(market), market] as const)
  );
  const markets = await Promise.all(
    known.map(async (item) => {
      const key = getAddress(item.market).toLowerCase();
      const cached = cachedByAddress.get(key);
      if (!cached) return readOnchainMarket(item, { includeTradeStats: false });
      // Immutable metadata (question/times/rules) never needs another eth_call.
      // Final markets cannot change again, while active markets need only four
      // mutable fields refreshed.
      if (
        cached.status === "RESOLVED" ||
        cached.status === "CANCELLED" ||
        cached.status === "ARCHIVED"
      ) {
        return cached;
      }
      return refreshMutableOnchainMarket(cached);
    })
  );
  const all = markets.filter((market): market is Market => Boolean(market)).sort(compareDemoMarkets);

  // Trade-volume scans are much more expensive than fixed metadata reads because
  // eth_getLogs is chunked. Enrich only the two currently displayed rounds.
  const activeForDesk = collapseAutoCycleMarkets(
    visibleCachedMarkets(all).filter(
      (market) =>
        market.status === "OPEN" || market.status === "LOCKED" || market.status === "OBSERVATION"
    )
  );
  await Promise.all(
    activeForDesk.map(async (market) => {
      const address = market.contractAddress || market.id;
      try {
        const stats = await Promise.race([
          marketTradeStats(getAddress(address)),
          new Promise<ReturnType<typeof emptyMarketTradeStats>>((resolve) =>
            setTimeout(() => resolve(emptyMarketTradeStats()), 2_000)
          )
        ]);
        market.volume = stats.volume;
        market.ticketCount = stats.ticketCount;
        market.yesVolume = stats.yesVolume;
        market.noVolume = stats.noVolume;
      } catch {
        // Metadata is still useful to workers/UI when public getLogs flakes.
      }
    })
  );

  return all;
}

export async function listOnchainMarkets(options: {
  /** Include finished markets for resolve/hide (cron). UI list hides RESOLVED without tickets. */
  forCycle?: boolean;
  /** Force a chain refresh for explicit diagnostics only. */
  forceRefresh?: boolean;
} = {}): Promise<Market[]> {
  assertDeployment();
  const now = Date.now();
  const cacheFresh =
    onchainMarketListCache &&
    now - onchainMarketListCache.at < onchainMarketListCacheMs();

  let all: Market[];
  if (!options.forceRefresh && cacheFresh) {
    all = onchainMarketListCache!.all;
  } else {
    if (!onchainMarketListInflight) {
      onchainMarketListInflight = loadAllOnchainMarkets()
        .then((loaded) => {
          const refreshedAt = Date.now();
          onchainMarketListCache = { at: refreshedAt, all: loaded };
          publicActiveRefreshAt = refreshedAt;
          return loaded;
        })
        .finally(() => {
          onchainMarketListInflight = null;
        });
    }
    try {
      all = await onchainMarketListInflight;
    } catch (error) {
      // A stale schedule is safer and far cheaper than repeatedly hammering a flaky
      // public RPC. Direct resolve/create writes still verify their own receipts.
      if (onchainMarketListCache) {
        console.warn(
          "[rpc-cache] market refresh failed; serving stale schedule:",
          error instanceof Error ? error.message : error
        );
        all = onchainMarketListCache.all;
      } else {
        throw error;
      }
    }
  }

  all = applyTimeDerivedStatuses(all);
  if (onchainMarketListCache) onchainMarketListCache = { ...onchainMarketListCache, all };

  if (options.forCycle) return all;

  // Refresh only the two visible contracts for live odds/status. This runs only
  // when the public API is requested; idle Railway deployments spend no RPC here.
  await refreshPublicActiveMarkets(all);
  all = onchainMarketListCache?.all ?? all;

  // Public markets desk:
  // - only open / locked / observation (never RESOLVED/CANCELLED)
  // - BTC + London weather only (no demo "GREEN signal" / admin leftovers)
  // - one freshest market each so the grid stays 2 cards centered
  // Portfolio still loads tickets by address for claims.
  const live = visibleCachedMarkets(all).filter(
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

export async function getOnchainMarket(
  id: string,
  options: { includeTradeStats?: boolean } = {}
): Promise<Market | undefined> {
  assertDeployment();
  // Prefer direct address read (works for finished/hidden rounds users still open from Portfolio).
  try {
    const asAddr = getAddress(id);
    const market = await readOnchainMarket({
      id: asAddr,
      label: "On-chain market",
      role: "legacy",
      market: asAddr
    }, { includeTradeStats: options.includeTradeStats });
    if (market) {
      rememberOnchainMarket(market);
      return market;
    }
  } catch {
    // id may be a short demo slug
  }
  const item = findDemoMarket(id);
  if (!item) return undefined;
  // Include hidden markets when fetched by id (claim / portfolio deep-link).
  const market = await readOnchainMarket(item, {
    includeTradeStats: options.includeTradeStats
  });
  if (market) rememberOnchainMarket(market);
  return market;
}


/**
 * Durable, market-scoped oracle evidence for the chart and Portfolio.
 *
 * The old chart fetched a generic Coinbase/Open-Meteo history and then invented its
 * own start line from the first browser sample. The resolver, however, selects the
 * nearest durable raw tick at observationStart and the first durable tick at/after
 * observationEnd. Those two paths could legitimately disagree, making the UI say
 * YES while the contract resolved NO. This endpoint exposes the exact resolver
 * inputs for this round and never labels a browser-side preview as final.
 */
export async function getMarketObservationEvidence(
  id: string
): Promise<MarketObservationEvidence | undefined> {
  assertDeployment();

  const key = String(id || "").trim().toLowerCase();
  let market = onchainMarketListCache?.all.find((item) => {
    const address = String(item.contractAddress || item.id).trim().toLowerCase();
    return item.id.toLowerCase() === key || address === key;
  });
  if (!market) {
    market = await getOnchainMarket(id, { includeTradeStats: false });
  }
  if (!market) return undefined;

  const question = (market.question || "").toLowerCase();
  const role: "btc" | "weather" | undefined =
    market.demoRole === "btc_price" ||
    market.category === "crypto-candle" ||
    /\bbtc\b/.test(question) ||
    question.includes("bitcoin")
      ? "btc"
      : market.demoRole === "london_weather" ||
          market.category === "weather" ||
          question.includes("london") ||
          question.includes("temp") ||
          question.includes("weather")
        ? "weather"
        : undefined;
  if (!role) return undefined;

  const marketAddress = getAddress(market.contractAddress || market.id);
  const observationStartMs = Date.parse(market.observationStart || "") || 0;
  const observationEndMs = Date.parse(market.observationEnd || "") || 0;
  if (!observationStartMs || !observationEndMs) return undefined;

  const [rawModule, snapshotModule] = await Promise.all([
    import("./rawTicks.js"),
    import("./observationSnapshots.js")
  ]);
  const [ticks, snapshot] = await Promise.all([
    rawModule.getRawTicks(role),
    snapshotModule.getObservationSnapshot(marketAddress)
  ]);
  const maxDistanceMs = snapshotModule.snapshotMaxDistanceMs(role);

  const startFromTicks = rawModule.nearestRawTick(ticks, observationStartMs, maxDistanceMs);
  const endFromTicks = rawModule.firstTickAtOrAfter(ticks, observationEndMs, maxDistanceMs);

  const pointFromTick = (tick: {
    value: number;
    at: number;
    tick: { provider: string; sourceId?: string; sourceHash?: string };
  }): MarketObservationPoint => ({
    value: tick.value,
    at: tick.at,
    provider: tick.tick.provider,
    sourceId: tick.tick.sourceId,
    sourceHash: tick.tick.sourceHash
  });
  const pointFromSnapshot = (
    value: number | undefined,
    at: number | undefined,
    source:
      | { provider?: string; sourceId?: string; sourceHash?: string }
      | undefined
  ): MarketObservationPoint | undefined =>
    Number.isFinite(value) && Number.isFinite(at)
      ? {
          value: Number(value),
          at: Number(at),
          provider: source?.provider,
          sourceId: source?.sourceId,
          sourceHash: source?.sourceHash
        }
      : undefined;

  // Snapshot values are preferred because once frozen they are the immutable payout
  // evidence. Before freeze they are still the resolver's current selected boundaries.
  const start =
    pointFromSnapshot(snapshot?.startValue, snapshot?.startTimestamp, snapshot?.startSource) ??
    (startFromTicks ? pointFromTick(startFromTicks) : undefined);
  const end =
    pointFromSnapshot(snapshot?.endValue, snapshot?.endTimestamp, snapshot?.endSource) ??
    (endFromTicks ? pointFromTick(endFromTicks) : undefined);

  const visibleEnd = Math.min(Date.now(), observationEndMs);
  const relevant = ticks
    .filter(
      (tick) =>
        Number.isFinite(tick.value) &&
        Number.isFinite(tick.observedAt) &&
        tick.observedAt >= observationStartMs &&
        tick.observedAt <= visibleEnd
    )
    .map<MarketObservationPoint>((tick) => ({
      value: tick.value,
      at: tick.observedAt,
      provider: tick.provider,
      sourceId: tick.sourceId,
      sourceHash: tick.sourceHash
    }));

  // Include the authoritative boundary prints even when their provider timestamp sits
  // just outside the visual window (the start selector is nearest, not at-or-after).
  const byIdentity = new Map<string, MarketObservationPoint>();
  const addPoint = (point: MarketObservationPoint | undefined) => {
    if (!point || !Number.isFinite(point.value) || !Number.isFinite(point.at)) return;
    const identity = `${point.at}:${point.value.toFixed(8)}:${point.provider ?? ""}:${point.sourceHash ?? ""}`;
    byIdentity.set(identity, point);
  };
  for (const point of relevant) addPoint(point);
  addPoint(start);
  if (Date.now() >= observationEndMs || snapshot?.frozen) addPoint(end);
  const points = [...byIdentity.values()].sort((a, b) => a.at - b.at);

  const latest = points
    .filter((point) => point.at >= observationStartMs && point.at <= Math.max(visibleEnd, observationStartMs))
    .at(-1);
  const indicativeOutcome: Outcome | undefined =
    start && latest
      ? snapshotModule.resolveOutcomeFromPrints(start.value, latest.value).outcome
      : undefined;

  const effectiveStatus: MarketStatus = snapshot?.frozen ? "RESOLVED" : market.status;
  const finalOutcome = snapshot?.frozen
    ? snapshot.outcome ?? market.winningOutcome
    : effectiveStatus === "RESOLVED" || effectiveStatus === "ARCHIVED"
      ? market.winningOutcome
      : undefined;
  let integrityError: string | undefined;
  if (snapshot?.frozen && snapshot.outcome && finalOutcome && snapshot.outcome !== finalOutcome) {
    integrityError = `Frozen oracle outcome ${snapshot.outcome} does not match on-chain winner ${finalOutcome}`;
  }

  return {
    marketId: market.id,
    marketAddress,
    role,
    observationStart: market.observationStart,
    observationEnd: market.observationEnd,
    status: effectiveStatus,
    points,
    start,
    end,
    indicativeOutcome,
    finalOutcome,
    frozen: Boolean(snapshot?.frozen),
    resolutionTxHash: snapshot?.resolutionTxHash,
    integrityError,
    updatedAt: new Date().toISOString()
  };
}

async function readOnchainMarket(
  item: DemoMarketDeployment,
  options: { tradeStatsTimeoutMs?: number; includeTradeStats?: boolean } = {}
): Promise<Market | undefined> {
  const market = addr(item.market);
  const tradeStatsTimeoutMs = options.tradeStatsTimeoutMs ?? 1_500;
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
  const tradeStats =
    options.includeTradeStats === false
      ? emptyMarketTradeStats()
      : await Promise.race([
          marketTradeStats(market).catch(() => emptyMarketTradeStats()),
          new Promise<ReturnType<typeof emptyMarketTradeStats>>((resolve) =>
            setTimeout(() => resolve(emptyMarketTradeStats()), tradeStatsTimeoutMs)
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

  // Pass `account` so msg.sender in quoteTicket matches the user for EXPOSURE_CAP.
  const userParam = (params.get("user") || params.get("address") || "").trim();
  let account: `0x${string}` | undefined;
  try {
    if (userParam) account = getAddress(userParam) as `0x${string}`;
  } catch {
    account = undefined;
  }

  const quote = await publicClient.readContract({
    address: addr(deployment.microBoostEngine),
    abi: engineAbi,
    functionName: "quoteTicket",
    args: [addr(item.market), outcomeId, risk, boostBps],
    ...(account ? { account } : {})
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
  // Public card stats only need the current short-lived round. The generic recent
  // ticket window is 250k blocks for portfolio recovery and would require dozens of
  // getLogs chunks per card. Keep this dedicated window small and settlement-safe
  // scans separate.
  const latestBlock = await publicClient.getBlockNumber();
  const configured = parseBlockNumber(process.env.ARC_MARKET_STATS_SCAN_BLOCKS ?? "8000");
  const windowBlocks = configured > 0n ? configured : 8_000n;
  const deploymentFloor = configuredTicketFromBlock();
  const recentFloor = latestBlock > windowBlocks ? latestBlock - windowBlocks : 0n;
  const fromBlock = deploymentFloor > recentFloor ? deploymentFloor : recentFloor;
  const logs =
    fromBlock <= latestBlock
      ? await ticketBoughtLogsChunked({ market }, fromBlock, latestBlock)
      : [];
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

/** Sum all TicketBought on the current engine (all markets) via chunked getLogs. */
async function engineTicketBoughtTotals(): Promise<{ volume: number; ticketCount: number }> {
  const logs = await ticketBoughtLogsChunked({}, await ticketScanFromBlock(), await publicClient.getBlockNumber());
  let totalRisk = 0n;
  for (const log of logs) {
    totalRisk += log.args.riskAmount ?? 0n;
  }
  return { volume: usdcNumber(totalRisk), ticketCount: logs.length };
}

async function ticketScanFromBlock(): Promise<bigint> {
  const latest = await publicClient.getBlockNumber();
  return recentTicketScanFromBlock(latest);
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
  /** Present on real logs — lets metadata anchor to the purchase block, not call time. */
  blockNumber?: bigint | null;
};

/**
 * @param fullRange scan from the deployment block instead of the recent window.
 *        Listing can afford to look only at recent blocks; settlement cannot — a
 *        ticket older than ARC_RECENT_SCAN_BLOCKS would drop out of the scan while
 *        still holding LP reserve, and would never be settled again.
 */
async function ticketBoughtLogsForMarket(
  market: `0x${string}`,
  chunkOnFailure = true,
  fullRange = false
) {
  // fullRange is only used by settlement, which cannot tolerate a partial scan.
  const strict = fullRange;
  const latestBlock = await publicClient.getBlockNumber();
  const fromBlock = fullRange
    ? configuredTicketFromBlock()
    : recentTicketScanFromBlock(latestBlock);
  if (fromBlock > latestBlock) return [];
  const args = { market };
  // Arc testnet RPC: eth_getLogs limited to 10_000 blocks — never request full range.
  if (latestBlock - fromBlock > 9_000n || chunkOnFailure) {
    return ticketBoughtLogsChunked(args, fromBlock, latestBlock, strict);
  }
  try {
    return await publicClient.getLogs({
      address: addr(deployment.microBoostEngine),
      event: ticketBoughtEvent,
      args,
      fromBlock,
      toBlock: latestBlock
    }) as TicketBoughtLog[];
  } catch {
    return ticketBoughtLogsChunked(args, fromBlock, latestBlock, strict);
  }
}

async function ticketBoughtLogsForBuyer(buyer: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
  const args = { buyer };
  // Arc rejects wide ranges. Do not spend one guaranteed-failing RPC call before
  // falling back to chunks on a first Portfolio load.
  if (toBlock - fromBlock > 9_000n) {
    return ticketBoughtLogsChunked(args, fromBlock, toBlock);
  }
  try {
    return await publicClient.getLogs({
      address: addr(deployment.microBoostEngine),
      event: ticketBoughtEvent,
      args,
      fromBlock,
      toBlock
    }) as TicketBoughtLog[];
  } catch {
    return ticketBoughtLogsChunked(args, fromBlock, toBlock);
  }
}

/**
 * @param strict throw if any chunk cannot be read. Settlement must be strict — a short
 *        list there silently strands tickets. Listing stays tolerant so a flaky public
 *        RPC degrades the view instead of breaking the page.
 */
async function ticketBoughtLogsChunked(
  args: TicketBoughtLogArgs,
  fromBlock: bigint,
  toBlock: bigint,
  strict = false
) {
  // Arc public RPC: eth_getLogs max range 10_000; some gateways flake on 8k — use 4k + retries.
  const chunkSize = configuredLogChunkSize();
  const logs: TicketBoughtLog[] = [];
  const filterArgs =
    args.buyer || args.market
      ? {
          ...(args.buyer ? { buyer: args.buyer } : {}),
          ...(args.market ? { market: args.market } : {})
        }
      : undefined;

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
    let got: TicketBoughtLog[] | null = null;
    for (let attempt = 0; attempt < 3 && !got; attempt++) {
      try {
        got = (await publicClient.getLogs({
          address: addr(deployment.microBoostEngine),
          event: ticketBoughtEvent,
          ...(filterArgs ? { args: filterArgs } : {}),
          fromBlock: start,
          toBlock: end
        })) as TicketBoughtLog[];
      } catch {
        // Brief backoff — public Arc endpoints rate-limit concurrent getLogs.
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    if (!got) {
      // Skipping a chunk silently returns a short list that looks complete. On the
      // settlement path that reads as "this market has fewer tickets than it does",
      // and the cursor would march past tickets still holding LP reserve.
      if (strict) {
        throw new Error(
          `eth_getLogs failed for blocks ${start}-${end} after 3 attempts — ticket scan is incomplete`
        );
      }
      console.warn(`[onchain] getLogs chunk ${start}-${end} unavailable — list may be partial`);
      continue;
    }
    logs.push(...got);
  }
  return logs;
}

type TicketMarketSnapshot = {
  question: string;
  status: MarketStatus;
  winningOutcome?: Outcome;
  evidence?: {
    startValue?: number;
    endValue?: number;
    startTimestamp?: number;
    endTimestamp?: number;
    source?: string;
    resolutionTxHash?: string;
    frozen?: boolean;
    outcome?: Outcome;
  };
};

async function ticketMarketSnapshot(marketAddress: string): Promise<TicketMarketSnapshot> {
  const market = addr(marketAddress);
  const [question, status, lockTime, winningOutcome] = await Promise.all([
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "question" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "status" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "lockTime" }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "winningOutcome" })
  ]);
  const marketStatus = displayedMarketStatus(Number(status), lockTime);
  let evidence: TicketMarketSnapshot["evidence"];
  if (marketStatus === "RESOLVED" || marketStatus === "ARCHIVED" || marketStatus === "CANCELLED") {
    try {
      const { getObservationSnapshot } = await import("./observationSnapshots.js");
      const snapshot = await getObservationSnapshot(market);
      if (snapshot) {
        evidence = {
          startValue: snapshot.startValue,
          endValue: snapshot.endValue,
          startTimestamp: snapshot.startTimestamp,
          endTimestamp: snapshot.endTimestamp,
          source: snapshot.source,
          resolutionTxHash: snapshot.resolutionTxHash,
          frozen: snapshot.frozen,
          outcome: snapshot.outcome
        };
      }
    } catch {
      // Evidence is explanatory metadata; on-chain status/outcome remain authoritative.
    }
  }
  return {
    question,
    status: marketStatus,
    winningOutcome: Number(winningOutcome) === 1 ? "YES" : Number(winningOutcome) === 2 ? "NO" : undefined,
    evidence
  };
}

type TicketCacheEntry = {
  scannedToBlock: bigint;
  tickets: Map<string, Ticket>;
  refreshedAt: number;
};

const ticketCache = new Map<string, TicketCacheEntry>();

function ticketCacheFreshMs(): number {
  const configured = Number(process.env.RPC_TICKET_CACHE_MS ?? 60_000);
  if (!Number.isFinite(configured)) return 60_000;
  return Math.min(5 * 60_000, Math.max(15_000, Math.floor(configured)));
}

export async function ticketsForUserOnchain(user: string): Promise<Ticket[]> {
  assertDeployment();
  const buyer = addr(user);
  const cacheKey = buyer.toLowerCase();
  const existing = ticketCache.get(cacheKey);
  if (existing && Date.now() - existing.refreshedAt < ticketCacheFreshMs()) {
    return [...existing.tickets.values()].sort(compareTicketIdsDesc);
  }

  // getBlockNumber can flake on a single RPC; fall back to cache / empty rather than 500.
  let latestBlock: bigint;
  try {
    latestBlock = await publicClient.getBlockNumber();
  } catch (error) {
    if (existing?.tickets.size) {
      return [...existing.tickets.values()].sort(compareTicketIdsDesc);
    }
    throw error;
  }
  const fromBlock = existing ? existing.scannedToBlock + 1n : recentTicketScanFromBlock(latestBlock);
  const logs = fromBlock <= latestBlock
    ? await ticketBoughtLogsForBuyer(buyer, fromBlock, latestBlock)
    : [];

  const tickets = existing?.tickets ?? new Map<string, Ticket>();
  for (const log of logs) {
    try {
      const ticket = await ticketFromBoughtLog(log.args.ticketId, tickets);
      if (ticket) tickets.set(ticket.id, ticket);
    } catch {
      // Skip a bad log — one pruned/failed eth_call must not blank the portfolio.
    }
  }
  if (tickets.size > 0) {
    await refreshCachedTicketPositions(tickets);
  }
  ticketCache.set(cacheKey, { scannedToBlock: latestBlock, tickets, refreshedAt: Date.now() });

  return [...tickets.values()].sort(compareTicketIdsDesc);
}

async function ticketFromBoughtLog(ticketId: bigint | undefined, tickets: Map<string, Ticket>): Promise<Ticket | undefined> {
  if (ticketId === undefined) return undefined;
  return ticketFromChainId(ticketId, tickets.get(ticketKey(ticketId))?.createdAt);
}

function cachedMarketForTicket(ticket: Ticket): Market | undefined {
  if (!onchainMarketListCache) return undefined;
  const key = String(ticket.marketId || "").toLowerCase();
  return onchainMarketListCache.all.find((market) => {
    const address = String(market.contractAddress || "").toLowerCase();
    return market.id.toLowerCase() === key || address === key;
  });
}

function cachedTicketMarketSnapshot(marketAddress: string): TicketMarketSnapshot | undefined {
  if (!onchainMarketListCache) return undefined;
  const key = marketAddress.toLowerCase();
  const market = onchainMarketListCache.all.find(
    (item) => String(item.contractAddress || item.id).toLowerCase() === key
  );
  if (!market) return undefined;
  return {
    question: market.question,
    status: market.status,
    winningOutcome: market.winningOutcome
  };
}

async function refreshCachedTicketPositions(tickets: Map<string, Ticket>): Promise<void> {
  const marketSnapshots = new Map<
    string,
    Promise<TicketMarketSnapshot>
  >();
  await Promise.all(
    [...tickets.keys()].map(async (id) => {
      const previous = tickets.get(id);
      if (!previous || previous.status !== "OPEN") return;
      const cachedMarket = cachedMarketForTicket(previous);
      // An OPEN ticket cannot change before its market becomes final. The shared
      // market-cycle cache already knows active rounds, so skip a pointless ticket RPC.
      if (
        cachedMarket &&
        cachedMarket.status !== "RESOLVED" &&
        cachedMarket.status !== "CANCELLED" &&
        cachedMarket.status !== "ARCHIVED"
      ) {
        return;
      }
      try {
        const ticket = await ticketFromChainId(
          ticketIdNumber(id),
          previous.createdAt,
          marketSnapshots
        );
        if (ticket) tickets.set(id, ticket);
      } catch {
        // Keep the last known ticket snapshot if a live refresh fails.
      }
    })
  );
}

async function ticketFromChainId(
  ticketId: bigint,
  createdAt = new Date().toISOString(),
  marketSnapshots?: Map<
    string,
    Promise<TicketMarketSnapshot>
  >
): Promise<Ticket | undefined> {
  if (ticketId <= 0n) return undefined;
  const position = await publicClient.readContract({
    address: addr(deployment.positionTicket),
    abi: ticketAbi,
    functionName: "getTicket",
    args: [ticketId]
  });
  const marketKey = position.market.toLowerCase();
  let marketSnapshotPromise = marketSnapshots?.get(marketKey);
  if (!marketSnapshotPromise) {
    const cached = cachedTicketMarketSnapshot(position.market);
    const cachedIsActive =
      cached && cached.status !== "RESOLVED" && cached.status !== "CANCELLED" && cached.status !== "ARCHIVED";
    // Final result and evidence are always read from the market contract + frozen
    // snapshot store. A list cache must never be allowed to make a ticket flip
    // between WIN and LOSS after a later refresh.
    marketSnapshotPromise = cachedIsActive
      ? Promise.resolve(cached)
      : ticketMarketSnapshot(position.market);
    marketSnapshots?.set(marketKey, marketSnapshotPromise);
  }
  const marketSnapshot = await marketSnapshotPromise;
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
    openReferenceSource: opening?.source,
    resolutionStartValue: marketSnapshot.evidence?.startValue,
    resolutionEndValue: marketSnapshot.evidence?.endValue,
    resolutionStartAt: marketSnapshot.evidence?.startTimestamp,
    resolutionEndAt: marketSnapshot.evidence?.endTimestamp,
    resolutionSource: marketSnapshot.evidence?.source,
    resolutionTxHash: marketSnapshot.evidence?.resolutionTxHash,
    resolutionFrozen: marketSnapshot.evidence?.frozen
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
  // Arc RPC hard-limits eth_getLogs to 10_000 blocks; 4k is reliable across public RPCs.
  const parsed = parseBlockNumber(process.env.ARC_LOG_CHUNK_SIZE ?? "4000");
  if (parsed <= 0n) return 4_000n;
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
  const receipt = await waitSuccessfulReceipt(publicClient, hash);
  return { hash, status: receipt.status, market: await getOnchainMarket(id, { includeTradeStats: false }) };
}

/**
 * Digest of the normalized provider reading, carried into frozen resolution evidence.
 *
 * SHA-256, not a 32-bit rolling hash: this is the value someone re-deriving a payout
 * compares against. An 8-hex digest collides by birthday at ~65k samples, which a
 * 1 Hz feed reaches in under a day — far too weak to attest what the oracle read.
 */
function simpleSourceHash(parts: {
  feed: string;
  value: number;
  observedAt: number;
  provider: string;
}): string {
  const raw = `${parts.feed}|${parts.value}|${parts.observedAt}|${parts.provider}`;
  return sha256("sha256").update(raw).digest("hex");
}

/**
 * Capture feed samples for active observation windows.
 * End samples only use ticks with observedAt >= observationEnd.
 */
export async function captureObservationSnapshots(): Promise<{
  updated: number;
  skipped?: string;
}> {
  assertDeployment();
  const { requireOracleKv } = await import("./rawTicks.js");
  try {
    requireOracleKv();
  } catch (error) {
    // Local development may use the file store. Production must never collect
    // payout evidence in process-local files because a restart would split history.
    if (process.env.NODE_ENV === "production") throw error;
  }

  const {
    applyBoundaryFromRawTicks,
    recordObservationSample,
    WEATHER_STALE_MS,
    snapshotMaxDistanceMs
  } = await import("./observationSnapshots.js");
  const { getRawTicks, nearestRawTick, firstTickAtOrAfter, pushRawTick } = await import(
    "./rawTicks.js"
  );

  // This is normally a memory-cache hit. A full factory + market refresh is shared
  // by every route/worker and happens only once per RPC_MARKET_CACHE_MS.
  const markets = await listOnchainMarkets({ forCycle: true });
  const now = Date.now();
  const btcMaxDist = snapshotMaxDistanceMs("btc");
  const weatherMaxDist = snapshotMaxDistanceMs("weather");

  type Candidate = {
    market: Market;
    role: "btc" | "weather";
    obsStartMs: number;
    obsEndMs: number;
  };

  const candidates: Candidate[] = [];
  for (const market of markets) {
    const status = String(market.status || "").toUpperCase();
    if (!["OPEN", "LOCKED", "OBSERVATION", "OBSERVE"].includes(status)) continue;

    const obsStartMs = Date.parse(market.observationStart || "") || 0;
    const obsEndMs = Date.parse(market.observationEnd || "") || 0;
    if (!obsStartMs || !obsEndMs) continue;

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
      // Poll only near the two immutable boundaries. Five-second sampling gives
      // several chances inside the accepted window without fetching BTC all day.
      const nearStart =
        now >= obsStartMs - 20_000 && now <= obsStartMs + btcMaxDist;
      const nearEnd =
        now >= obsEndMs - 2_000 && now <= obsEndMs + btcMaxDist;
      if (nearStart || nearEnd) {
        candidates.push({ market, role: "btc", obsStartMs, obsEndMs });
      }
    } else if (isWeather) {
      // Weather prints on a 15-minute grid. Begin shortly before each boundary;
      // the provider timestamp may itself be older and is retained as provenance.
      const nearStart =
        now >= obsStartMs - 2 * 60_000 && now <= obsStartMs + weatherMaxDist;
      const nearEnd =
        now >= obsEndMs - 2 * 60_000 && now <= obsEndMs + weatherMaxDist;
      if (nearStart || nearEnd) {
        candidates.push({ market, role: "weather", obsStartMs, obsEndMs });
      }
    }
  }

  if (candidates.length === 0) {
    return { updated: 0, skipped: "no-active-boundary" };
  }

  const needsBtc = candidates.some((item) => item.role === "btc");
  const needsWeather = candidates.some((item) => item.role === "weather");
  // Oracle capture needs only current prints, never the chart-history endpoints.
  const [btcResult, weatherResult] = await Promise.allSettled([
    needsBtc ? fetchCachedBtcSpot() : Promise.resolve(undefined),
    needsWeather ? fetchCachedWeather() : Promise.resolve(undefined)
  ]);
  const btcData = btcResult.status === "fulfilled" ? btcResult.value : undefined;
  const weather =
    weatherResult.status === "fulfilled"
      ? (weatherResult.value as
          | {
              temperatureC?: number;
              updatedAt?: string;
              observedAt?: string;
              source?: string;
              isStale?: boolean;
            }
          | undefined)
      : undefined;

  // BTC: record a fresh provider-timestamped print.
  if (needsBtc && btcData && Number.isFinite(btcData.price)) {
    const observedAt = Date.parse(btcData.updatedAt) || now;
    const price = btcData.price as number;
    const src = btcData.source ?? "coinbase";
    await pushRawTick("btc", price, observedAt, {
      provider: src,
      receivedAt: now,
      sourceHash: simpleSourceHash({ feed: "btc", value: price, observedAt, provider: src })
    });
  }

  // Weather: never promote cached/stale readings into oracle ticks.
  if (
    needsWeather &&
    weather &&
    Number.isFinite(weather.temperatureC) &&
    !weather.isStale &&
    !String(weather.source || "").includes("(cached)")
  ) {
    const observedAt =
      parseProviderUtcMs(weather.observedAt || "") ||
      Date.parse(weather.updatedAt || "") ||
      0;
    if (observedAt > 0 && now - observedAt <= WEATHER_STALE_MS) {
      const temp = weather.temperatureC as number;
      const src = weather.source ?? "open-meteo";
      await pushRawTick("weather", temp, observedAt, {
        provider: src,
        receivedAt: now,
        sourceHash: simpleSourceHash({ feed: "weather", value: temp, observedAt, provider: src })
      });
    }
  }

  // Read each role's ZSET once, not once per market.
  const [btcTicks, weatherTicks] = await Promise.all([
    needsBtc ? getRawTicks("btc") : Promise.resolve([]),
    needsWeather ? getRawTicks("weather") : Promise.resolve([])
  ]);

  let updated = 0;
  for (const candidate of candidates) {
    const { market, role, obsStartMs, obsEndMs } = candidate;
    const mkt = market.contractAddress || market.id;
    if (!mkt) continue;

    if (role === "btc") {
      const source = btcData?.source ?? "Coinbase spot";
      const open = nearestRawTick(btcTicks, obsStartMs, btcMaxDist);
      const close = firstTickAtOrAfter(btcTicks, obsEndMs, btcMaxDist);
      await applyBoundaryFromRawTicks({
        market: mkt,
        role: "btc",
        obsStartMs,
        obsEndMs,
        open: open
          ? {
              value: open.value,
              observedAt: open.at,
              receivedAt: open.tick.receivedAt || undefined,
              provider: open.tick.provider,
              sourceId: open.tick.sourceId,
              sourceHash: open.tick.sourceHash
            }
          : undefined,
        close: close
          ? {
              value: close.value,
              observedAt: close.at,
              receivedAt: close.tick.receivedAt || undefined,
              provider: close.tick.provider,
              sourceId: close.tick.sourceId,
              sourceHash: close.tick.sourceHash
            }
          : undefined,
        source
      });
      if (btcData && Number.isFinite(btcData.price)) {
        const observedAt = Date.parse(btcData.updatedAt) || now;
        await recordObservationSample({
          market: mkt,
          role: "btc",
          value: btcData.price as number,
          atMs: observedAt,
          obsStartMs,
          obsEndMs,
          source,
          maxDistanceMs: btcMaxDist,
          provenance: {
            observedAt,
            receivedAt: now,
            provider: source
          }
        });
      }
      updated += 1;
      continue;
    }

    const source = weather?.source ?? "Open-Meteo";
    const open = nearestRawTick(weatherTicks, obsStartMs, weatherMaxDist);
    const close = firstTickAtOrAfter(weatherTicks, obsEndMs, weatherMaxDist);
    await applyBoundaryFromRawTicks({
      market: mkt,
      role: "weather",
      obsStartMs,
      obsEndMs,
      open: open
        ? {
            value: open.value,
            observedAt: open.at,
            receivedAt: open.tick.receivedAt || undefined,
            provider: open.tick.provider,
            sourceHash: open.tick.sourceHash
          }
        : undefined,
      close: close
        ? {
            value: close.value,
            observedAt: close.at,
            receivedAt: close.tick.receivedAt || undefined,
            provider: close.tick.provider,
            sourceHash: close.tick.sourceHash
          }
        : undefined,
      source
    });
    updated += 1;
  }

  return { updated };
}

export async function resolveReferenceMarketOnchain(id: string) {
  const token = randomBytes(8).toString("hex");
  const lockKey = `market-resolve:${String(id).trim().toLowerCase()}`;
  const gotLock = await acquireLock(lockKey, 90_000, token);
  if (!gotLock) {
    return {
      deferred: true,
      error: "Resolution already in progress for this market"
    };
  }
  try {
    return await resolveReferenceMarketOnchainUnlocked(id);
  } finally {
    await releaseLock(lockKey, token).catch(() => undefined);
  }
}

async function resolveReferenceMarketOnchainUnlocked(id: string) {
  assertDeployment();
  const market = await getOnchainMarket(id, { includeTradeStats: false });
  if (!market) return undefined;

  const obsStartMs = Date.parse(market.observationStart || "") || 0;
  const obsEndMs = Date.parse(market.observationEnd || "") || 0;
  if (!obsStartMs || !obsEndMs) {
    return { error: "Market missing observationStart/observationEnd.", market };
  }

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

  if (!isBtc && !isWeather) {
    return { error: "Selected market is not a BTC/weather reference market.", market };
  }

  await captureObservationSnapshots();

  const {
    getObservationSnapshot,
    snapshotReadyForResolve,
    freezeObservationSnapshot,
    snapshotGraceMs,
    snapshotMaxDistanceMs,
    resolveOutcomeFromPrints,
    applyBoundaryFromRawTicks
  } = await import("./observationSnapshots.js");
  const { getRawTicks, nearestRawTick, firstTickAtOrAfter, requireOracleKv } = await import(
    "./rawTicks.js"
  );
  try {
    requireOracleKv();
  } catch (e) {
    // Shared runtime without KV must fail closed for oracle.
    if (process.env.NODE_ENV === "production") {
      return { error: e instanceof Error ? e.message : "oracle KV required", market };
    }
  }

  const role = isBtc ? ("btc" as const) : ("weather" as const);
  const mkt = market.contractAddress || market.id;
  const maxDist = snapshotMaxDistanceMs(role);
  const graceMs = snapshotGraceMs(role);
  // captureObservationSnapshots() already fetched the current print when the market
  // was inside a boundary window. Resolution uses durable raw ticks from Redis and
  // must not refetch chart histories or another provider print.
  const source = isBtc ? "Coinbase spot" : "Open-Meteo";

  const ticks = await getRawTicks(role);
  const open = nearestRawTick(ticks, obsStartMs, maxDist);
  // End: first tick at or AFTER observationEnd only.
  const close = firstTickAtOrAfter(ticks, obsEndMs, maxDist);
  await applyBoundaryFromRawTicks({
    market: mkt,
    role,
    obsStartMs,
    obsEndMs,
    open: open
      ? {
          value: open.value,
          observedAt: open.at,
          receivedAt: open.tick.receivedAt || undefined,
          provider: open.tick.provider,
          sourceId: open.tick.sourceId,
          sourceHash: open.tick.sourceHash
        }
      : undefined,
    close: close
      ? {
          value: close.value,
          observedAt: close.at,
          receivedAt: close.tick.receivedAt || undefined,
          provider: close.tick.provider,
          sourceId: close.tick.sourceId,
          sourceHash: close.tick.sourceHash
        }
      : undefined,
    source
  });

  const snap = await getObservationSnapshot(mkt);
  if (snap?.frozen && snap.outcome && Number.isFinite(snap.startValue) && Number.isFinite(snap.endValue)) {
    return {
      market,
      outcome: snap.outcome,
      observedValue: snap.endValue,
      openValue: snap.startValue,
      threshold: snap.startValue,
      referenceSource: snap.source,
      startSource: snap.startSource,
      endSource: snap.endSource,
      frozen: true,
      resolutionTxHash: snap.resolutionTxHash
    };
  }

  const ready = snapshotReadyForResolve(snap, obsStartMs, obsEndMs, maxDist);
  if (!ready.ok) {
    const now = Date.now();
    if (now < obsEndMs + graceMs) {
      return {
        error: `${ready.reason} (waiting for snapshot grace until ${new Date(obsEndMs + graceMs).toISOString()})`,
        deferred: true,
        market
      };
    }
    const cancel = await cancelMarketOnchain(
      id,
      `Reliable observation snapshot unavailable: ${ready.reason}`
    );
    return {
      error: ready.reason,
      cancelled: true,
      cancel,
      market: await getOnchainMarket(id, { includeTradeStats: false })
    };
  }

  const openValue = ready.start;
  const observedValue = ready.end;
  // Explicit rule: end > start → YES; end < start → NO; end === start (flat) → NO.
  const { outcome } = resolveOutcomeFromPrints(openValue, observedValue);
  const result = await resolveMarketOnchain(id, outcome);
  const txHash =
    result && typeof result === "object" && "hash" in result
      ? String((result as { hash?: string }).hash ?? "")
      : "";

  // Freeze only after successful receipt + on-chain Resolved + matching outcome.
  if (!txHash || (result && "error" in result && result.error)) {
    return { ...result, error: "resolve transaction failed — evidence not frozen", market };
  }
  try {
    const item = findDemoMarket(id);
    const marketAddr = item ? addr(item.market) : getAddress(mkt);
    const [statusN, winning] = await Promise.all([
      publicClient.readContract({ address: marketAddr, abi: marketAbi, functionName: "status" }),
      publicClient.readContract({
        address: marketAddr,
        abi: marketAbi,
        functionName: "winningOutcome"
      })
    ]);
    const statusNum = Number(statusN);
    const winNum = Number(winning);
    const expectedWin = outcome === "YES" ? 1 : 2;
    if (statusNum !== 3 || winNum !== expectedWin) {
      return {
        ...result,
        error: `on-chain status/outcome mismatch after resolve (status=${statusNum}, win=${winNum})`,
        market: await getOnchainMarket(id, { includeTradeStats: false })
      };
    }
    await freezeObservationSnapshot({
      market: mkt,
      role,
      outcome,
      startValue: openValue,
      startTimestamp: ready.startAt,
      endValue: observedValue,
      endTimestamp: ready.endAt,
      source,
      resolutionTxHash: txHash,
      onchainStatus: statusNum,
      startSource: ready.startSource,
      endSource: ready.endSource
    });
  } catch (freezeErr) {
    return {
      ...result,
      error: `resolve ok but freeze failed: ${freezeErr instanceof Error ? freezeErr.message : freezeErr}`,
      market: await getOnchainMarket(id, { includeTradeStats: false })
    };
  }

  return {
    ...result,
    outcome,
    observedValue,
    threshold: openValue,
    openValue,
    referenceSource: source,
    startSource: ready.startSource,
    endSource: ready.endSource,
    frozen: true
  };
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
  const receipt = await waitSuccessfulReceipt(publicClient, hash);
  return { hash, status: receipt.status, market: await getOnchainMarket(id, { includeTradeStats: false }), reason };
}

/** Worth asking the chain whether anything is still open. */
export function settleRunReachedEnd(input: {
  reachedEnd: boolean;
  failedCount: number;
}): boolean {
  return input.reachedEnd && input.failedCount === 0;
}

/**
 * A settle run is complete only when the engine itself reports zero exposure.
 *
 * Walking off the end of the log list is not proof: a reverted settleTicket leaves the
 * ticket Open and its reserve locked on the pool. Free LP capital remains withdrawable
 * while reserved > 0, but ring-fenced reserves still need settlement to fully clear.
 * When the exposure check cannot be made, stay not-done.
 */
export function settleRunIsComplete(input: {
  reachedEnd: boolean;
  failedCount: number;
  engineReportsNoExposure?: boolean;
}): boolean {
  if (!settleRunReachedEnd(input)) return false;
  return input.engineReportsNoExposure === true;
}

/**
 * Settle open tickets for a market in bounded chunks so worker passes stay responsive.
 * Pass `cursor` (ticket index into bought logs) to continue; response includes nextCursor.
 */
export async function settleMarketTicketsOnchain(
  id: string,
  options?: { cursor?: number; limit?: number }
) {
  assertDeployment();
  const item = findDemoMarket(id);
  if (!item) return undefined;
  const market = addr(item.market);
  const rawStatus = Number(await publicClient.readContract({ address: market, abi: marketAbi, functionName: "status" }));
  if (rawStatus !== 3 && rawStatus !== 4) {
    return { error: "Market must be resolved or cancelled before tickets can be settled." };
  }

  // Settlement must see every ticket for this market. New markets persist their
  // creation block, so the strict scan starts there instead of at the deployment
  // block. Legacy markets fall back to the original full-range behaviour.
  const origin = await marketOriginStore.get(market.toLowerCase()).catch(() => null);
  const latestBlock = await publicClient.getBlockNumber();
  let settlementFromBlock = configuredTicketFromBlock();
  if (origin?.fromBlock) {
    try {
      const parsed = BigInt(origin.fromBlock);
      if (parsed >= 0n && parsed <= latestBlock) settlementFromBlock = parsed;
    } catch {
      // Keep strict deployment-block fallback for malformed legacy metadata.
    }
  }
  const logs =
    settlementFromBlock <= latestBlock
      ? await ticketBoughtLogsChunked(
          { market },
          settlementFromBlock,
          latestBlock,
          true
        )
      : [];
  const wallet = resolverWallet();
  const settled: Array<{ ticketId: string; hash: string; status: string }> = [];
  /** Already-settled tickets — safe to walk past. */
  const skipped: string[] = [];
  /** Tickets that are still Open because settlement reverted — must be retried. */
  const failed: string[] = [];
  let firstFailedIndex: number | undefined;

  const limit = Math.max(1, Math.min(options?.limit ?? 15, 50));
  let cursor = Math.max(0, options?.cursor ?? 0);
  if (cursor > logs.length) cursor = logs.length;

  let processed = 0;
  let i = cursor;
  for (; i < logs.length && processed < limit; i++) {
    const log = logs[i]!;
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
    processed += 1;
    const hash = await wallet.writeContract({
      address: addr(deployment.microBoostEngine),
      abi: engineAbi,
      functionName: "settleTicket",
      args: [ticketId]
    });
    try {
      const receipt = await waitSuccessfulReceipt(publicClient, hash);
      settled.push({ ticketId: ticketId.toString(), hash, status: receipt.status });
    } catch (err) {
      // A ticket that failed to settle still holds LP reserve. Remember the first
      // such index so the caller retries from here instead of walking past it.
      if (firstFailedIndex === undefined) firstFailedIndex = i;
      failed.push(
        `${ticketId.toString()}: ${err instanceof Error ? err.message : "settle reverted"}`
      );
    }
  }

  // Resume from the earliest unsettled ticket, not merely from where we stopped.
  const resumeAt = firstFailedIndex ?? i;
  const nextCursor = resumeAt < logs.length ? resumeAt : undefined;

  let engineReportsNoExposure: boolean | undefined;
  if (settleRunReachedEnd({ reachedEnd: nextCursor === undefined, failedCount: failed.length })) {
    try {
      engineReportsNoExposure = Boolean(
        await publicClient.readContract({
          address: addr(deployment.microBoostEngine),
          abi: engineAbi,
          functionName: "marketHasNoExposure",
          args: [market]
        })
      );
    } catch {
      engineReportsNoExposure = undefined; // cannot confirm → not done
    }
  }
  const done = settleRunIsComplete({
    reachedEnd: nextCursor === undefined,
    failedCount: failed.length,
    engineReportsNoExposure
  });

  return {
    market: await getOnchainMarket(id, { includeTradeStats: false }),
    settledCount: settled.length,
    skippedCount: skipped.length,
    settled,
    skipped,
    failed,
    failedCount: failed.length,
    cursor,
    nextCursor,
    totalLogs: logs.length,
    done
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
  // Clamp to 13..87%, not 5..95%: above ~88% the quoted side (mid × 1.08) hits the
  // on-chain 0.95 price cap, which (a) collapses the recovered mid back to ~0.8796 on
  // the first trade ("ratchet") and (b) thins the overround that funds Micro Boost.
  // 13..87 keeps YES+NO == 1.080000 exactly and avoids the ratchet entirely.
  const yesPrice = BigInt(Math.round(clampNumber(yesPricePercent, 13, 87, 50) * 10_000));
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
  let createReceipt;
  try {
    createReceipt = await waitSuccessfulReceipt(publicClient, createHash);
  } catch {
    return { createHash, status: "reverted", error: "createMarket transaction failed" };
  }

  const logs = parseEventLogs({ abi: factoryAbi, logs: createReceipt.logs, eventName: "MarketCreated" });
  const marketAddress = logs[0]?.args.market;
  if (!marketAddress) {
    return { createHash, status: createReceipt.status, error: "MarketCreated event not found" };
  }

  if (createReceipt.blockNumber !== null && createReceipt.blockNumber !== undefined) {
    await marketOriginStore
      .set(getAddress(marketAddress).toLowerCase(), {
        fromBlock: createReceipt.blockNumber.toString(),
        createdAt: new Date().toISOString()
      })
      .catch(() => undefined);
  }

  const openHash = await wallet.writeContract({
    address: addr(marketAddress),
    abi: marketAbi,
    functionName: "open"
  });
  const openReceipt = await waitSuccessfulReceipt(publicClient, openHash);
  const item: DemoMarketDeployment = {
    id: getAddress(marketAddress),
    label: "Admin-created market",
    role,
    market: getAddress(marketAddress)
  };
  exposeMarketInUi(item.market);

  const createdMarket = await readOnchainMarket(item, { includeTradeStats: false });
  if (createdMarket) rememberOnchainMarket(createdMarket);
  return {
    createHash,
    openHash,
    status: openReceipt.status,
    marketAddress: item.market,
    market: createdMarket
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

type HistoryPoint = { value: number; at: number };

type DemoReferenceData = {
  btcUsd?: Awaited<ReturnType<typeof fetchBtcSpot>> & { history?: HistoryPoint[] };
  londonWeather?: Omit<Awaited<ReturnType<typeof fetchWeather>>, "history"> & {
    history?: HistoryPoint[];
  };
  updatedAt: string;
};

let btcReferenceCache: { expiresAt: number; data: DemoReferenceData["btcUsd"] } | undefined;
let weatherReferenceCache: { expiresAt: number; data: NonNullable<DemoReferenceData["londonWeather"]> } | undefined;
let btcHistoryCache: { expiresAt: number; points: HistoryPoint[] } | undefined;
let weatherHistoryCache: { expiresAt: number; points: HistoryPoint[] } | undefined;
const btcTickHistory: HistoryPoint[] = [];
const weatherTickHistory: HistoryPoint[] = [];

/**
 * KV-backed tick history persistence.
 * In-memory arrays are lost on restarts and differ across replicas,
 * so observation charts looked empty. Load last ~10 min from KV once per isolate;
 * write back every 45s (throttled) so free-tier Upstash stays comfortable.
 */
let kvTicksLoaded = false;
let lastKvTickSaveAt = 0;
const KV_TICK_SAVE_INTERVAL_MS = 45_000;
const KV_TICK_MAX_POINTS = 120;

async function ensureTickHistoryFromKv(): Promise<void> {
  if (kvTicksLoaded) return;
  kvTicksLoaded = true;
  try {
    const { NamespaceStore } = await import("./persistentStore.js");
    const store = new NamespaceStore<HistoryPoint[]>("tick-history");
    const [btcTicks, weatherTicks] = await Promise.all([
      store.get("btc").catch(() => null),
      store.get("weather").catch(() => null)
    ]);
    const cutoff = Date.now() - 10 * 60_000;
    if (btcTicks && Array.isArray(btcTicks) && btcTickHistory.length === 0) {
      const valid = btcTicks.filter(
        (p) => Number.isFinite(p?.value) && Number.isFinite(p?.at) && p.at > cutoff
      );
      btcTickHistory.push(...valid);
    }
    if (weatherTicks && Array.isArray(weatherTicks) && weatherTickHistory.length === 0) {
      const valid = weatherTicks.filter(
        (p) => Number.isFinite(p?.value) && Number.isFinite(p?.at) && p.at > cutoff
      );
      weatherTickHistory.push(...valid);
    }
  } catch {
    // KV unavailable — proceed with in-memory only.
  }
}

async function maybeSaveTickHistoryToKv(): Promise<void> {
  const now = Date.now();
  if (now - lastKvTickSaveAt < KV_TICK_SAVE_INTERVAL_MS) return;
  lastKvTickSaveAt = now;
  try {
    const { NamespaceStore } = await import("./persistentStore.js");
    const store = new NamespaceStore<HistoryPoint[]>("tick-history");
    await Promise.all([
      btcTickHistory.length > 0
        ? store.set("btc", btcTickHistory.slice(-KV_TICK_MAX_POINTS))
        : Promise.resolve(),
      weatherTickHistory.length > 0
        ? store.set("weather", weatherTickHistory.slice(-KV_TICK_MAX_POINTS))
        : Promise.resolve()
    ]);
  } catch {
    // non-fatal
  }
}

const demoReferenceResponseCache = new Map<
  "full" | "lite",
  { at: number; data: DemoReferenceData }
>();
const demoReferenceResponseInflight = new Map<
  "full" | "lite",
  Promise<DemoReferenceData>
>();

/**
 * Public demo/chart feed. By default does NOT write oracle raw-ticks — those
 * are written only from the market-cycle / resolve worker path
 * (`ingestOracleTicks: true`) so viewer traffic cannot wash the ZSET.
 */
export async function getDemoReferenceData(opts?: {
  ingestOracleTicks?: boolean;
  includeHistory?: boolean;
}) {
  const publicRead = !opts?.ingestOracleTicks;
  const includeHistory = opts?.includeHistory !== false;
  const cacheKey = includeHistory ? "full" : "lite";
  const cached = demoReferenceResponseCache.get(cacheKey);
  if (publicRead && cached && Date.now() - cached.at < 5_000) {
    return cached.data;
  }
  const inflight = demoReferenceResponseInflight.get(cacheKey);
  if (publicRead && inflight) return inflight;

  const load = async (): Promise<DemoReferenceData> => {
  // Hydrate tick history from KV on cold start so charts show accumulated data.
  await ensureTickHistoryFromKv();

  const [btc, weather, btcHistory, weatherHistory] = await Promise.allSettled([
    fetchCachedBtcSpot(),
    fetchCachedWeather(),
    includeHistory ? fetchCachedBtcHistory() : Promise.resolve([]),
    includeHistory ? fetchCachedWeatherHistory() : Promise.resolve([])
  ]);
  const btcData = btc.status === "fulfilled" ? btc.value : undefined;
  if (btcData && Number.isFinite(btcData.price)) {
    const at = Date.parse(btcData.updatedAt) || Date.now();
    pushTick(btcTickHistory, btcData.price, at, 800);
    // Oracle raw-ticks: worker path only (capture / resolve), never public chart polls.
    if (opts?.ingestOracleTicks) {
      void import("./rawTicks.js").then(({ pushRawTick }) =>
        pushRawTick("btc", btcData.price as number, at, {
          provider: btcData.source ?? "coinbase",
          sourceHash: simpleSourceHash({
            feed: "btc",
            value: btcData.price as number,
            observedAt: at,
            provider: btcData.source ?? "coinbase"
          })
        })
      );
    }
  }
  const weatherData = weather.status === "fulfilled" ? weather.value : undefined;
  if (weatherData && Number.isFinite(weatherData.temperatureC)) {
    const at =
      parseProviderUtcMs((weatherData as { observedAt?: string }).observedAt || "") ||
      Date.parse(weatherData.updatedAt) ||
      Date.now();
    // Charts may use stale cache; oracle ticks must not.
    const isStale =
      Boolean((weatherData as { isStale?: boolean }).isStale) ||
      String(weatherData.source || "").includes("(cached)");
    pushTick(weatherTickHistory, weatherData.temperatureC, at, 2_500);
    if (!isStale && opts?.ingestOracleTicks) {
      void import("./rawTicks.js").then(({ pushRawTick }) =>
        pushRawTick("weather", weatherData.temperatureC as number, at, {
          provider: weatherData.source ?? "open-meteo",
          sourceHash: simpleSourceHash({
            feed: "weather",
            value: weatherData.temperatureC as number,
            observedAt: at,
            provider: weatherData.source ?? "open-meteo"
          })
        })
      );
    }
  }

  const btcCandles = btcHistory.status === "fulfilled" ? btcHistory.value : [];
  const weatherSeries = weatherHistory.status === "fulfilled" ? weatherHistory.value : [];
  const weatherFromFeed =
    weatherData?.history && weatherData.history.length >= 4
      ? weatherData.history
      : weatherSeries;

  // Persist ticks to KV periodically (non-blocking).
  void maybeSaveTickHistoryToKv();

    return {
      btcUsd: btcData
        ? {
            ...btcData,
            ...(includeHistory
              ? { history: mergeHistory(btcCandles, btcTickHistory, 1).slice(-90) }
              : { history: undefined })
          }
        : undefined,
      londonWeather: weatherData
        ? {
            ...weatherData,
            ...(includeHistory
              ? { history: mergeHistory(weatherFromFeed, weatherTickHistory, 15).slice(-120) }
              : { history: undefined })
          }
        : undefined,
      updatedAt: new Date().toISOString()
    };
  };

  if (!publicRead) return load();
  const request = load()
    .then((data) => {
      demoReferenceResponseCache.set(cacheKey, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      demoReferenceResponseInflight.delete(cacheKey);
    });
  demoReferenceResponseInflight.set(cacheKey, request);
  return request;
}

async function fetchCachedBtcSpot() {
  const now = Date.now();
  // Five-second oracle sampling does not benefit from sub-second refetches. Sharing
  // a 4s cache also collapses concurrent chart + worker requests.
  if (btcReferenceCache && btcReferenceCache.expiresAt > now) return btcReferenceCache.data;
  const data = await fetchBtcSpot();
  btcReferenceCache = { data, expiresAt: now + 4_000 };
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
    // Provider prints are on a 15-minute grid; one request per minute is ample for
    // boundary capture and avoids wasting Railway egress/CPU on duplicate payloads.
    weatherReferenceCache = { data, expiresAt: now + 60_000 };
    weatherStaleCache = { data, savedAt: now };
    return data;
  } catch (error) {
    if (weatherStaleCache && now - weatherStaleCache.savedAt < WEATHER_STALE_MAX_MS) {
      // Charts may show stale data, but oracle must not treat it as a fresh print.
      return {
        ...weatherStaleCache.data,
        source: `${weatherStaleCache.data.source} (cached)`,
        isStale: true,
        // Keep original observation timestamps — do not mask as "now".
        updatedAt: weatherStaleCache.data.updatedAt,
        observedAt: weatherStaleCache.data.observedAt
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
  // Accept common signer-key aliases used by deployment environments
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
  const primaryEnvUrl =
    process.env.ARC_RPC_URL?.trim() || process.env.NEXT_PUBLIC_ARC_RPC_URL?.trim();
  const explicit = Array.from(
    new Set([...(primaryEnvUrl ? [primaryEnvUrl] : []), ...envUrls].filter(Boolean))
  ).filter(isStableArcRpcUrl);
  const publicFallbacks = ["https://rpc.testnet.arc.network", "https://arc-testnet.drpc.org"];

  // An explicit Railway endpoint is authoritative. Silently falling through to
  // public gateways makes usage accounting unpredictable and may repeat a failed
  // request against several providers. Opt in only for emergency availability.
  if (explicit.length > 0) {
    const allowPublicFallback = process.env.RPC_ENABLE_PUBLIC_FALLBACK === "1";
    return Array.from(
      new Set([
        ...explicit,
        ...(allowPublicFallback ? publicFallbacks : [])
      ])
    ).filter(isStableArcRpcUrl);
  }

  return Array.from(
    new Set([
      ...(Array.isArray(config?.rpcUrls) ? config.rpcUrls : []),
      config?.rpcUrl,
      ...publicFallbacks
    ].filter(Boolean) as string[])
  ).filter(isStableArcRpcUrl);
}

function isStableArcRpcUrl(url: string): boolean {
  return !url.includes("quicknode") && !url.includes("blockdaemon");
}

function buildRpcTransport(urls: string[]) {
  // Batch concurrent eth_calls to reduce HTTP overhead. dRPC's free tier accepts
  // at most three methods in one batch; larger batches fail and then repeat all
  // calls through the plain fallback. Keep the default provider-safe and allow
  // a smaller value through RPC_BATCH_SIZE. RPC_BATCH=0 disables batching.
  if (process.env.RPC_BATCH === "0") {
    const plain = urls.map((url) => http(url));
    return plain.length === 1 ? plain[0] : fallback(plain, { rank: false });
  }

  const requestedBatchSize = Number(process.env.RPC_BATCH_SIZE ?? "3");
  const batchSize = Number.isFinite(requestedBatchSize)
    ? Math.max(1, Math.min(3, Math.floor(requestedBatchSize)))
    : 3;
  const transports = urls.flatMap((url) => [
    http(url, { batch: { batchSize, wait: 16 } }),
    http(url)
  ]);
  return fallback(transports, { rank: false });
}

function loadDeployment(): Deployment {
  const candidates = [
    process.env.PROBX_DEPLOYMENT_PATH,
    // Next app working-directory candidate
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
  // Default matches marketCycleWorker LOCK_SECONDS (75), not 1h — 3600 was a leftover
  // that made admin/demo creates look like hour-long markets when the env was unset.
  const lockSeconds = clampInteger(process.env.DEMO_MARKET_LOCK_SECONDS, 45, 86_400, 75);
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
    // Normalize to ISO-with-Z so downstream Date.parse is host-TZ independent.
    observedAt: (() => {
      const ms = parseProviderUtcMs(payload.current?.time);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : payload.current?.time;
    })(),
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
    observedAt: (() => {
      const ms = parseProviderUtcMs(payload.current?.time);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : payload.current?.time;
    })(),
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

/**
 * Parse Open-Meteo / provider timestamps that omit timezone.
 * With `&timezone=UTC` the API returns `"2026-07-25T09:15"` — ECMAScript treats
 * that as *local* time, which shifts observedAt on non-UTC hosts. Append Z when
 * no offset is present so parse is always UTC.
 */
export function parseProviderUtcMs(raw: string | undefined | null): number {
  const s = String(raw ?? "").trim();
  if (!s) return Number.NaN;
  // Already has Z or ±offset
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    return Date.parse(s);
  }
  // "2026-07-25T09:15" or "2026-07-25T09:15:00" → force UTC
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    return Date.parse(s.endsWith("Z") ? s : `${s}Z`);
  }
  return Date.parse(s);
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
    const at = parseProviderUtcMs(times[i]);
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

/**
 * Record opening metadata for a ticket. Create-only; values for price/source
 * are taken from server feeds + on-chain ticket, not trusted client fields.
 */
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
  const { getTicketOpening, upsertTicketOpening } = await import("./ticketOpenings.js");
  const ticketId = String(body.ticketId ?? "").replace(/^PXLT-/i, "").trim();
  if (!ticketId || !/^\d+$/.test(ticketId)) return { error: "ticketId is required (numeric)" };

  const existing = getTicketOpening(ticketId);
  if (existing) return { status: "ok", opening: existing, created: false };

  assertDeployment();
  let ticketIdBn: bigint;
  try {
    ticketIdBn = BigInt(ticketId);
  } catch {
    return { error: "invalid ticketId" };
  }

  // Verify ticket exists on-chain and bind market/owner from chain.
  const onchain = await publicClient.readContract({
    address: addr(deployment.positionTicket),
    abi: ticketAbi,
    functionName: "getTicket",
    args: [ticketIdBn]
  });
  const zero = "0x0000000000000000000000000000000000000000";
  const chainMarketRaw = String(onchain.market || zero);
  const chainOwnerRaw = String(onchain.owner || zero);
  // getTicket returns zero struct for non-existent ids — reject those.
  if (
    !chainMarketRaw ||
    chainMarketRaw.toLowerCase() === zero ||
    !chainOwnerRaw ||
    chainOwnerRaw.toLowerCase() === zero ||
    Number(onchain.status) === 0
  ) {
    return { error: "ticket does not exist" };
  }
  const chainMarket = getAddress(chainMarketRaw);
  const chainOwner = getAddress(chainOwnerRaw);
  const chainOutcome = Number(onchain.outcome) === 2 ? "NO" : Number(onchain.outcome) === 1 ? "YES" : undefined;

  const clientMarket =
    typeof body.marketAddress === "string" && /^0x[a-fA-F0-9]{40}$/i.test(body.marketAddress)
      ? getAddress(body.marketAddress)
      : undefined;
  if (clientMarket && clientMarket !== chainMarket) {
    return { error: "marketAddress does not match on-chain ticket" };
  }

  // Server-side reference snapshot (never trust client referencePrice/source).
  //
  // The price must come from when the ticket was BOUGHT, not from when this endpoint
  // happens to be called. The route is public and create-only, so anyone can call it
  // first for someone else's ticket (ids are sequential and TicketBought is public) and
  // permanently bind a price from an unrelated moment. Anchoring to the purchase block
  // makes the result identical no matter who calls it or when.
  let openedAtMs: number | undefined;
  try {
    const boughtLogs = await ticketBoughtLogsForMarket(chainMarket, true, true);
    const mine = boughtLogs.find((l) => String(l.args.ticketId ?? "") === ticketId);
    if (mine?.blockNumber !== undefined && mine.blockNumber !== null) {
      const block = await publicClient.getBlock({ blockNumber: mine.blockNumber });
      openedAtMs = Number(block.timestamp) * 1000;
    }
  } catch {
    /* fall back to live reading below */
  }

  let referencePrice: number | undefined;
  let feed: "btc" | "weather" | "none" = "none";
  let source: string | undefined;
  try {
    const data = await getDemoReferenceData();
    const mkt = await getOnchainMarket(chainMarket).catch(() => undefined);
    const q = (mkt?.question || "").toLowerCase();
    const isBtc =
      mkt?.demoRole === "btc_price" ||
      mkt?.category === "crypto-candle" ||
      /\bbtc\b/.test(q);
    const isWeather =
      mkt?.demoRole === "london_weather" ||
      mkt?.category === "weather" ||
      q.includes("london");
    if (isBtc && Number.isFinite(data.btcUsd?.price)) {
      feed = "btc";
      referencePrice = data.btcUsd!.price;
      source = data.btcUsd!.source;
    } else if (isWeather && Number.isFinite(data.londonWeather?.temperatureC)) {
      feed = "weather";
      referencePrice = data.londonWeather!.temperatureC;
      source = data.londonWeather!.source;
    }

    // Prefer the retained tick nearest the purchase block over the live reading.
    if (feed !== "none" && openedAtMs) {
      const { getRawTicks, nearestRawTick } = await import("./rawTicks.js");
      const ticks = await getRawTicks(feed);
      const at = nearestRawTick(ticks, openedAtMs, 5 * 60_000);
      if (at) {
        referencePrice = at.value;
        source = `${at.tick.provider} @ purchase block`;
      } else if (referencePrice !== undefined) {
        // Ticket older than tick retention — say so rather than passing a live number
        // off as the purchase-time price.
        source = `${source ?? "feed"} (approx — purchase-time tick expired)`;
      }
    }
  } catch {
    /* best-effort */
  }

  const meta = upsertTicketOpening({
    ticketId,
    marketId: chainMarket,
    marketAddress: chainMarket,
    outcome: chainOutcome,
    referencePrice,
    referenceFeed: feed,
    referenceLabel:
      feed === "btc"
        ? "BTC/USD at ticket open (settle uses observation end)"
        : feed === "weather"
          ? "London temp at ticket open (settle uses observation end)"
          : "Reference at ticket open",
    threshold: referencePrice,
    source,
    owner: chainOwner,
    // Purchase-block time when we could read it — not "whenever this was called".
    openedAt: new Date(openedAtMs ?? Date.now()).toISOString()
  });
  return { status: "ok", opening: meta, created: true };
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
