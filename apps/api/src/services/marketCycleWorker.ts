/**
 * Continuous BTC + London weather market cycle:
 * - ~60s OPEN (entry) → lock → observation → resolve + settle
 * - A new OPEN market is created only after the previous one is fully RESOLVED
 *   (not while the prior round is still LOCKED / OBSERVATION — avoids UI jumps)
 * - Finished markets leave the main Markets UI; Portfolio can still claim by address
 */
import { runtimeFile } from "../runtimePaths.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createMarketOnchain,
  hideMarketOnchain,
  listOnchainMarkets,
  onchainEnabled,
  resolveReferenceMarketOnchain,
  settleMarketTicketsOnchain
} from "./onchainService.js";

/** Nominal entry window (seconds). createMarketOnchain adds tx slack + lower sniper buffer. */
const LOCK_SECONDS = 75;
const OBSERVATION_SECONDS = 60;
/** Extra pause after lock before observationStart (set in createMarketOnchain defaults). */
const STATE_PATH = () => runtimeFile("market-cycle-state.json");

type CycleState = {
  lastRunAt?: string;
  lastCreateAt?: string;
  lastResolved?: string[];
  lastCreated?: string[];
  lastErrors?: string[];
};

let running = false;

export async function runMarketCycleOnce(): Promise<{
  ok: boolean;
  skipped?: string;
  resolved: string[];
  settled: string[];
  hidden: string[];
  created: string[];
  errors: string[];
}> {
  if (running) {
    return { ok: true, skipped: "already-running", resolved: [], settled: [], hidden: [], created: [], errors: [] };
  }
  running = true;

  const resolved: string[] = [];
  const settled: string[] = [];
  const hidden: string[] = [];
  const created: string[] = [];
  const errors: string[] = [];

  try {
    if (!onchainEnabled()) {
      return { ok: false, skipped: "onchain-disabled", resolved, settled, hidden, created, errors: ["onchain disabled"] };
    }
    if (!hasResolverKey()) {
      return {
        ok: false,
        skipped: "missing-oracle-key",
        resolved,
        settled,
        hidden,
        created,
        errors: ["Set ORACLE_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY / PRIVATE_KEY) on Vercel"]
      };
    }

    const markets = await listOnchainMarkets({ forCycle: true });
    const now = Date.now();

    // 1) Resolve + settle ready BTC / weather
    for (const market of markets) {
      if (!isReferenceRole(market.demoRole, market.category, market.question)) continue;
      if (!isResolvableStatus(market.status)) continue;
      if (!isReadyToResolve(market, now)) continue;
      // Resolve compares obs-start vs obs-end feed prints — no $ threshold required in the title.

      try {
        console.log(`[market-cycle] resolving ${market.demoRole ?? market.category} ${market.id}`);
        const result = await resolveReferenceMarketOnchain(market.id);
        if (result && "error" in result && result.error) {
          errors.push(`${market.id}: ${result.error}`);
          continue;
        }
        resolved.push(market.id);
        try {
          const settle = await settleMarketTicketsOnchain(market.id);
          if (settle && "settledCount" in settle) {
            settled.push(market.id);
            console.log(`[market-cycle] settled ${settle.settledCount ?? 0} ticket(s) on ${market.id}`);
          }
        } catch (settleError) {
          errors.push(
            `${market.id} settle: ${settleError instanceof Error ? settleError.message : String(settleError)}`
          );
        }
      } catch (error) {
        errors.push(`${market.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 2) Ensure an OPEN market for BTC and weather ONLY when no active round exists.
    //    Active = OPEN | LOCKED | OBSERVATION. Do not spawn a new market until the
    //    previous one is fully RESOLVED (or cancelled/hidden) — prevents list jumps.
    const live = await listOnchainMarkets({ forCycle: true });
    const hasActiveBtc = live.some(
      (m) =>
        isReferenceBtc(m.demoRole, m.category, m.question) && isActiveRoundStatus(m.status)
    );
    const hasActiveWeather = live.some(
      (m) =>
        isReferenceWeather(m.demoRole, m.category, m.question) && isActiveRoundStatus(m.status)
    );

    if (!hasActiveBtc) {
      try {
        const result = await createMarketOnchain({
          demoRole: "btc_price",
          // Fair mid estimated from feed inside createMarketOnchain when omitted.
          lockSeconds: LOCK_SECONDS,
          observationSeconds: OBSERVATION_SECONDS
        });
        if ("error" in result && result.error) {
          errors.push(`create btc: ${result.error}`);
        } else if ("marketAddress" in result && result.marketAddress) {
          created.push(String(result.marketAddress));
          console.log(`[market-cycle] created BTC ${result.marketAddress}`);
        }
      } catch (error) {
        errors.push(`create btc: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!hasActiveWeather) {
      try {
        const result = await createMarketOnchain({
          demoRole: "london_weather",
          lockSeconds: LOCK_SECONDS,
          observationSeconds: OBSERVATION_SECONDS
        });
        if ("error" in result && result.error) {
          errors.push(`create weather: ${result.error}`);
        } else if ("marketAddress" in result && result.marketAddress) {
          created.push(String(result.marketAddress));
          console.log(`[market-cycle] created weather ${result.marketAddress}`);
        }
      } catch (error) {
        errors.push(`create weather: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 3) Hide finished reference markets + legacy demo ("next demo signal GREEN") from browse UI.
    //    Public list is BTC + weather only (see listOnchainMarkets).
    //    Claim still works: Portfolio loads tickets by address; getMarket accepts raw 0x ids.
    const refreshed = await listOnchainMarkets({ forCycle: true });

    for (const market of refreshed) {
      const isLegacyDemo =
        !isReferenceRole(market.demoRole, market.category, market.question) &&
        (market.demoRole === "open" ||
          market.demoRole === "legacy" ||
          market.id === "mkt_demo_green" ||
          /demo signal be GREEN/i.test(market.question || ""));

      const finishedReference =
        isReferenceRole(market.demoRole, market.category, market.question) &&
        (market.status === "RESOLVED" || market.status === "CANCELLED");

      if (!isLegacyDemo && !finishedReference) continue;

      try {
        await hideMarketOnchain(market.id);
        hidden.push(market.id);
      } catch (error) {
        errors.push(`hide ${market.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    saveCycleState({
      lastRunAt: new Date().toISOString(),
      lastCreateAt: created.length ? new Date().toISOString() : readCycleState().lastCreateAt,
      lastResolved: resolved,
      lastCreated: created,
      lastErrors: errors.slice(0, 12)
    });

    return { ok: errors.length === 0, resolved, settled, hidden, created, errors };
  } finally {
    running = false;
  }
}

export function getMarketCycleStatus() {
  return {
    ...readCycleState(),
    lockSeconds: LOCK_SECONDS,
    observationSeconds: OBSERVATION_SECONDS,
    hasResolverKey: hasResolverKey(),
    onchain: onchainEnabled(),
    note: "New OPEN BTC/weather only after previous fully RESOLVED. Markets UI shows 1 BTC + 1 weather; claim via Portfolio."
  };
}

function hasResolverKey(): boolean {
  return Boolean(
    process.env.ORACLE_PRIVATE_KEY ||
      process.env.DEPLOYER_PRIVATE_KEY ||
      process.env.ARC_DEPLOYER_PRIVATE_KEY ||
      process.env.PRIVATE_KEY
  );
}

/**
 * Opportunistic 24/7 driver for serverless deploys.
 *
 * Vercel Hobby cron is ~daily, so the cycle is otherwise driven by an external
 * pinger. This hook also runs the cycle in the background on site traffic
 * (chart polls /api/demo-data every second), throttled across instances via
 * durable KV so concurrent requests do not stampede. Zero-traffic periods still
 * need the external pinger — serverless cannot wake itself.
 */
const KICK_MIN_INTERVAL_MS = 50_000;
let localLastKickAt = 0;

export async function maybeRunMarketCycleInBackground(): Promise<void> {
  if (!onchainEnabled() || !hasResolverKey()) return;
  if (process.env.MARKET_CYCLE_ON_TRAFFIC === "0") return;

  const now = Date.now();
  // Cheap per-instance gate first (no KV round-trip on every 1s poll).
  if (now - localLastKickAt < KICK_MIN_INTERVAL_MS) return;
  localLastKickAt = now;

  try {
    const { NamespaceStore } = await import("./persistentStore.js");
    const store = new NamespaceStore<{ at: number }>("market-cycle-kick");
    const last = await store.get("lastKickAt");
    if (last && now - last.at < KICK_MIN_INTERVAL_MS) return;
    await store.set("lastKickAt", { at: now });
  } catch {
    // KV unavailable — fall through with the per-instance gate only.
  }

  try {
    const result = await runMarketCycleOnce();
    if (result.created.length || result.resolved.length) {
      console.log(
        `[market-cycle:on-traffic] created=${result.created.length} resolved=${result.resolved.length}`
      );
    }
  } catch (error) {
    console.error("[market-cycle:on-traffic]", error);
  }
}

function isReferenceRole(role?: string, category?: string, question?: string): boolean {
  return isReferenceBtc(role, category, question) || isReferenceWeather(role, category, question);
}

function isReferenceBtc(role?: string, category?: string, question?: string): boolean {
  if (role === "btc_price" || category === "crypto-candle") return true;
  const q = (question || "").toLowerCase();
  return /\bbtc\b/.test(q) || q.includes("bitcoin");
}

function isReferenceWeather(role?: string, category?: string, question?: string): boolean {
  if (role === "london_weather" || category === "weather") return true;
  const q = (question || "").toLowerCase();
  return q.includes("london") || q.includes("weather") || q.includes("temp");
}

function isResolvableStatus(status: string): boolean {
  return status === "OPEN" || status === "LOCKED" || status === "OBSERVATION";
}

/** Round still in flight — blocks creating a replacement market. */
function isActiveRoundStatus(status: string): boolean {
  return status === "OPEN" || status === "LOCKED" || status === "OBSERVATION" || status === "CREATED";
}

function isReadyToResolve(
  market: { observationEnd?: string; lockTime?: string },
  now: number
): boolean {
  const observationEnd = Date.parse(market.observationEnd || "");
  const lockTime = Date.parse(market.lockTime || "");
  const readyAt = Number.isFinite(observationEnd)
    ? observationEnd
    : Number.isFinite(lockTime)
      ? lockTime + OBSERVATION_SECONDS * 1000
      : Number.NaN;
  return Number.isFinite(readyAt) && now >= readyAt;
}

function readCycleState(): CycleState {
  try {
    if (!existsSync(STATE_PATH())) return {};
    return JSON.parse(readFileSync(STATE_PATH(), "utf8")) as CycleState;
  } catch {
    return {};
  }
}

function saveCycleState(state: CycleState): void {
  try {
    const path = STATE_PATH();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // non-fatal on serverless
  }
}
