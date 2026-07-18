import { strict as assert } from "node:assert";
import { seedMarkets } from "../db/seed.js";
import { applyPriceMargin, ECONOMIC_MAX_BOOST, PRICE_MARGIN, quoteTicket } from "./quoteEngine.js";

const market = seedMarkets()[0]!;

// Seed applies overround: fair 0.4 → quoted ~0.432 / 0.648 (sum ≈ 1.08)
assert.ok(Math.abs(market.yesPrice + market.noPrice - (1 + PRICE_MARGIN)) < 0.001);

const quote = quoteTicket({
  market,
  outcome: "YES",
  riskAmount: 100,
  boost: 2,
  availableReserve: 1_000
});

assert.equal(quote.accepted, true);
assert.ok(quote.payout > 0);
assert.ok(quote.requiredReserve > 0);
// Higher quoted price than 0.4 fair ⇒ lower payout than old 500
assert.ok(quote.payout < 500);

const unavailable = quoteTicket({
  market,
  outcome: "YES",
  riskAmount: 100,
  boost: 5,
  availableReserve: 50
});

assert.equal(unavailable.accepted, false);
assert.equal(unavailable.reason, "INSUFFICIENT_RESERVE");

const margin = applyPriceMargin(0.5);
assert.ok(Math.abs(margin.yesPrice + margin.noPrice - 1.08) < 0.001);
assert.ok(ECONOMIC_MAX_BOOST >= 1.08 && ECONOMIC_MAX_BOOST <= 1.1);

// Regression: maxBoost must not advertise more than LP capacity can reserve.
const starvedQuote = quoteTicket({
  market,
  outcome: "YES",
  riskAmount: 100,
  boost: 1,
  availableReserve: 10
});
// fromLp = (110 × 0.432) / 100 ≈ 0.475 → floored to the 1x minimum,
// NOT bumped to ECONOMIC_MAX_BOOST like the old buggy max() did.
assert.equal(starvedQuote.maxAvailableBoost, 1);

// Regression: quoted prices never exceed on-chain MAX_PRICE (0.95) or 100%.
const extreme = applyPriceMargin(0.93);
assert.ok(extreme.yesPrice <= 0.95);
assert.ok(extreme.yesPrice + 0.0001 < 1);

console.log("quoteEngine tests passed");
