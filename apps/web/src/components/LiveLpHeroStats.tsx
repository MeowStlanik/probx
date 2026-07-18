"use client";

import { useEffect, useState } from "react";
import { formatUsdc } from "@/lib/format";
import { emptyLpStats } from "@/lib/sampleData";
import type { LpStats } from "@/lib/types";

interface LiveLpHeroStatsProps {
  initial?: LpStats;
  openMarkets: number;
}

function normalize(stats: Partial<LpStats>): LpStats {
  return {
    tvl: Number(stats.tvl) || 0,
    reservedLiquidity: Number(stats.reservedLiquidity) || 0,
    lockedUserRisk: Number(stats.lockedUserRisk) || 0,
    availableLiquidity: Number(stats.availableLiquidity) || 0,
    feesEarned: Number(stats.feesEarned) || 0,
    dailyVolume: Number(stats.dailyVolume) || 0,
    simulatedApy: Number(stats.simulatedApy) || 0,
    simulated: Boolean(stats.simulated)
  };
}

export function LiveLpHeroStats({ initial, openMarkets }: LiveLpHeroStatsProps) {
  const [stats, setStats] = useState<LpStats>(initial ?? emptyLpStats);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/lp/stats", { cache: "no-store" });
        if (!response.ok) return;
        const body = normalize((await response.json()) as LpStats);
        if (!cancelled) setStats(body);
      } catch {
        // keep previous
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="miniProofs" aria-label="Onchain snapshot">
      <div>
        <span>LP vault TVL</span>
        <strong>{formatUsdc(stats.tvl, 2)}</strong>
      </div>
      <div>
        <span>Available reserve</span>
        <strong>{formatUsdc(stats.availableLiquidity, 2)}</strong>
      </div>
      <div>
        <span>Open markets</span>
        <strong>{openMarkets}</strong>
      </div>
      {stats.simulated ? (
        <div>
          <span>Data source</span>
          <strong>Demo snapshot</strong>
        </div>
      ) : null}
    </div>
  );
}
