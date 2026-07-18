import type { LpStats, Market, Ticket } from "./types";
import { emptyLpStats, markets as fallbackMarkets } from "./sampleData";

/**
 * Absolute origin for server-side fetch (SSR cannot use relative `/api/...`).
 */
function serverOrigin(): string {
  const explicit = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

/**
 * API base URL.
 * - Browser on Vercel / same-origin: empty string → hits `/api/*` on this host
 * - Empty string is VALID — never treat it as "backend unavailable"
 * - Prefer apiUrl("/api/...") instead of checking if (!base)
 * - Server (SSR): always absolute origin so fetch does not throw / return empty stats
 * - Local: defaults to :3001 for separate API process
 * - Override with NEXT_PUBLIC_API_BASE_URL
 */
export function apiBaseUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_API_BASE_URL || process.env.API_BASE_URL || "").trim();
  if (raw === "same" || raw === "/") {
    return typeof window === "undefined" ? serverOrigin() : "";
  }
  // Explicit base always wins (split API on :3001, remote, etc.)
  if (raw) return raw.replace(/\/$/, "");

  // Browser: always same-origin. Next hosts `/api/*` via app/api/[[...path]].
  // Do NOT rewrite Codespace `*-3000.app.github.dev` → `*-3001` — that port is
  // not forwarded and causes "Failed to fetch" on Admin / markets.
  if (typeof window !== "undefined") {
    return "";
  }

  // SSR / Node: absolute origin for this deployment
  return serverOrigin();
}

/** Join API base + path; works with empty base (same-origin). */
export function apiUrl(path: string): string {
  const base = apiBaseUrl();
  const p = path.startsWith("/") ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

export async function fetchMarkets(): Promise<Market[]> {
  try {
    const response = await fetch(apiUrl("/api/markets"), { cache: "no-store" });
    if (!response.ok) return fallbackMarkets;
    return ((await response.json()) as Market[]).map(normalizeMarket);
  } catch {
    return fallbackMarkets;
  }
}

export async function fetchMarket(id: string): Promise<Market | undefined> {
  try {
    const response = await fetch(apiUrl(`/api/markets/${encodeURIComponent(id)}`), { cache: "no-store" });
    if (!response.ok) return fallbackMarkets.find((market) => market.id === id);
    return normalizeMarket((await response.json()) as Market);
  } catch {
    return fallbackMarkets.find((market) => market.id === id);
  }
}

export async function fetchTickets(): Promise<Ticket[]> {
  return [];
}

export async function fetchUserTickets(address: string): Promise<Ticket[]> {
  const response = await fetch(apiUrl(`/api/users/${encodeURIComponent(address)}/tickets`), {
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Portfolio endpoint returned HTTP ${response.status}`);
  }
  return ((await response.json()) as Ticket[]).map((ticket) => ({
    ...ticket,
    marketQuestion: ticket.marketQuestion ?? ticket.marketId
  }));
}

export async function fetchLpStats(): Promise<LpStats> {
  try {
    const response = await fetch(apiUrl("/api/lp/stats"), { cache: "no-store" });
    if (!response.ok) return emptyLpStats;
    return normalizeLpStats((await response.json()) as LpStats);
  } catch {
    return emptyLpStats;
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
    simulated: Boolean(stats.simulated)
  };
}
