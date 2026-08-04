/**
 * Server-only data loaders for RSC pages.
 *
 * When NEXT_PUBLIC_API_BASE_URL/API_BASE_URL is configured, server rendering uses
 * that backend exclusively. This prevents a Vercel UI from silently mixing its own
 * bundled API with the persistent Railway backend.
 */
import type { LpStats, Market, Ticket } from "./types";
import { emptyLpStats } from "./sampleData";
import { isOnchainMarketId } from "./api";
import { readOnchainLpStats } from "./readOnchainLpStats";

function normalizeOrigin(raw: string): string {
  let value = raw.trim().replace(/\/$/, "");
  if (!value || value === "same" || value === "/" || value === "undefined" || value === "null") {
    return "";
  }
  if (value.endsWith("/api")) value = value.slice(0, -4).replace(/\/$/, "");
  return value;
}

function configuredApiOrigin(): { origin: string; external: boolean } {
  const apiOrigin = normalizeOrigin(
    process.env.NEXT_PUBLIC_API_BASE_URL || process.env.API_BASE_URL || ""
  );
  if (apiOrigin) return { origin: apiOrigin, external: true };

  const siteOrigin = normalizeOrigin(
    process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || ""
  );
  if (siteOrigin) return { origin: siteOrigin, external: false };

  const port = process.env.PORT || "3000";
  return { origin: `http://127.0.0.1:${port}`, external: false };
}

