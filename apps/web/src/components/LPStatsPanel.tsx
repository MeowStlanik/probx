"use client";

import { useEffect, useState } from "react";
import { formatUsdc } from "@/lib/format";
import { readOnchainLpStats } from "@/lib/readOnchainLpStats";
import { emptyLpStats } from "@/lib/sampleData";
import type { LpStats } from "@/lib/types";

function money(value: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  }).format(value || 0);
}

interface LPStatsPanelProps {
  stats?: LpStats;
  /** Also render the reserve waterfall under the tiles */
  showWaterfall?: boolean;
}

function normalizeLpStats(stats: Partial<LpStats> | null | undefined): LpStats {
  return {
    tvl: Number(stats?.tvl) || 0,
    reservedLiquidity: Number(stats?.reservedLiquidity) || 0,
    lockedUserRisk: Number(stats?.lockedUserRisk) || 0,
    availableLiquidity: Number(stats?.availableLiquidity) || 0,
    feesEarned: Number(stats?.feesEarned) || 0,
    dailyVolume: Number(stats?.dailyVolume) || 0,
    simulatedApy: Number(stats?.simulatedApy) || 0
  };
}

async function loadLpStats(): Promise<LpStats> {
  try {
    const response = await fetch("/api/lp/stats", { cache: "no-store" });
    if (response.ok) {
      const body = normalizeLpStats((await response.json()) as LpStats);
      if (body.tvl > 0 || body.availableLiquidity > 0 || body.feesEarned > 0) {
        return body;
      }
    }
  } catch {
    // continue
  }

  try {
    return await readOnchainLpStats();
  } catch {
    return emptyLpStats;
  }
}

function utilizationPct(stats: LpStats): string {
  if (!stats.tvl || stats.tvl <= 0) return "—";
  const pct = (stats.reservedLiquidity / stats.tvl) * 100;
  return `${Math.round(pct)}%`;
}

export function LPStatsPanel({ stats: initial, showWaterfall = false }: LPStatsPanelProps) {
  const [stats, setStats] = useState<LpStats>(initial ?? emptyLpStats);
  const [source, setSource] = useState<string>(
    initial && (initial.tvl > 0 || initial.availableLiquidity > 0) ? "ssr" : "loading"
  );

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const next = await loadLpStats();
      if (cancelled) return;
      setStats(next);
      setSource(next.tvl > 0 || next.availableLiquidity > 0 ? "live" : "empty");
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <>
      <section className="lpStatTiles" aria-label="Liquidity pool statistics">
        <div className="statTile">
          <span>TVL</span>
          <strong className="statTileValue">
            {money(stats.tvl)} <em>USDC</em>
          </strong>
        </div>
        <div className="statTile">
          <span>Reserved</span>
          <strong className="statTileValue blue">
            {money(stats.reservedLiquidity)} <em>USDC</em>
          </strong>
        </div>
        <div className="statTile">
          <span>Available</span>
          <strong className="statTileValue yes">
            {money(stats.availableLiquidity)} <em>USDC</em>
          </strong>
        </div>
        <div className="statTile">
          <span>Utilization</span>
          <strong className="statTileValue">{utilizationPct(stats)}</strong>
        </div>
      </section>
      {source === "loading" ? (
        <p className="settlementNote" style={{ marginTop: "0.5rem" }}>
          Loading vault balances from Arc…
        </p>
      ) : null}

      {showWaterfall ? (
        <section className="waterfall">
          <h2>Reserve accounting</h2>
          <div>
            <span>LP TVL</span>
            <strong>{formatUsdc(stats.tvl, 2)}</strong>
          </div>
          <div>
            <span>Reserved for max payouts</span>
            <strong>{formatUsdc(stats.reservedLiquidity, 2)}</strong>
          </div>
          <div>
            <span>Locked user risk</span>
            <strong>{formatUsdc(stats.lockedUserRisk, 2)}</strong>
          </div>
          <div>
            <span>Available reserve</span>
            <strong>{formatUsdc(stats.availableLiquidity, 2)}</strong>
          </div>
          <div>
            <span>Fees earned</span>
            <strong>{formatUsdc(stats.feesEarned, 4)}</strong>
          </div>
          <div>
            <span>Simulated APY</span>
            <strong>{(stats.simulatedApy * 100).toFixed(1)}%</strong>
          </div>
        </section>
      ) : null}
    </>
  );
}
