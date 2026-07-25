/**
 * Unit tests for observation snapshot boundary logic + raw tick selection.
 * Covers audit A/B/E/G/J regressions (and prior P0 end≥obsEnd).
 */
import assert from "node:assert/strict";
import {
  snapshotReadyForResolve,
  valueNearTimeWithin,
  snapshotGraceMs,
  snapshotMaxDistanceMs,
  resolveOutcomeFromPrints,
  WEATHER_PROVIDER_INTERVAL_MS,
  WEATHER_SNAPSHOT_GRACE_MS,
  BTC_SNAPSHOT_GRACE_MS,
  BTC_OBSERVATION_MS,
  WEATHER_OBSERVATION_MS,
  ORACLE_TICK_RETENTION_MS,
  type ObservationSnapshot
} from "./observationSnapshots.js";
import {
  firstTickAtOrAfter,
  nearestRawTick,
  rawTickIdentity,
  serializeRawTickMember,
  parseRawTickMember,
  type RawTick
} from "./rawTicks.js";
import {
  computeServerIdempotencyKey,
  normalizePrincipal
} from "./cctpDemoFundService.js";
import { parseProviderUtcMs } from "./onchainService.js";
import { isSettleCursorDone } from "./marketCycleWorker.js";
import { clientIpFromHeaders } from "../routes/wallet.js";

