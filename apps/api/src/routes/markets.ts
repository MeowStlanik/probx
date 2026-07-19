import { db, nextId } from "../db/client.js";
import type { Market, Outcome, Ticket } from "../db/schema.js";
import { buildLpStats } from "../services/lpStatsService.js";
import { refreshMarket } from "../services/marketScheduler.js";
import {
  createMarketOnchain,
  getDemoReferenceData,
  getOnchainMarket,
  hideMarketOnchain,
  listOnchainMarkets,
  onchainEnabled,
  quoteOnchainTicket,
  resetDemoMarketsOnchain
} from "../services/onchainService.js";
import { quoteTicket } from "../services/quoteEngine.js";
import { applyExposureChecks } from "../services/riskEngine.js";

/**
 * Micro-cache for the public markets list.
 * A full onchain list is ~10 RPC calls per market; the UI polls every 5s and
 * every tab open re-fetches. 2.5s freshness is invisible next to 60s rounds,
 * collapses concurrent loads into one chain read, and serves last-good data
 * for up to 60s if the RPC hiccups. The cycle worker bypasses this (forCycle).
 */
const MARKETS_CACHE_FRESH_MS = 2_500;
const MARKETS_CACHE_STALE_MS = 60_000;
let marketsCache: { at: number; data: Market[] } | null = null;
let marketsInflight: Promise<Market[]> | null = null;

export async function listMarkets(): Promise<Market[]> {
  if (!onchainEnabled()) return db.markets.map(refreshMarket);

  const now = Date.now();
  if (marketsCache && now - marketsCache.at < MARKETS_CACHE_FRESH_MS) {
    return marketsCache.data;
  }

  if (!marketsInflight) {
    marketsInflight = listOnchainMarkets()
      .then((data) => {
        marketsCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        marketsInflight = null;
      });
  }

  try {
    return await marketsInflight;
  } catch (error) {
    // Surface the real cause in server logs instead of silently serving demo
    // data — a stuck "demo candle" card means this path is firing.
    console.error(
      "[markets] onchain list failed, serving fallback:",
      error instanceof Error ? error.message : error
    );
    if (marketsCache && now - marketsCache.at < MARKETS_CACHE_STALE_MS) {
      return marketsCache.data;
    }
    return db.markets.map(refreshMarket);
  }
}

export async function getMarket(id: string): Promise<Market | undefined> {
  if (onchainEnabled()) {
    try {
      const market = await getOnchainMarket(id);
      if (market) return market;
    } catch {
      // Fall through to demo data.
    }
  }
  const market = db.markets.find((item) => item.id === id);
  return market ? refreshMarket(market) : undefined;
}

export async function getMarketQuote(id: string, params: URLSearchParams, userAddress?: string) {
  if (onchainEnabled()) {
    try {
      const quote = await quoteOnchainTicket(id, params);
      if (quote) return quote;
    } catch {
      // Fall through to demo quote for API resilience.
    }
  }

  const market = await getMarket(id);
  if (!market) return undefined;

  const outcome = normalizeOutcome(params.get("outcome"));
  const riskAmount = Number(params.get("amount") ?? "100");
  const boost = Number(params.get("boost") ?? "1");
  const lp = buildLpStats(db.lp, db.tickets);
  const quote = quoteTicket({
    market,
    outcome,
    riskAmount,
    boost,
    availableReserve: lp.availableLiquidity
  });

  return applyExposureChecks({
    market,
    quote,
    tickets: db.tickets,
    lp,
    userAddress
  });
}

export async function createDemoMarket(body: Partial<Market> & {
  yesPricePercent?: number;
  lockSeconds?: number;
  observationSeconds?: number;
  demoRole?: Market["demoRole"];
}) {
  if (onchainEnabled()) {
    try {
      return await createMarketOnchain(body);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "onchain market create failed" };
    }
  }

  const now = Date.now();
  const lockMs = Math.max(5_000, (body.lockSeconds ?? 5) * 1000);
  const observeMs = Math.max(15_000, (body.observationSeconds ?? 30) * 1000);
  const openTime = new Date(now).toISOString();
  const lockTime = new Date(now + lockMs).toISOString();
  const observationStart = lockTime;
  const observationEnd = new Date(now + lockMs + observeMs).toISOString();
  const demoRole = body.demoRole ?? "open";
  const isBtc = demoRole === "btc_price" || body.category === "crypto-candle";

  const market: Market = {
    id: nextId("mkt", db.markets),
    question:
      body.question ??
      (isBtc
        ? "Will BTC/USD be above the live threshold during the observation window?"
        : "Will the next demo signal be GREEN?"),
    rules:
      body.rules ??
      (isBtc
        ? "YES if Coinbase BTC/USD is at/above the market threshold at observation end."
        : "YES if Demo Oracle emits GREEN during the observation window. NO if RED or timeout."),
    category: body.category ?? (isBtc ? "crypto-candle" : "demo-signal"),
    demoRole,
    status: "OPEN",
    yesPrice: body.yesPrice ?? 0.5,
    noPrice: body.noPrice ?? 0.5,
    openTime,
    lockTime,
    observationStart,
    observationEnd,
    resolutionSource: body.resolutionSource ?? (isBtc ? "Coinbase BTC/USD" : "Demo Oracle"),
    volume: 0,
    maxBoost: body.maxBoost ?? 5,
    rulesHash: body.rulesHash ?? `0xdemo-${Date.now().toString(16)}`
  };

  db.markets.unshift(market);
  return market;
}

