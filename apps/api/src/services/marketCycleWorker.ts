/**
 * Continuous BTC + London weather market cycle:
 * - ~60s OPEN (entry) → lock → observation → resolve + settle
 * - A new OPEN market is created only after the previous one is fully RESOLVED
 *   (not while the prior round is still LOCKED / OBSERVATION — avoids UI jumps)
 * - Finished markets leave the main Markets UI; Portfolio can still claim by address
 */
import { randomBytes } from "node:crypto";
import { runtimeFile } from "../runtimePaths.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  cancelMarketOnchain,
  captureObservationSnapshots,
  createMarketOnchain,
  hideMarketOnchain,
  isMarketHiddenFromUi,
  listOnchainMarkets,
  onchainEnabled,
  resolveReferenceMarketOnchain,
  saveAggregateStatsFromMarkets,
  settleMarketTicketsOnchain
} from "./onchainService.js";
import { acquireLock, NamespaceStore, releaseLock } from "./persistentStore.js";
import { BTC_OBSERVATION_MS, WEATHER_OBSERVATION_MS } from "./observationSnapshots.js";
import { withMarketCreateLock } from "./marketCreateLock.js";

/** Persist settlement cursor across worker runs (100+ tickets). */
const settleCursorStore = new NamespaceStore<{
  cursor: number;
  updatedAt: string;
  /** Terminal marker — skip re-scanning fully settled markets every cycle. */
  done?: boolean;
}>("settle-cursors-v1");

/** Pure helper for tests + continue-settle skip logic. */
export function isSettleCursorDone(
  state: { done?: boolean } | null | undefined
): boolean {
  return Boolean(state?.done);
}

const SETTLE_CHUNK = 12;
/** Max chunks per worker pass to keep each cycle bounded. */
const SETTLE_MAX_CHUNKS_PER_RUN = 4;

async function settleAllTicketsChunked(
  marketId: string
): Promise<{ settledCount: number; done: boolean; nextCursor?: number; skipped?: boolean }> {
  const key = marketId.trim().toLowerCase();
  const existing = await settleCursorStore.get(key);
  // Fully settled markets keep a durable done marker so continue-settle does not
  // re-walk every ticket via RPC on every cycle (linear cost growth).
  if (existing?.done) {
    return { settledCount: 0, done: true, skipped: true };
  }
  let cursor = existing?.cursor ?? 0;
  let settledCount = 0;
  let done = false;
  let nextCursor: number | undefined = cursor;

  for (let chunk = 0; chunk < SETTLE_MAX_CHUNKS_PER_RUN; chunk++) {
    const result = await settleMarketTicketsOnchain(marketId, {
      cursor,
      limit: SETTLE_CHUNK
    });
    if (!result || "error" in result) {
      if (result && "error" in result) throw new Error(String(result.error));
      break;
    }
    settledCount += result.settledCount ?? 0;
    // Trust only the engine-backed `done` flag. Reaching the end of the log list is
    // not the same as having nothing left to settle: a reverted settle leaves an open
    // ticket holding LP reserve, and writing the terminal marker here would strand it.
    if (result.done) {
      done = true;
      await settleCursorStore
        .set(key, { cursor: 0, updatedAt: new Date().toISOString(), done: true })
        .catch(() => undefined);
      nextCursor = undefined;
      break;
    }
    if (result.nextCursor === undefined) {
      // Walked the whole list but exposure remains (or we could not confirm).
      // Restart from the beginning next cycle rather than declaring completion.
      nextCursor = 0;
      await settleCursorStore.set(key, { cursor: 0, updatedAt: new Date().toISOString() });
      break;
    }
    if (result.nextCursor === cursor) {
      // Cursor parked on a ticket that keeps failing — stop burning the run on it
      // and let the next cycle retry, so healthy markets still get their turn.
      nextCursor = cursor;
      await settleCursorStore.set(key, { cursor, updatedAt: new Date().toISOString() });
      break;
    }
    cursor = result.nextCursor;
    nextCursor = cursor;
    await settleCursorStore.set(key, { cursor, updatedAt: new Date().toISOString() });
  }

  return { settledCount, done, nextCursor };
}

/** Nominal entry window (seconds). createMarketOnchain adds tx slack + lower sniper buffer. */
const LOCK_SECONDS = 75;
/**
 * Windows come from observationSnapshots so raw-tick retention stays derived from
 * the same numbers. BTC is a short loop for demo UX; weather spans two Open-Meteo
 * 15-minute intervals so start and end land in different provider prints (a single
 * interval often yields end === start → permanent NO).
 */
const OBSERVATION_SECONDS_BTC = BTC_OBSERVATION_MS / 1000;
const OBSERVATION_SECONDS_WEATHER = WEATHER_OBSERVATION_MS / 1000;
/** Extra pause after lock before observationStart (set in createMarketOnchain defaults). */
const STATE_PATH = () => runtimeFile("market-cycle-state.json");