async function main() {
  // ─── A: weather grace / distance must span provider grid ─────────────────
  assert.ok(
    WEATHER_SNAPSHOT_GRACE_MS >= WEATHER_PROVIDER_INTERVAL_MS,
    "weather grace must be ≥ one Open-Meteo interval (else markets cancel)"
  );
  assert.ok(
    snapshotGraceMs("weather") > snapshotGraceMs("btc") * 10,
    "weather grace must be far longer than BTC 45s grace"
  );
  assert.equal(snapshotGraceMs("btc"), BTC_SNAPSHOT_GRACE_MS);
  assert.ok(
    snapshotMaxDistanceMs("weather") >= WEATHER_PROVIDER_INTERVAL_MS,
    "weather maxDist must accept a print up to one full interval after obsEnd"
  );

  // Weather end print 12 min after obsEnd is valid; with old 5-min maxDist it was dropped.
  const obsEndW = 2_000_000;
  const weatherTicks: RawTick[] = [
    {
      value: 18.2,
      observedAt: obsEndW - 900_000,
      receivedAt: obsEndW - 900_000,
      provider: "open-meteo"
    },
    {
      value: 18.5,
      observedAt: obsEndW + 12 * 60_000,
      receivedAt: obsEndW + 12 * 60_000 + 50,
      provider: "open-meteo"
    }
  ];
  const weatherClose = firstTickAtOrAfter(
    weatherTicks,
    obsEndW,
    snapshotMaxDistanceMs("weather")
  );
  assert.equal(weatherClose?.value, 18.5, "must accept weather end print 12m after obsEnd");
  const weatherCloseTight = firstTickAtOrAfter(weatherTicks, obsEndW, 5 * 60_000);
  assert.equal(
    weatherCloseTight,
    undefined,
    "sanity: 5-min window (old bug) would miss the 12m-late print"
  );

  // Ready check with weather distances: end 12m after obsEnd is ok.
  const weatherSnap: ObservationSnapshot = {
    market: "0xweather",
    role: "weather",
    startValue: 18.2,
    startTimestamp: obsEndW - 1_800_000,
    endValue: 18.5,
    endTimestamp: obsEndW + 12 * 60_000,
    source: "open-meteo",
    updatedAt: ""
  };
  const weatherReady = snapshotReadyForResolve(
    weatherSnap,
    obsEndW - 1_800_000,
    obsEndW,
    snapshotMaxDistanceMs("weather")
  );
  assert.equal(weatherReady.ok, true, "weather snapshot 12m late must be ready");

  // Explicit tie rule
  assert.deepEqual(resolveOutcomeFromPrints(10, 11), { outcome: "YES", tie: false });
  assert.deepEqual(resolveOutcomeFromPrints(10, 9), { outcome: "NO", tie: false });
  assert.deepEqual(resolveOutcomeFromPrints(10, 10), { outcome: "NO", tie: true });

  // ─── B: deterministic ZSET member ignores receivedAt ─────────────────────
  const tA: RawTick = {
    value: 100_000,
    observedAt: 1_700_000_000_000,
    receivedAt: 1,
    provider: "coinbase",
    sourceHash: "abc"
  };
  const tB: RawTick = { ...tA, receivedAt: 999_999 };
  assert.equal(
    rawTickIdentity(tA),
    rawTickIdentity(tB),
    "same observation with different receivedAt must share identity"
  );
  assert.equal(
    serializeRawTickMember(tA),
    serializeRawTickMember(tB),
    "ZSET member must not include receivedAt"
  );
  assert.ok(
    !serializeRawTickMember(tA).includes("receivedAt"),
    "serialized member JSON must omit receivedAt field"
  );
  const parsed = parseRawTickMember(serializeRawTickMember(tA));
  assert.equal(parsed?.value, tA.value);
  assert.equal(parsed?.observedAt, tA.observedAt);

  // Distinct observations stay distinct
  assert.notEqual(
    rawTickIdentity(tA),
    rawTickIdentity({ ...tA, observedAt: tA.observedAt + 1 })
  );

  // ─── prior + baseline snapshot tests ─────────────────────────────────────
  const t0 = 1_000_000;
  const hist = [
    { value: 100, at: t0 },
    { value: 101, at: t0 + 60_000 },
    { value: 99, at: t0 + 120_000 }
  ];

  const open = valueNearTimeWithin(hist, t0, 35_000);
  assert.equal(open?.value, 100);

  const close = valueNearTimeWithin(hist, t0 + 60_000, 35_000);
  assert.equal(close?.value, 101);

  const lateTicks: RawTick[] = [
    {
      value: 100,
      observedAt: t0 + 22_000,
      receivedAt: t0 + 22_100,
      provider: "coinbase"
    },
    {
      value: 101,
      observedAt: t0 + 60_000 + 22_000,
      receivedAt: t0 + 60_000 + 22_100,
      provider: "coinbase"
    }
  ];
  const openLate = nearestRawTick(lateTicks, t0, 35_000);
  const closeLate = firstTickAtOrAfter(lateTicks, t0 + 60_000, 35_000);
  assert.equal(openLate?.value, 100);
  assert.equal(closeLate?.value, 101);

  const obsEnd = t0 + 60_000;
  const earlyEndTicks: RawTick[] = [
    {
      value: 50,
      observedAt: obsEnd - 5 * 60_000,
      receivedAt: obsEnd - 5 * 60_000,
      provider: "test"
    },
    {
      value: 55,
      observedAt: obsEnd + 2_000,
      receivedAt: obsEnd + 2_100,
      provider: "test"
    }
  ];
  const endPick = firstTickAtOrAfter(earlyEndTicks, obsEnd, 35_000);
  assert.equal(endPick?.value, 55, "must pick first tick at/after obsEnd, not 5m early");
  assert.ok(endPick && endPick.at >= obsEnd);

  const onlyEarly = firstTickAtOrAfter(
    [
      {
        value: 50,
        observedAt: obsEnd - 5_000,
        receivedAt: obsEnd - 5_000,
        provider: "test"
      }
    ],
    obsEnd,
    35_000
  );
  assert.equal(onlyEarly, undefined);

  const ready = snapshotReadyForResolve(
    {
      market: "0xabc",
      role: "btc",
      startValue: 100,
      startTimestamp: t0 + 22_000,
      endValue: 101,
      endTimestamp: t0 + 82_000,
      startSource: {
        value: 100,
        observedAt: t0 + 22_000,
        receivedAt: t0 + 22_050,
        provider: "coinbase",
        sourceId: "spot"
      },
      endSource: {
        value: 101,
        observedAt: t0 + 82_000,
        receivedAt: t0 + 82_050,
        provider: "coinbase"
      },
      source: "test",
      updatedAt: new Date().toISOString()
    },
    t0,
    t0 + 60_000,
    35_000
  );
  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.equal(ready.end > ready.start, true);
    assert.equal(ready.startSource?.provider, "coinbase");
    assert.equal(ready.endSource?.provider, "coinbase");
  }

  const endBefore: ObservationSnapshot = {
    market: "0x",
    role: "btc",
    startValue: 100,
    startTimestamp: t0,
    endValue: 99,
    endTimestamp: obsEnd - 1,
    source: "x",
    updatedAt: ""
  };
  const badEnd = snapshotReadyForResolve(endBefore, t0, obsEnd, 35_000);
  assert.equal(badEnd.ok, false);
  if (!badEnd.ok) {
    assert.match(badEnd.reason, /before observationEnd/i);
  }

  const missing = snapshotReadyForResolve(
    { market: "0x", role: "btc", source: "x", updatedAt: "" },
    t0,
    t0 + 60_000
  );
  assert.equal(missing.ok, false);

  // ─── E: settle cursor done marker ────────────────────────────────────────
  assert.equal(isSettleCursorDone(null), false);
  assert.equal(isSettleCursorDone({ cursor: 0 } as { done?: boolean }), false);
  assert.equal(isSettleCursorDone({ done: true }), true);
  assert.equal(isSettleCursorDone({ done: false }), false);

  // ─── G: Open-Meteo timestamps without Z parse as UTC ─────────────────────
  const om = "2026-07-25T09:15";
  const utcMs = parseProviderUtcMs(om);
  assert.ok(Number.isFinite(utcMs), "parseProviderUtcMs must parse Open-Meteo time");
  assert.equal(utcMs, Date.parse("2026-07-25T09:15:00.000Z"));
  // With Z already present
  assert.equal(parseProviderUtcMs("2026-07-25T09:15:00Z"), Date.parse("2026-07-25T09:15:00Z"));
  // Empty
  assert.ok(Number.isNaN(parseProviderUtcMs("")));

  // ─── J: principal email ≠ mintTo changes server key ──────────────────────
  const mint = "0x1111111111111111111111111111111111111111";
  const kEmail = computeServerIdempotencyKey({
    clientKey: "uuid-1",
    principal: "email:alice@example.com",
    mintTo: mint,
    requestedAmount: "2000000",
    chainId: 5042002
  });
  const kAddr = computeServerIdempotencyKey({
    clientKey: "uuid-1",
    principal: mint,
    mintTo: mint,
    requestedAmount: "2000000",
    chainId: 5042002
  });
  assert.notEqual(
    kEmail,
    kAddr,
    "email principal must produce a different server key than mintTo-as-principal"
  );
  assert.equal(normalizePrincipal("Alice@Example.com"), "email:alice@example.com");
  assert.equal(normalizePrincipal("email:Bob@X.com"), "email:bob@x.com");
  assert.equal(
    normalizePrincipal(mint),
    mint.toLowerCase()
  );

  const k1 = computeServerIdempotencyKey({
    clientKey: "uuid-1",
    principal: mint,
    mintTo: mint,
    requestedAmount: "2000000",
    chainId: 5042002
  });
  const k2 = computeServerIdempotencyKey({
    clientKey: "uuid-1",
    principal: mint,
    mintTo: "0x2222222222222222222222222222222222222222",
    requestedAmount: "2000000",
    chainId: 5042002
  });
  const k3 = computeServerIdempotencyKey({
    clientKey: "uuid-1",
    principal: mint,
    mintTo: mint,
    requestedAmount: "3000000",
    chainId: 5042002
  });
  const k1b = computeServerIdempotencyKey({
    clientKey: "uuid-1",
    principal: mint,
    mintTo: mint,
    requestedAmount: "2000000",
    chainId: 5042002
  });
  assert.equal(k1, k1b);
  assert.notEqual(k1, k2, "different mintTo must change server key");
  assert.notEqual(k1, k3, "different amount must change server key");

  // ─── D: IP extraction from proxy headers ─────────────────────────────────
  assert.equal(
    clientIpFromHeaders({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }),
    "203.0.113.9"
  );
  assert.equal(clientIpFromHeaders({ "x-real-ip": "198.51.100.2" }), "198.51.100.2");
  assert.equal(clientIpFromHeaders({}), undefined);

  // ─── A/B: raw-tick retention must outlive window + grace ─────────────────
  // The start print is written at observationStart and only read back at resolve,
  // which runs between observationEnd and observationEnd + grace. If retention is
  // shorter, nearestRawTick() can never see the start boundary and the fallback is
  // dead by construction — leaving the snapshot store as a single point of failure.
  for (const [role, windowMs, graceMs] of [
    ["btc", BTC_OBSERVATION_MS, BTC_SNAPSHOT_GRACE_MS],
    ["weather", WEATHER_OBSERVATION_MS, WEATHER_SNAPSHOT_GRACE_MS]
  ] as const) {
    assert.ok(
      ORACLE_TICK_RETENTION_MS > windowMs + graceMs,
      `raw-tick retention (${ORACLE_TICK_RETENTION_MS}ms) must exceed ${role} window + grace ` +
        `(${windowMs + graceMs}ms), otherwise the start print expires before resolve reads it`
    );
  }
  // Weather must span more than one provider interval, else end can equal start.
  assert.ok(
    WEATHER_OBSERVATION_MS > WEATHER_PROVIDER_INTERVAL_MS,
    "weather observation window must span more than one Open-Meteo interval"
  );

  // ─── P0: a failed settle must never mark the market done ─────────────────
  // Callers persist a terminal marker on `done`, so a false positive strands the
  // ticket's LP reserve forever (deposit/withdraw both need reservedAssets == 0).
  const { settleRunIsComplete } = await import("./onchainService.js");
  assert.equal(
    settleRunIsComplete({ reachedEnd: true, failedCount: 1, engineReportsNoExposure: true }),
    false,
    "a reverted settle must block done even if the chain looks clear"
  );
  assert.equal(
    settleRunIsComplete({ reachedEnd: true, failedCount: 0, engineReportsNoExposure: undefined }),
    false,
    "unconfirmed exposure must not count as done"
  );
  assert.equal(
    settleRunIsComplete({ reachedEnd: true, failedCount: 0, engineReportsNoExposure: false }),
    false,
    "engine still reporting exposure must not count as done"
  );
  assert.equal(
    settleRunIsComplete({ reachedEnd: false, failedCount: 0, engineReportsNoExposure: true }),
    false,
    "mid-list cursor is never done"
  );
  assert.equal(
    settleRunIsComplete({ reachedEnd: true, failedCount: 0, engineReportsNoExposure: true }),
    true,
    "clean pass with engine confirming zero exposure is done"
  );

  console.log("observationSnapshots tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
