import type { LpStats, Market, Ticket } from "./types";
import { emptyLpStats } from "./sampleData";

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
 * - Override with NEXT_PUBLIC_API_BASE_URL (leave empty on Vercel)
 *
 * Common misconfigs that used to 404 the chart (`/api/api/demo-data`):
 * - base ending in `/api`
 * - base = `same` / `/` / empty-ish
 * - localhost base baked into a Production browser build
 */
function normalizeApiBase(raw: string): string {
  let b = raw.trim().replace(/\/$/, "");
  if (!b || b === "same" || b === "/" || b === "undefined" || b === "null") return "";
  // Production browser must not call a local API process.
  if (typeof window !== "undefined" && /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?/i.test(b)) {
    return "";
  }
  // If someone set base to `…/api`, strip it so `/api/demo-data` does not become `/api/api/…`.
  if (b === "/api" || b === "api") return "";
  if (b.endsWith("/api")) b = b.slice(0, -4).replace(/\/$/, "");
  return b;
}

export function apiBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_API_BASE_URL || process.env.API_BASE_URL || "";
  const normalized = normalizeApiBase(raw);
  if (normalized) return normalized;

  // Browser: always same-origin. Next hosts `/api/*` via app/api/[[...path]].
  if (typeof window !== "undefined") {
    return "";
  }

  // SSR / Node: absolute origin for this deployment
  return serverOrigin();
}

/** Join API base + path; works with empty base (same-origin). */
export function apiUrl(path: string): string {
  const base = apiBaseUrl();
  let p = path.startsWith("/") ? path : `/${path}`;
  // Guard against accidental double /api when base already ends with it.
  if (base.endsWith("/api") && p.startsWith("/api/")) {
    p = p.slice(4);
  }
  return base ? `${base}${p}` : p;
}

/** Fetch /api/demo-data with same-origin fallback (chart + reference panel). */
export async function fetchDemoReferenceData(): Promise<unknown> {
  const candidates = Array.from(new Set([apiUrl("/api/demo-data"), "/api/demo-data"].filter(Boolean)));
  let lastStatus = 0;
  let lastError: unknown;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      lastStatus = res.status;
      if (!res.ok) continue;
      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }
  if (lastStatus) throw new Error(`HTTP ${lastStatus}`);
  throw lastError instanceof Error ? lastError : new Error("Feed unreachable");
}

/** Real Arc markets use 0x addresses. Offline sample ids (mkt_*) must never reach buyTicket. */
export function isOnchainMarketId(id: string | undefined | null): boolean {
  return Boolean(id && /^0x[a-fA-F0-9]{40}$/.test(id.trim()));
}

export async function fetchMarkets(): Promise<Market[]> {
  try {
    const response = await fetch(apiUrl("/api/markets"), { cache: "no-store" });
    if (!response.ok) return [];
    const markets = ((await response.json()) as Market[]).map(normalizeMarket);
    // Prefer live chain markets only — never substitute offline placeholders that look bettable.
    const onchain = markets.filter((m) => isOnchainMarketId(m.id) || isOnchainMarketId(m.contractAddress));
    return onchain;
  } catch {
    return [];
  }
}

export async function fetchMarket(id: string): Promise<Market | undefined> {
  // Offline sample ids are not contracts — refuse so MetaMask never sees mkt_btc_offline.
  if (!isOnchainMarketId(id)) {
    return undefined;
  }
  try {
    const response = await fetch(apiUrl(`/api/markets/${encodeURIComponent(id)}`), { cache: "no-store" });
    if (!response.ok) return undefined;
    const market = normalizeMarket((await response.json()) as Market);
    if (!isOnchainMarketId(market.id) && !isOnchainMarketId(market.contractAddress)) return undefined;
    return market;
  } catch {
    return undefined;
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
