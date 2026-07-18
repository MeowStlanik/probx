import type { Market, Outcome } from "./types";

export type ReserveAllocation = {
  id: string;
  time: string;
  market: string;
  side: Outcome;
  amount: string;
  status: "Active" | "Released";
};

const money = (value: number) =>
  `$${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;

/** Short human label for a market row (e.g. "BTC ≥ $118,500", "London ≥ 21°C"). */
function shortMarketLabel(market: Market): string {
  const q = market.question.toLowerCase();
  if (q.includes("btc") || market.demoRole === "btc_price") {
    const price = market.question.match(/\$([\d,]+)/);
    return price ? `BTC ≥ $${price[1]}` : "BTC/USD";
  }
  if (q.includes("london") || market.demoRole === "london_weather") {
    const temp = market.question.match(/([\d.]+)\s*°?c/i);
    return temp ? `London ≥ ${temp[1]}°C` : "London temp";
  }
  if (q.includes("eth")) return "ETH market";
  return market.question.length > 22 ? `${market.question.slice(0, 20)}…` : market.question;
}

function relativeOpen(market: Market, now = Date.now()): string {
  const open = Date.parse(market.openTime || "");
  if (!Number.isFinite(open)) return "—";
  const mins = Math.max(0, Math.round((now - open) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `~${mins}m`;
  return `~${Math.floor(mins / 60)}h`;
}

/**
 * Recent reserve rows from real markets only.
 * - No demo placeholder rows
 * - No invented $200 when volume is 0 (show $0.00 or skip)
 * - Prefer markets with volume / tickets; still list live cycle markets honestly
 */
export function deriveAllocations(markets: Market[]): ReserveAllocation[] {
  const now = Date.now();
  const live = markets
    .filter(
      (m) =>
        m.status === "OPEN" ||
        m.status === "LOCKED" ||
        m.status === "OBSERVATION" ||
        m.status === "RESOLVED"
    )
    .sort((a, b) => (Date.parse(b.openTime || "") || 0) - (Date.parse(a.openTime || "") || 0))
    .slice(0, 8);

  return live.map((market) => {
    const active =
      market.status === "OPEN" || market.status === "LOCKED" || market.status === "OBSERVATION";
    const side: Outcome =
      market.winningOutcome ?? (market.yesPrice >= market.noPrice ? "YES" : "NO");
    // Honest amount: actual reported volume (0 if none) — never invent 400/2
    const amount = Number(market.volume) || 0;
    return {
      id: market.id,
      time: relativeOpen(market, now),
      market: shortMarketLabel(market),
      side,
      amount: money(amount),
      status: active ? ("Active" as const) : ("Released" as const)
    };
  });
}
