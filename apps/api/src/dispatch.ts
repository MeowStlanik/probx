import { loadRootEnv } from "./services/loadEnv.js";
loadRootEnv();

import { isAdminAuthorized } from "./services/adminAuth.js";
import { cronThrottled } from "./services/cronThrottle.js";
import { contractAddresses } from "./services/contractService.js";
import { resolveExpiredDemoMarkets } from "./services/resolverWorker.js";
import {
  buyDemoTicket,
  createDemoMarket,
  demoReferenceData,
  ensureTourBtcMarket,
  getMarket,
  getMarketQuote,
  hideDemoMarket,
  listMarkets,
  resetDemoMarkets
} from "./routes/markets.js";
import { lpStats } from "./routes/lp.js";
import { cancelMarket, resolveMarket, resolveReferenceMarket, simulateEvent } from "./routes/oracle.js";
import { settleMarketTickets, ticketsForUser } from "./routes/tickets.js";
import { recordTicketOpening } from "./services/onchainService.js";
import { handleWalletGet, handleWalletPost } from "./routes/wallet.js";
import { reconcilePending } from "./services/txTrackerService.js";
import { runAutoResolveOnce } from "./services/autoResolveWorker.js";
import { getMarketCycleStatus, runMarketCycleOnce } from "./services/marketCycleWorker.js";

export type DispatchResult = { status: number; body: unknown };