/**
 * Tour helper: reuse an OPEN BTC market if one exists, otherwise create one.
 * Silent — no user-facing copy; called when the user starts the product tour.
 */
export async function ensureTourBtcMarket(): Promise<{
  marketId: string | null;
  created: boolean;
  status?: string;
  error?: string;
}> {
  const markets = await listMarkets();
  const openBtc = markets.find(
    (m) =>
      m.status === "OPEN" &&
      (m.demoRole === "btc_price" || m.category === "crypto-candle" || /BTC/i.test(m.question))
  );
  if (openBtc) {
    return { marketId: openBtc.id, created: false, status: openBtc.status };
  }

  try {
    const result = await createDemoMarket({
      demoRole: "btc_price",
      category: "crypto-candle",
      // Longer entry window so the tour user can fund + buy after connect.
      lockSeconds: 90,
      observationSeconds: 60
    });

    if (result && typeof result === "object" && "error" in result && result.error) {
      return { marketId: null, created: false, error: String(result.error) };
    }

    const marketAddress =
      result && typeof result === "object" && "marketAddress" in result
        ? String((result as { marketAddress?: string }).marketAddress ?? "")
        : "";
    const marketObj =
      result && typeof result === "object" && "market" in result
        ? (result as { market?: Market }).market
        : (result as Market | undefined);
    const id =
      marketAddress ||
      marketObj?.id ||
      (result && typeof result === "object" && "id" in result ? String((result as Market).id) : "");

    if (!id) {
      return { marketId: null, created: false, error: "market create returned no id" };
    }
    return { marketId: id, created: true, status: "OPEN" };
  } catch (error) {
    return {
      marketId: null,
      created: false,
      error: error instanceof Error ? error.message : "ensure tour market failed"
    };
  }
}

export async function hideDemoMarket(marketId: string) {
  if (onchainEnabled()) {
    try {
      return await hideMarketOnchain(marketId);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "onchain market hide failed" };
    }
  }
  const before = db.markets.length;
  db.markets = db.markets.filter((market) => market.id !== marketId);
  return { status: "hidden", removedCount: before - db.markets.length };
}

export async function resetDemoMarkets() {
  if (onchainEnabled()) {
    try {
      return await resetDemoMarketsOnchain();
    } catch (error) {
      return { error: error instanceof Error ? error.message : "onchain demo reset failed" };
    }
  }
  db.markets = seedBasicMarkets();
  return { status: "success", markets: db.markets };
}

export async function demoReferenceData() {
  if (onchainEnabled()) return getDemoReferenceData();
  return { updatedAt: new Date().toISOString() };
}

export async function buyDemoTicket(body: {
  marketId?: string;
  owner?: string;
  outcome?: Outcome;
  riskAmount?: number;
  boost?: number;
}): Promise<Ticket> {
  if (!body.marketId) throw new Error("marketId is required");
  const market = db.markets.find((item) => item.id === body.marketId);
  if (!market) throw new Error("market not found");
  const owner = body.owner ?? "0xDemoUser";
  const outcome = body.outcome ?? "YES";
  const quote = await getMarketQuote(market.id, new URLSearchParams({
    outcome,
    amount: String(body.riskAmount ?? 100),
    boost: String(body.boost ?? 1)
  }), owner);
  if (!quote) throw new Error("quote unavailable");
  if (!quote.accepted) throw new Error(quote.reason);

  const ticket: Ticket = {
    id: nextId("tkt", db.tickets),
    owner,
    marketId: market.id,
    outcome,
    riskAmount: quote.riskAmount,
    boost: quote.boost,
    quotedPrice: outcome === "YES" ? market.yesPrice : market.noPrice,
    payout: quote.payout,
    requiredReserve: quote.requiredReserve,
    fee: quote.fee,
    status: "OPEN",
    createdAt: new Date().toISOString()
  };

  db.tickets.push(ticket);
  market.volume += quote.riskAmount;
  return ticket;
}

function normalizeOutcome(value: string | null): Outcome {
  return value?.toUpperCase() === "NO" ? "NO" : "YES";
}

function seedBasicMarkets(): Market[] {
  const now = Date.now();
  return [
    buildSeedMarket("mkt_btc_1m", "Will BTC/USD be above $100,000 during the 1-minute observation window?", now, "crypto-candle"),
    buildSeedMarket("mkt_london_weather", "Will London temperature be at least 20C during the 1-minute observation window?", now, "weather")
  ];
}

function buildSeedMarket(
  id: string,
  question: string,
  now: number,
  category: Market["category"] = "demo-signal"
): Market {
  const lockTime = new Date(now + 90_000).toISOString();
  return {
    id,
    question,
    rules: "YES if the live reference condition is true at auto-resolution. NO otherwise. Claim from Portfolio after resolve.",
    category,
    status: "OPEN",
    yesPrice: 0.5,
    noPrice: 0.5,
    openTime: new Date(now).toISOString(),
    lockTime,
    observationStart: lockTime,
    observationEnd: new Date(now + 150_000).toISOString(),
    resolutionSource: category === "weather"
      ? "Auto-resolve from Open-Meteo"
      : category === "crypto-candle"
        ? "Auto-resolve from Coinbase BTC/USD"
        : "Demo reference feed",
    volume: 0,
    maxBoost: 5,
    rulesHash: `0xseed-${id}`,
    demoRole: category === "weather" ? "london_weather" : category === "crypto-candle" ? "btc_price" : "open"
  };
}
