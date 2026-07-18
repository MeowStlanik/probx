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

/** Prefer OPEN, else LOCKED/OBSERVATION of that type. */
export function pickLiveMarketHref(markets: Market[], kind: "btc" | "weather"): string | undefined {
  const match = kind === "btc" ? isBtcMarket : isWeatherMarket;
  const live = markets.filter(
    (m) => match(m) && (m.status === "OPEN" || m.status === "LOCKED" || m.status === "OBSERVATION")
  );
  if (!live.length) return undefined;
  const open = live.find((m) => m.status === "OPEN");
  return `/markets/${(open ?? live[0]).id}`;
}
