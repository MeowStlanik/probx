/**
 * Continuous BTC + London weather market cycle:
 * - ~60s OPEN (entry) → ~60s observation → resolve + settle
 * - A new OPEN market is created as soon as the previous one locks (≈ every minute)
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

/** Nominal entry window length (seconds). Lock fires slightly earlier (sniper buffer). */
const LOCK_SECONDS = 60;
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
      if (!isReferenceRole(market.demoRole, market.category)) continue;
      if (!isResolvableStatus(market.status)) continue;
      if (!isReadyToResolve(market, now)) continue;
      if (!hasParseableThreshold(market.demoRole, market.category, market.question)) continue;

      try {
        console.log(`[market-cycle] resolving ${market.demoRole} ${market.id}`);
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

    // 2) Ensure an OPEN market for BTC and weather.
    //    LOCKED/OBSERVATION of the previous cycle does NOT block creation → ~1 new market / minute / type.
    const live = await listOnchainMarkets({ forCycle: true });
    const hasOpenBtc = live.some(
      (m) => isReferenceBtc(m.demoRole, m.category) && m.status === "OPEN"
    );
    const hasOpenWeather = live.some(
      (m) => isReferenceWeather(m.demoRole, m.category) && m.status === "OPEN"
    );

    if (!hasOpenBtc) {
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

    if (!hasOpenWeather) {
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

    // 3) Hide finished + superseded reference markets from browse UI.
    //    Public list also collapses to 1 BTC + 1 weather (see listOnchainMarkets).
    //    Claim still works: Portfolio loads tickets by address; getMarket accepts raw 0x ids.
    const refreshed = await listOnchainMarkets({ forCycle: true });
    const openBtcId = refreshed.find(
      (m) => isReferenceBtc(m.demoRole, m.category) && m.status === "OPEN"
    )?.id;
    const openWeatherId = refreshed.find(
      (m) => isReferenceWeather(m.demoRole, m.category) && m.status === "OPEN"
    )?.id;

    for (const market of refreshed) {
      if (!isReferenceRole(market.demoRole, market.category)) continue;

      const finished = market.status === "RESOLVED" || market.status === "CANCELLED";
      const supersededBtc =
        isReferenceBtc(market.demoRole, market.category) &&
        Boolean(openBtcId) &&
        market.id !== openBtcId &&
        market.status !== "OPEN";
      const supersededWeather =
        isReferenceWeather(market.demoRole, market.category) &&
        Boolean(openWeatherId) &&
        market.id !== openWeatherId &&
        market.status !== "OPEN";

      if (!finished && !supersededBtc && !supersededWeather) continue;

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
    note: "New OPEN BTC/weather when previous locks (~1/min). Markets UI shows 1 live BTC + 1 weather; claim via Portfolio."
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

function isReferenceRole(role?: string, category?: string): boolean {
  return isReferenceBtc(role, category) || isReferenceWeather(role, category);
}

function isReferenceBtc(role?: string, category?: string): boolean {
  return role === "btc_price" || category === "crypto-candle";
}

function isReferenceWeather(role?: string, category?: string): boolean {
  return role === "london_weather" || category === "weather";
}

function isResolvableStatus(status: string): boolean {
  return status === "OPEN" || status === "LOCKED" || status === "OBSERVATION";
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

function hasParseableThreshold(role: string | undefined, category: string | undefined, question: string): boolean {
  if (isReferenceBtc(role, category)) {
    return /above\s+\$?[\d,]+(?:\.\d+)?/i.test(question);
  }
  if (isReferenceWeather(role, category)) {
    return /at least\s+-?[\d.]+\s*C/i.test(question);
  }
  return false;
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
