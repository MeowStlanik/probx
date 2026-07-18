"use client";

import { useMemo } from "react";
import { LiveReferencePanel } from "@/components/LiveReferencePanel";
import type { Market } from "@/lib/types";

type MarketLiveChartProps = {
  market: Market;
  feed: "btc" | "weather";
};

/** Live feed chart for the market. Only market threshold is marked — not trade entry. */
export function MarketLiveChart({ market, feed }: MarketLiveChartProps) {
  const markers = useMemo(() => {
    const threshold = thresholdFromQuestion(market);
    if (threshold === undefined) return [];
    return [{ value: threshold, label: "Market threshold", tone: "threshold" as const }];
  }, [market]);

  return (
    <div className="marketInlineFeed">
      <LiveReferencePanel compact embedded feed={feed} markers={markers} />
    </div>
  );
}

function thresholdFromQuestion(market: Market): number | undefined {
  const question = market.question;
  if (market.demoRole === "btc_price" || market.category === "crypto-candle") {
    const match = question.match(/above\s+\$?([\d,]+(?:\.\d+)?)/i);
    if (!match) return undefined;
    const value = Number(match[1].replace(/,/g, ""));
    return Number.isFinite(value) ? value : undefined;
  }
  if (market.demoRole === "london_weather" || market.category === "weather") {
    const match = question.match(/at least\s+(-?[\d.]+)\s*C/i);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}
