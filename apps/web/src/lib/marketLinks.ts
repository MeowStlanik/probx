import type { Market } from "./types";

export function isBtcMarket(market: Market): boolean {
  const q = market.question.toLowerCase();
  return (
    market.demoRole === "btc_price" ||
    market.category === "crypto-candle" ||
    q.includes("btc/usd") ||
    q.includes("bitcoin")
  );
}

export function isWeatherMarket(market: Market): boolean {
  const q = market.question.toLowerCase();
  return (
    market.demoRole === "london_weather" ||
    market.category === "weather" ||
    q.includes("london temperature") ||
    q.includes("weather")
  );
}

/** Still accepting tickets: OPEN on-chain and wall-clock before lock. */
export function isTradeableNow(market: Market, now = Date.now()): boolean {
  if (market.status !== "OPEN" && market.status !== "CREATED") return false;
  const lock = Date.parse(market.lockTime || "");
  if (Number.isFinite(lock) && now >= lock) return false;
  return true;
}

function newestFirst(a: Market, b: Market): number {
  const aOpen = Date.parse(a.openTime || "") || 0;
  const bOpen = Date.parse(b.openTime || "") || 0;
  return bOpen - aOpen;
}

/**
 * Quick trade target: newest *tradeable* market (OPEN + before lock).
 * Prefer BTC, then weather, then any. Never link a finished/locked round.
 */
export function pickLiveMarketHref(markets: Market[], kind?: "btc" | "weather"): string | undefined {
  const now = Date.now();
  const tradeable = markets.filter((m) => isTradeableNow(m, now)).sort(newestFirst);
  if (!tradeable.length) return undefined;

  if (kind === "btc") {
    const hit = tradeable.find(isBtcMarket);
    return hit ? `/markets/${hit.id}` : undefined;
  }
  if (kind === "weather") {
    const hit = tradeable.find(isWeatherMarket);
    return hit ? `/markets/${hit.id}` : undefined;
  }

  const btc = tradeable.find(isBtcMarket);
  if (btc) return `/markets/${btc.id}`;
  const weather = tradeable.find(isWeatherMarket);
  if (weather) return `/markets/${weather.id}`;
  return `/markets/${tradeable[0]!.id}`;
}

/** Best quick-trade href across kinds, or `/markets` if nothing is open. */
export function pickQuickTradeHref(markets: Market[]): string {
  return (
    pickLiveMarketHref(markets, "btc") ??
    pickLiveMarketHref(markets, "weather") ??
    pickLiveMarketHref(markets) ??
    "/markets"
  );
}
