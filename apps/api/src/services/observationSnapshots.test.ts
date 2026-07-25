/**
 * Unit tests for observation snapshot boundary logic (resolve correctness).
 */
import assert from "node:assert/strict";
import { snapshotReadyForResolve, valueNearTimeWithin } from "./observationSnapshots.js";
import { nearestRawTick } from "./rawTicks.js";

function main() {
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

  // Minute pinger lands ~22s late — still within 35s window via raw ticks.
  const lateTicks = [
    { value: 100, at: t0 + 22_000 },
    { value: 101, at: t0 + 60_000 + 22_000 }
  ];
  const openLate = nearestRawTick(lateTicks, t0, 35_000);
  const closeLate = nearestRawTick(lateTicks, t0 + 60_000, 35_000);
  assert.equal(openLate?.value, 100);
  assert.equal(closeLate?.value, 101);

  const ready = snapshotReadyForResolve(
    {
      market: "0xabc",
      role: "btc",
      startValue: 100,
      startTimestamp: t0 + 22_000,
      endValue: 101,
      endTimestamp: t0 + 82_000,
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
  }

  const missing = snapshotReadyForResolve(
    { market: "0x", role: "btc", source: "x", updatedAt: "" },
    t0,
    t0 + 60_000
  );
  assert.equal(missing.ok, false);

  console.log("observationSnapshots tests passed");
}

main();
