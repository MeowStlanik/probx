/**
 * Unit tests for observation snapshot boundary logic (resolve correctness).
 * Run: pnpm --filter @probx/api exec tsx src/services/observationSnapshots.test.ts
 */
import assert from "node:assert/strict";
import { snapshotReadyForResolve, valueNearTimeWithin } from "./observationSnapshots.js";

function main() {
  const t0 = 1_000_000;
  const hist = [
    { value: 100, at: t0 },
    { value: 101, at: t0 + 60_000 },
    { value: 99, at: t0 + 120_000 }
  ];

  const open = valueNearTimeWithin(hist, t0, 10_000);
  assert.equal(open?.value, 100);

  const close = valueNearTimeWithin(hist, t0 + 60_000, 10_000);
  assert.equal(close?.value, 101);

  // Current price 99 at +120s must NOT be used as observation end (too far for 10s window)
  const far = valueNearTimeWithin(hist, t0 + 60_000, 10_000);
  assert.notEqual(far?.value, 99);

  const ready = snapshotReadyForResolve(
    {
      market: "0xabc",
      role: "btc",
      startValue: 100,
      startTimestamp: t0,
      endValue: 101,
      endTimestamp: t0 + 60_000,
      source: "test",
      updatedAt: new Date().toISOString()
    },
    t0,
    t0 + 60_000,
    10_000
  );
  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.equal(ready.end > ready.start, true); // YES
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