export async function dispatchApiRequest(input: {
  method: string;
  path: string;
  searchParams?: URLSearchParams;
  body?: Record<string, unknown>;
  /** Selected request headers (lowercased keys): x-session-*, authorization. */
  headers?: Record<string, string | undefined>;
}): Promise<DispatchResult> {
  const method = input.method.toUpperCase();
  const path = normalizePath(input.path);
  const searchParams = input.searchParams ?? new URLSearchParams();
  const body = input.body ?? {};
  const headers = input.headers ?? {};

  try {
    resolveExpiredDemoMarkets((await import("./db/client.js")).db);

    if (method === "GET" && (path === "/health" || path === "/api/health")) {
      return { status: 200, body: { ok: true } };
    }
    if (method === "GET" && path === "/api/contracts") {
      return { status: 200, body: contractAddresses() };
    }
    if (method === "GET" && path === "/api/markets") {
      return { status: 200, body: await listMarkets() };
    }
    if (method === "GET" && path === "/api/demo-data") {
      return { status: 200, body: await demoReferenceData() };
    }
    if (method === "GET" && path === "/api/lp/stats") {
      return { status: 200, body: await lpStats() };
    }
    if (method === "GET" && path === "/api/activity") {
      const { listOpenings } = await import("./services/ticketOpenings.js");
      const openings = listOpenings()
        .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt))
        .slice(0, 24);
      return { status: 200, body: { openings, count: openings.length } };
    }

    // Product tour: silently ensure an OPEN BTC market (reuse or create). Throttled.
    if (method === "POST" && path === "/api/tour/ensure-market") {
      if (cronThrottled("tour-ensure-market")) {
        // Still return an existing OPEN BTC if present so the tour can continue.
        const markets = await listMarkets();
        const openBtc = markets.find(
          (m) =>
            m.status === "OPEN" &&
            (m.demoRole === "btc_price" || m.category === "crypto-candle" || /BTC/i.test(m.question))
        );
        return {
          status: 200,
          body: {
            marketId: openBtc?.id ?? null,
            created: false,
            throttled: true,
            status: openBtc?.status
          }
        };
      }
      const ensured = await ensureTourBtcMarket();
      return { status: ensured.error && !ensured.marketId ? 503 : 200, body: ensured };
    }

    if (method === "GET" && path === "/api/cron/auto-resolve") {
      // When CRON_SECRET is set, require it (external pinger / Vercel cron).
      // Without secret configured (local dev): allow but throttle gas-spam.
      const cronAuth = authorizeCron(searchParams, headers);
      if (cronAuth === "deny") return cronDenied();
      if (cronAuth === "anonymous" && cronThrottled("auto-resolve")) {
        return { status: 200, body: { ok: true, skipped: "throttled" } };
      }
      // Prefer full market cycle (resolve + create BTC/weather) when key is present.
      try {
        const cycle = await runMarketCycleOnce();
        return { status: 200, body: { mode: "market-cycle", ...cycle } };
      } catch {
        const result = await runAutoResolveOnce();
        return { status: 200, body: { ok: true, mode: "auto-resolve", ...result } };
      }
    }

    if (method === "GET" && path === "/api/cron/market-cycle") {
      // Client heartbeat calls this without secret while a tab is open (throttled).
      // External pingers should pass CRON_SECRET to bypass throttle.
      // Unlike auto-resolve, anonymous is always allowed here (demo UX).
      const authed = authorizeCron(searchParams, headers) === "ok";
      if (!authed && cronThrottled("market-cycle")) {
        return { status: 200, body: { ok: true, skipped: "throttled", cycleStatus: getMarketCycleStatus() } };
      }
      const cycle = await runMarketCycleOnce();
      // Opportunistically settle any pending user tx (buy/claim/deposit/transfer).
      const txReconcile = await reconcilePending().catch(() => ({ checked: 0, settled: 0 }));
      return { status: 200, body: { ...cycle, txReconcile, cycleStatus: getMarketCycleStatus() } };
    }

    if (method === "GET" && path === "/api/cron/market-cycle/status") {
      return { status: 200, body: getMarketCycleStatus() };
    }

    if (method === "GET") {
      const resolved = await handleWalletGet(path, searchParams, headers);
      if (resolved) {
        return { status: resolved.status, body: resolved.body };
      }
    }

    const marketMatch = path.match(/^\/api\/markets\/([^/]+)$/);
    if (method === "GET" && marketMatch) {
      const market = await getMarket(marketMatch[1]);
      return market
        ? { status: 200, body: market }
        : { status: 404, body: { error: "not found" } };
    }

    const quoteMatch = path.match(/^\/api\/markets\/([^/]+)\/quote$/);
    if (method === "GET" && quoteMatch) {
      const quote = await getMarketQuote(
        quoteMatch[1],
        searchParams,
        searchParams.get("user") ?? undefined
      );
      return quote
        ? { status: 200, body: quote }
        : { status: 404, body: { error: "not found" } };
    }

    const ticketMatch = path.match(/^\/api\/users\/([^/]+)\/tickets$/);
    if (method === "GET" && ticketMatch) {
      return { status: 200, body: await ticketsForUser(ticketMatch[1]) };
    }

    if (method === "POST" && path === "/api/markets/create-demo") {
      if (!isAdminAuthorized({ searchParams, body })) return adminDenied();
      return { status: 201, body: await createDemoMarket(body) };
    }
    if (method === "POST" && path === "/api/markets/hide") {
      if (!isAdminAuthorized({ searchParams, body })) return adminDenied();
      const result = await hideDemoMarket(String(body.marketId ?? ""));
      return result
        ? { status: 200, body: result }
        : { status: 404, body: { error: "not found" } };
    }
    if (method === "POST" && path === "/api/markets/reset-demo") {
      if (!isAdminAuthorized({ searchParams, body })) return adminDenied();
      return { status: 201, body: await resetDemoMarkets() };
    }
    if (method === "POST" && path === "/api/tickets/buy-demo") {
      return { status: 201, body: await buyDemoTicket(body) };
    }
    if (method === "POST" && path === "/api/tickets/settle-market") {
      if (!isAdminAuthorized({ searchParams, body })) return adminDenied();
      const result = await settleMarketTickets(String(body.marketId ?? ""));
      return result
        ? { status: 200, body: result }
        : { status: 404, body: { error: "not found" } };
    }
    if (method === "POST" && path === "/api/tickets/open-meta") {
      return { status: 201, body: await recordTicketOpening(body) };
    }
    if (method === "POST" && path === "/api/oracle/simulate-event") {
      if (!isAdminAuthorized({ searchParams, body })) return adminDenied();
      const event = simulateEvent(String(body.marketId ?? ""));
      return event
        ? { status: 201, body: event }
        : { status: 404, body: { error: "not found" } };
    }
    if (method === "POST" && path === "/api/oracle/resolve") {
      if (!isAdminAuthorized({ searchParams, body })) return adminDenied();
      const outcome = normalizeOutcome(body.outcome);
      if (body.outcome !== undefined && !outcome) {
        return { status: 400, body: { error: "outcome must be \"YES\" or \"NO\"" } };
      }
      const result = await resolveMarket(String(body.marketId ?? ""), outcome);
      return result
        ? { status: 200, body: result }
        : { status: 404, body: { error: "not found" } };
    }
    if (method === "POST" && path === "/api/oracle/resolve-reference") {
      if (!isAdminAuthorized({ searchParams, body })) return adminDenied();
      const result = await resolveReferenceMarket(String(body.marketId ?? ""));
      return result
        ? { status: 200, body: result }
        : { status: 404, body: { error: "not found" } };
    }
    if (method === "POST" && path === "/api/oracle/cancel") {
      if (!isAdminAuthorized({ searchParams, body })) return adminDenied();
      const result = await cancelMarket(
        String(body.marketId ?? ""),
        String(body.reason ?? "demo oracle unavailable")
      );
      return result
        ? { status: 200, body: result }
        : { status: 404, body: { error: "not found" } };
    }
    if (method === "POST" && path === "/api/cron/auto-resolve") {
      const cronAuth = authorizeCron(searchParams, headers);
      if (cronAuth === "deny") return cronDenied();
      if (cronAuth === "anonymous" && cronThrottled("auto-resolve")) {
        return { status: 200, body: { ok: true, skipped: "throttled" } };
      }
      try {
        const cycle = await runMarketCycleOnce();
        return { status: 200, body: { mode: "market-cycle", ...cycle } };
      } catch {
        const result = await runAutoResolveOnce();
        return { status: 200, body: { ok: true, mode: "auto-resolve", ...result } };
      }
    }

    if (method === "POST" && path === "/api/cron/market-cycle") {
      const authed = authorizeCron(searchParams, headers) === "ok";
      if (!authed && cronThrottled("market-cycle")) {
        return { status: 200, body: { ok: true, skipped: "throttled", cycleStatus: getMarketCycleStatus() } };
      }
      const cycle = await runMarketCycleOnce();
      return { status: 200, body: { ...cycle, cycleStatus: getMarketCycleStatus() } };
    }

    if (method === "POST") {
      const walletPost = await handleWalletPost(path, body);
      if (walletPost) return { status: walletPost.status, body: walletPost.body };
    }

    return { status: 404, body: { error: "not found" } };
  } catch (error) {
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : "unknown error" }
    };
  }
}

