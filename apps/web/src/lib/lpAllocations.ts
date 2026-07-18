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

const minutesAgo = (index: number) => `~${(index + 1) * 3}m`;

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

/**
 * Build a "recent reserve allocations" table from live markets. Active markets
 * (OPEN / LOCKED / OBSERVATION) show as reserve held; resolved markets show as
 * released. When no live markets exist we fall back to a representative demo
 * set so the panel is never empty in the demo.
 */
export function deriveAllocations(markets: Market[]): ReserveAllocation[] {
  const rows = markets
    .filter((m) => m.status !== "CANCELLED" && m.status !== "ARCHIVED")
    .slice(0, 8)
    .map((market, index) => {
      const active =
        market.status === "OPEN" ||
        market.status === "LOCKED" ||
        market.status === "OBSERVATION";
      const side: Outcome =
        market.winningOutcome ?? (market.yesPrice >= market.noPrice ? "YES" : "NO");
      const amount = Math.max(120, Math.round((market.volume || 400) / 2));
      return {
        id: market.id,
        time: minutesAgo(index),
        market: shortMarketLabel(market),
        side,
        amount: money(amount),
        status: active ? ("Active" as const) : ("Released" as const)
      };
    });

  return rows.length ? rows : demoAllocations;
}

/** Representative allocations matching the design reference. */
export const demoAllocations: ReserveAllocation[] = [
  { id: "a1", time: "~1m", market: "BTC ≥ $118,500", side: "YES", amount: "$1,240.00", status: "Active" },
  { id: "a2", time: "~3m", market: "London ≥ 21°C", side: "NO", amount: "$640.00", status: "Active" },
  { id: "a3", time: "~6m", market: "ETH ≥ $4,150", side: "YES", amount: "$2,110.00", status: "Released" },
  { id: "a4", time: "~9m", market: "Arc block < 2.0s", side: "YES", amount: "$380.00", status: "Released" },
  { id: "a5", time: "~12m", market: "BTC ≥ $118,200", side: "NO", amount: "$920.00", status: "Released" },
  { id: "a6", time: "~15m", market: "SOL ≥ $208", side: "YES", amount: "$560.00", status: "Released" },
  { id: "a7", time: "~18m", market: "London ≥ 20°C", side: "YES", amount: "$410.00", status: "Released" },
  { id: "a8", time: "~21m", market: "ETH ≥ $4,100", side: "NO", amount: "$780.00", status: "Released" }
];