async function httpGetJson(
  path: string,
  timeoutMs = 6_000
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const { origin } = configuredApiOrigin();
  const url = `${origin}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    // Keep SSR snappy — long timeouts made market pages feel "stuck".
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

function onlyOnchain(markets: Market[]): Market[] {
  return markets.filter((m) => isOnchainMarketId(m.id) || isOnchainMarketId(m.contractAddress));
}

function externalApiConfigured(): boolean {
  return configuredApiOrigin().external;
}

export async function fetchMarkets(): Promise<Market[]> {
  // Prefer HTTP — same code path as the deployed /api/markets route
  try {
    const result = await httpGetJson("/api/markets");
    if (result.ok && Array.isArray(result.body) && result.body.length > 0) {
      const markets = onlyOnchain((result.body as Market[]).map(normalizeMarket));
      if (markets.length > 0) return markets;
    }
  } catch {
    // continue
  }

  if (externalApiConfigured()) return [];

  try {
    const { dispatchApiRequest } = await import("../../../api/src/dispatch");
    const result = await dispatchApiRequest({ method: "GET", path: "/api/markets" });
    if (result.status >= 200 && result.status < 300 && Array.isArray(result.body)) {
      return onlyOnchain((result.body as Market[]).map(normalizeMarket));
    }
  } catch {
    // continue
  }

  // Never return mkt_* offline placeholders — they look open/bettable and break MetaMask.
  return [];
}

export async function fetchMarket(id: string): Promise<Market | undefined> {
  if (!isOnchainMarketId(id)) return undefined;

  if (externalApiConfigured()) {
    try {
      const result = await httpGetJson(`/api/markets/${encodeURIComponent(id)}`, 8_000);
      if (result.ok && result.body && typeof result.body === "object") {
        const market = normalizeMarket(result.body as Market);
        if (isOnchainMarketId(market.id) || isOnchainMarketId(market.contractAddress)) return market;
      }
    } catch {
      // External backend is authoritative; do not mix in the Vercel-bundled API.
    }
    return undefined;
  }

  // In-process first — avoids SSR → HTTP → same Next process deadlocks / multi-second waits
  // when the server is busy compiling or handling other requests.
  try {
    const { dispatchApiRequest } = await import("../../../api/src/dispatch");
    const result = await Promise.race([
      dispatchApiRequest({
        method: "GET",
        path: `/api/markets/${encodeURIComponent(id)}`
      }),
      new Promise<{ status: number; body: null }>((resolve) =>
        setTimeout(() => resolve({ status: 504, body: null }), 8_000)
      )
    ]);
    if (result.status >= 200 && result.status < 300 && result.body) {
      const market = normalizeMarket(result.body as Market);
      if (isOnchainMarketId(market.id) || isOnchainMarketId(market.contractAddress)) return market;
    }
  } catch {
    // continue
  }

  try {
    const result = await httpGetJson(`/api/markets/${encodeURIComponent(id)}`, 5_000);
    if (result.ok && result.body && typeof result.body === "object") {
      const market = normalizeMarket(result.body as Market);
      if (isOnchainMarketId(market.id) || isOnchainMarketId(market.contractAddress)) return market;
    }
  } catch {
    // continue
  }

  return undefined;
}

export async function fetchLpStats(): Promise<LpStats> {
  // Prefer /api/lp/stats — includes aggregate totalVolume / totalTickets / totalResolved.
  // Direct on-chain pool read only has TVL/reserves and used to short-circuit the home
  // page with zeros for volume/tickets/resolved forever.

  // 1) HTTP to unified Next API route
  try {
    const result = await httpGetJson("/api/lp/stats", 25_000);
    if (result.ok && result.body && typeof result.body === "object") {
      return normalizeLpStats(result.body as LpStats);
    }
  } catch {
    // continue
  }

  // 2) In-process dispatch (local monorepo / same isolate only).
  if (!externalApiConfigured()) {
    try {
      const { dispatchApiRequest } = await import("../../../api/src/dispatch");
      const result = await dispatchApiRequest({ method: "GET", path: "/api/lp/stats" });
      if (result.status >= 200 && result.status < 300 && result.body) {
        return normalizeLpStats(result.body as LpStats);
      }
    } catch {
      // continue
    }
  }

  // 3) Direct chain read — TVL only, no aggregates
  try {
    const onchain = await readOnchainLpStats();
    if (onchain.tvl > 0 || onchain.availableLiquidity > 0 || onchain.feesEarned > 0) {
      return onchain;
    }
  } catch {
    // continue
  }

  return emptyLpStats;
}

export async function fetchUserTickets(address: string): Promise<Ticket[]> {
  try {
    const result = await httpGetJson(`/api/users/${encodeURIComponent(address)}/tickets`);
    if (result.ok && Array.isArray(result.body)) {
      return (result.body as Ticket[]).map((ticket) => ({
        ...ticket,
        marketQuestion: ticket.marketQuestion ?? ticket.marketId
      }));
    }
    throw new Error(`Portfolio endpoint returned HTTP ${result.status}`);
  } catch (error) {
    if (externalApiConfigured()) {
      throw error instanceof Error ? error : new Error("Portfolio endpoint unreachable");
    }
    if (error instanceof Error && error.message.startsWith("Portfolio")) throw error;
    const { dispatchApiRequest } = await import("../../../api/src/dispatch");
    const result = await dispatchApiRequest({
      method: "GET",
      path: `/api/users/${encodeURIComponent(address)}/tickets`
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Portfolio endpoint returned HTTP ${result.status}`);
    }
    return ((result.body as Ticket[]) ?? []).map((ticket) => ({
      ...ticket,
      marketQuestion: ticket.marketQuestion ?? ticket.marketId
    }));
  }
}

function normalizeMarket(market: Market): Market {
  return {
    ...market,
    maxBoost: market.maxBoost ?? 5,
    volume: market.volume ?? 0,
    ticketCount: market.ticketCount ?? 0
  };
}

function normalizeLpStats(stats: LpStats): LpStats {
  return {
    tvl: Number(stats.tvl) || 0,
    reservedLiquidity: Number(stats.reservedLiquidity) || 0,
    lockedUserRisk: Number(stats.lockedUserRisk) || 0,
    availableLiquidity: Number(stats.availableLiquidity) || 0,
    feesEarned: Number(stats.feesEarned) || 0,
    dailyVolume: Number(stats.dailyVolume) || 0,
    simulatedApy: Number(stats.simulatedApy) || 0,
    simulated: Boolean(stats.simulated),
    totalVolume: Number.isFinite(Number(stats.totalVolume)) ? Number(stats.totalVolume) : undefined,
    totalTickets: Number.isFinite(Number(stats.totalTickets)) ? Number(stats.totalTickets) : undefined,
    totalResolved: Number.isFinite(Number(stats.totalResolved)) ? Number(stats.totalResolved) : undefined
  };
}