function adminDenied(): DispatchResult {
  return {
    status: 401,
    body: {
      error:
        "Admin authorization required. The server has ADMIN_SECRET set — enter the same secret on the Admin page and retry."
    }
  };
}

/**
 * Cron auth:
 * - no CRON_SECRET configured → "anonymous" (dev; still throttled by caller)
 * - secret configured + correct proof → "ok"
 * - secret configured + missing/wrong proof → "deny" (401)
 *
 * Proof: ?secret= / ?cron_secret= or `Authorization: Bearer <secret>`
 * (Vercel Cron sends Bearer when CRON_SECRET / VERCEL_CRON_SECRET is set).
 */
function authorizeCron(
  searchParams: URLSearchParams,
  headers: Record<string, string | undefined>
): "ok" | "anonymous" | "deny" {
  const expected = (process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET || "").trim();
  if (!expected) return "anonymous";
  if (cronSecretMatches(expected, searchParams, headers)) return "ok";
  return "deny";
}

function cronSecretMatches(
  expected: string,
  searchParams: URLSearchParams,
  headers: Record<string, string | undefined>
): boolean {
  const fromQuery = searchParams.get("secret") || searchParams.get("cron_secret");
  if (fromQuery === expected) return true;
  const auth = (headers.authorization ?? "").trim();
  return auth === `Bearer ${expected}`;
}

/** @deprecated use authorizeCron — kept for any external imports */
function cronSecretProvided(
  searchParams: URLSearchParams,
  headers: Record<string, string | undefined>
): boolean {
  return authorizeCron(searchParams, headers) === "ok";
}

function cronDenied() {
  return {
    status: 401,
    body: {
      error:
        "Cron authorization required. Set CRON_SECRET on the server and pass ?secret=… or Authorization: Bearer …"
    }
  };
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

function normalizeOutcome(value: unknown): "YES" | "NO" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  if (normalized === "YES") return "YES";
  if (normalized === "NO") return "NO";
  return undefined;
}
