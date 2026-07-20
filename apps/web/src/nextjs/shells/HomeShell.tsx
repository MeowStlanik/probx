"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMarkets } from "@/lib/api";
import { isBtcMarket, isWeatherMarket } from "@/lib/marketLinks";
import type { LpStats, Market } from "@/lib/types";
import { moneyUsdc, toMarketSummary } from "../mapMarket";
import { HomeView } from "../views/HomeView";

function isBtcOrWeather(m: Market): boolean {
  return isBtcMarket(m) || isWeatherMarket(m);
}

/**
 * Wires HomeView → SSR markets + lp stats.
 * serverNow freezes first paint (hydration); client ticks after mount.
 */
export function HomeShell({
  markets: initialMarkets,
  stats,
  serverNow = 0
}: {
  markets: Market[];
  stats: LpStats;
  serverNow?: number;
}) {
  const router = useRouter();
  const [raw, setRaw] = useState<Market[]>(() => initialMarkets.filter(isBtcOrWeather));
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchMarkets();
      // Keep SSR seed on empty/transient API blips (same rule as MarketsShell).
      if (next.length) setRaw(next.filter(isBtcOrWeather));
    } catch {
      /* keep SSR seed */
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Fast poll so new OPEN markets show while the timer still has time left.
    const id = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const open = useMemo(
    () =>
      raw.filter(
        (m) =>
          m.status === "OPEN" ||
          m.status === "LOCKED" ||
          m.status === "OBSERVATION" ||
          m.status === "CREATED"
      ),
    [raw]
  );

  const t = now || serverNow || 0;
  const preview = useMemo(() => {
    // Prefer one BTC + one weather, newest first within each
    const btc = open.filter(isBtcMarket).sort((a, b) => Date.parse(b.openTime) - Date.parse(a.openTime))[0];
    const weather = open
      .filter(isWeatherMarket)
      .sort((a, b) => Date.parse(b.openTime) - Date.parse(a.openTime))[0];
    const ordered = [btc, weather].filter(Boolean) as Market[];
    return ordered.map((m) => toMarketSummary(m, t || Date.now()));
  }, [open, t]);

  const hero = preview[0] ?? {
    id: "placeholder",
    question: "No open markets right now — check back after the next cycle.",
    category: "Arc · Testnet",
    yesPct: 0.5,
    noPct: 0.5,
    yesVolPct: 50,
    stats: "0 tickets · 0 USDC vol",
    stage: "OPEN" as const,
    secondsToNextStage: 0,
    nowPct: 0
  };

  // Prefer aggregate stats from LP endpoint (engine-wide TicketBought + resolved).
  // Note: `0 ?? fallback` is 0 — only fall back when the field is missing.
  const fromListVolume = raw.reduce((s, m) => s + (m.volume || 0), 0);
  const fromListTickets = raw.reduce((s, m) => s + (m.ticketCount || 0), 0);
  const fromListResolved = raw.filter((m) => m.status === "RESOLVED").length;
  const volume =
    typeof stats.totalVolume === "number" ? stats.totalVolume : fromListVolume;
  const tickets =
    typeof stats.totalTickets === "number" ? stats.totalTickets : fromListTickets;
  const resolved =
    typeof stats.totalResolved === "number" ? stats.totalResolved : fromListResolved;

  return (
    <HomeView
      heroMarket={hero}
      marketsPreview={preview.length ? preview : [hero]}
      stats={{
        volume: moneyUsdc(volume),
        tickets: String(tickets),
        resolved: String(resolved),
        tvl: moneyUsdc(stats.tvl || 0)
      }}
      onSelectMarket={(id) => {
        if (id !== "placeholder") router.push(`/markets/${id}`);
        else router.push("/markets");
      }}
    />
  );
}