type CycleState = {
  lastRunAt?: string;
  lastCreateAt?: string;
  lastResolved?: string[];
  lastCreated?: string[];
  lastErrors?: string[];
  lastActiveBlockers?: {
    btc: string[];
    weather: string[];
  };
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
  const lockToken = randomBytes(8).toString("hex");
  const gotLock = await acquireLock("market-cycle", 90_000, lockToken);
  if (!gotLock) {
    running = false;
    return {
      ok: true,
      skipped: "distributed-lock",
      resolved: [],
      settled: [],
      hidden: [],
      created: [],
      errors: []
    };
  }

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
        errors: ["Set ORACLE_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY / PRIVATE_KEY) in Railway"]
      };
    }

    const markets = await listOnchainMarkets({ forCycle: true });
    const now = Date.now();

    // 0) Dedicated oracle-snapshot worker normally owns feed capture. Only use the
    // cycle as a fallback when that worker is explicitly disabled.
    if (process.env.ORACLE_SNAPSHOT_ENABLED === "0") {
      try {
        await captureObservationSnapshots();
      } catch (error) {
        errors.push(
          `observation snapshots: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // 1) Resolve + settle ready BTC / weather
    for (const market of markets) {
      if (!isReferenceRole(market.demoRole, market.category, market.question)) continue;
      if (!isResolvableStatus(market.status)) continue;
      if (!isReadyToResolve(market, now)) continue;
      // Resolve compares obs-start vs obs-end feed prints — no $ threshold required in the title.

      try {
        console.log(`[market-cycle] resolving ${market.demoRole ?? market.category} ${market.id}`);
        const result = await resolveReferenceMarketOnchain(market.id);
        if (result && "deferred" in result && result.deferred) {
          // Snapshot grace — try again next cycle; do not cancel yet.
          continue;
        }
        // Cancelled for missing snapshots: still settle so LP reservedAssets release.
        if (result && "cancelled" in result && result.cancelled) {
          try {
            const settle = await settleAllTicketsChunked(market.id);
            if (settle.settledCount > 0 || settle.done) {
              settled.push(market.id);
              console.log(
                `[market-cycle] cancelled ${market.id} → settled ${settle.settledCount} ticket(s)${settle.done ? "" : " (more pending)"}`
              );
            }
          } catch (settleError) {
            errors.push(
              `${market.id} cancel-settle: ${settleError instanceof Error ? settleError.message : String(settleError)}`
            );
          }
          if (result && "error" in result && result.error) {
            errors.push(`${market.id}: ${result.error}`);
          }
          continue;
        }
        if (result && "error" in result && result.error) {
          errors.push(`${market.id}: ${result.error}`);
          continue;
        }
        resolved.push(market.id);
        try {
          const settle = await settleAllTicketsChunked(market.id);
          if (settle.settledCount > 0 || settle.done) {
            settled.push(market.id);
            console.log(
              `[market-cycle] settled ${settle.settledCount} ticket(s) on ${market.id}${settle.done ? "" : " (more pending)"}`
            );
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

    // 1b) Continue chunked settlement for already-final markets (prior run may have timed out).
    // Markets with settle-cursor done=true are skipped (no full ticket re-scan).
    for (const market of markets) {
      if (!isReferenceRole(market.demoRole, market.category, market.question)) continue;
      const st = String(market.status || "").toUpperCase();
      if (st !== "RESOLVED" && st !== "CANCELLED") continue;
      try {
        const settle = await settleAllTicketsChunked(market.id);
        if (settle.skipped) continue;
        if (settle.settledCount > 0 || (settle.done && settle.settledCount === 0)) {
          if (settle.settledCount > 0) {
            settled.push(market.id);
            console.log(
              `[market-cycle] continue-settle ${market.id} → ${settle.settledCount} ticket(s)${settle.done ? "" : " (more pending)"}`
            );
          }
        }
      } catch (settleError) {
        errors.push(
          `${market.id} continue-settle: ${settleError instanceof Error ? settleError.message : String(settleError)}`
        );
      }
    }

    // 2) Ensure an OPEN market for BTC and weather ONLY when no active round exists.
    //    Active = OPEN | LOCKED | OBSERVATION, plus CREATED while it can still be opened
    //    (see isActiveRoundStatus). Do not spawn a new market until the previous one is
    //    fully RESOLVED (or cancelled/hidden) — prevents list jumps.
    const live = await listOnchainMarkets({ forCycle: true });

    // 1b) Cancel rounds stuck in CREATED (create() landed, open() did not). They can no
    //     longer be opened or resolved, so without this they block their role forever.
    for (const market of live) {
      if (!isReferenceRole(market.demoRole, market.category, market.question)) continue;
      if (!isStrandedCreated(market, now)) continue;
      try {
        console.log(`[market-cycle] cancelling stranded CREATED ${market.id}`);
        await cancelMarketOnchain(market.id, "never opened: open() did not land before lockTime");
        hidden.push(String(market.id));
      } catch (cancelError) {
        errors.push(
          `${market.id} cancel-stranded: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`
        );
      }
    }

    // Hidden rounds must never block the public replacement round. This matters after
    // reset/migration flows: a previously hidden BTC can remain LOCKED in the shared
    // five-minute RPC cache even though /api/markets correctly hides it. Counting that
    // stale hidden round here leaves the desk with weather only and prevents a new BTC.
    const visibleLive = live.filter(
      (m) => !isMarketHiddenFromUi(String(m.contractAddress || m.id))
    );
    const activeBtcBlockers = visibleLive.filter(
      (m) =>
        isReferenceBtc(m.demoRole, m.category, m.question) && isActiveRoundStatus(m.status, m, now)
    );
    const activeWeatherBlockers = visibleLive.filter(
      (m) =>
        isReferenceWeather(m.demoRole, m.category, m.question) && isActiveRoundStatus(m.status, m, now)
    );
    const hasActiveBtc = activeBtcBlockers.length > 0;
    const hasActiveWeather = activeWeatherBlockers.length > 0;

    if (!hasActiveBtc) {
      try {
        await withMarketCreateLock("btc", async () => {
          // Re-check under the same lock tour uses (market-create:btc).
          const again = await listOnchainMarkets({ forCycle: true });
          const stillMissing = !again.some(
            (m) =>
              !isMarketHiddenFromUi(String(m.contractAddress || m.id)) &&
              isReferenceBtc(m.demoRole, m.category, m.question) &&
              isActiveRoundStatus(m.status, m, Date.now())
          );
          if (!stillMissing) return;
          const result = await createMarketOnchain({
            demoRole: "btc_price",
            lockSeconds: LOCK_SECONDS,
            observationSeconds: OBSERVATION_SECONDS_BTC
          });
          if ("error" in result && result.error) {
            errors.push(`create btc: ${result.error}`);
          } else if ("marketAddress" in result && result.marketAddress) {
            created.push(String(result.marketAddress));
            console.log(`[market-cycle] created BTC ${result.marketAddress}`);
          }
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("lock busy")) {
          errors.push(`create btc: ${msg}`);
        }
      }
    }

    if (!hasActiveWeather) {
      try {
        await withMarketCreateLock("weather", async () => {
          const again = await listOnchainMarkets({ forCycle: true });
          const stillMissing = !again.some(
            (m) =>
              !isMarketHiddenFromUi(String(m.contractAddress || m.id)) &&
              isReferenceWeather(m.demoRole, m.category, m.question) &&
              isActiveRoundStatus(m.status, m, Date.now())
          );
          if (!stillMissing) return;
          const result = await createMarketOnchain({
            demoRole: "london_weather",
            lockSeconds: LOCK_SECONDS,
            observationSeconds: OBSERVATION_SECONDS_WEATHER
          });
          if ("error" in result && result.error) {
            errors.push(`create weather: ${result.error}`);
          } else if ("marketAddress" in result && result.marketAddress) {
            created.push(String(result.marketAddress));
            console.log(`[market-cycle] created weather ${result.marketAddress}`);
          }
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("lock busy")) {
          errors.push(`create weather: ${msg}`);
        }
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
      lastErrors: errors.slice(0, 12),
      lastActiveBlockers: {
        btc: activeBtcBlockers.map((m) => String(m.contractAddress || m.id)),
        weather: activeWeatherBlockers.map((m) => String(m.contractAddress || m.id))
      }
    });

    // Update aggregate stats from markets we already fetched (no duplicate RPC).
    // Await the KV write so cycle state is durable before the run completes.
    try {
      await saveAggregateStatsFromMarkets(refreshed);
    } catch (error) {
      errors.push(
        `aggregate stats: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return { ok: errors.length === 0, resolved, settled, hidden, created, errors };
  } finally {
    running = false;
    await releaseLock("market-cycle", lockToken).catch(() => undefined);
  }
}

export function getMarketCycleStatus() {
  return {
    ...readCycleState(),
    lockSeconds: LOCK_SECONDS,
    observationSecondsBtc: OBSERVATION_SECONDS_BTC,
    observationSecondsWeather: OBSERVATION_SECONDS_WEATHER,
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
function isActiveRoundStatus(
  status: string,
  market?: { lockTime?: string },
  now: number = Date.now()
): boolean {
  if (status === "OPEN" || status === "LOCKED" || status === "OBSERVATION") return true;
  // CREATED means createMarket() landed but the follow-up open() did not. That market
  // is only a real in-flight round while open() can still succeed — MicroMarket.open()
  // requires block.timestamp <= lockTime. Past lockTime it can never be opened and is
  // never picked up by isResolvableStatus either, so counting it as active would block
  // every future round forever. Treat it as dead instead.
  if (status !== "CREATED") return false;
  const lockTime = Date.parse(market?.lockTime || "");
  if (!Number.isFinite(lockTime)) return false;
  return now <= lockTime;
}

/** CREATED past its lockTime: unopenable, unresolvable — needs cancelling to leave the list. */
function isStrandedCreated(
  market: { status?: string; lockTime?: string },
  now: number = Date.now()
): boolean {
  if (String(market.status || "").toUpperCase() !== "CREATED") return false;
  const lockTime = Date.parse(market.lockTime || "");
  return Number.isFinite(lockTime) && now > lockTime;
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
      ? lockTime + OBSERVATION_SECONDS_BTC * 1000
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
    // non-fatal for the worker
  }
}
