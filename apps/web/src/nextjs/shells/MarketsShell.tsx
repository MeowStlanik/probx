"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMarkets } from "@/lib/api";
import { isBtcMarket, isWeatherMarket } from "@/lib/marketLinks";
import { arcDeployment } from "@/lib/onchain";
import type { Market } from "@/lib/types";
import { toMarketSummary } from "../mapMarket";
import type { LoadState } from "../types";
import { MarketsListView } from "../views/MarketsListView";

function isBtcOrWeather(m: Market): boolean {
  return isBtcMarket(m) || isWeatherMarket(m);
}

/**
 * Wires MarketsListView → fetchMarkets()
 * serverNow freezes first paint for hydration; then 1s clock + quiet poll.
 */
export function MarketsShell({
  initial,
  serverNow = 0
}: {
  initial?: Market[];
  serverNow?: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<LoadState>(initial?.length ? "live" : "loading");
  const [raw, setRaw] = useState<Market[]>(() => (initial ?? []).filter(isBtcOrWeather));
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setState((s) => (s === "live" || s === "empty" ? s : "loading"));
    try {
      const all = (await fetchMarkets()).filter(isBtcOrWeather);
      const open = all.filter(isOpenish);
      setRaw(all);
      setState(open.length ? "live" : "empty");
    } catch {
      setState((s) => (raw.length ? s : "error"));
    }
  }, [raw.length]);

  useEffect(() => {
    void load({ silent: Boolean(initial?.length) });
    const id = window.setInterval(() => void load({ silent: true }), 12_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount + interval only
  }, []);

  const markets = useMemo(() => {
    const t = now || serverNow || Date.now();
    // Stable order: BTC then weather (max one each from API collapse)
    const open = raw.filter(isOpenish);
    const btc = open.filter(isBtcMarket);
    const weather = open.filter(isWeatherMarket);
    return [...btc, ...weather].map((m) => toMarketSummary(m, t));
  }, [raw, now, serverNow]);

  const resolvedBanner = useMemo(() => {
    const resolved = raw.filter((m) => m.status === "RESOLVED");
    if (!resolved.length) return null;
    const latest = resolved[0];
    return {
      question: latest.question,
      resolvedAgo: "recently",
      stats: `${latest.ticketCount ?? 0} tickets · ${Math.round(latest.volume || 0)} USDC vol`,
      outcome: (latest.winningOutcome ?? "YES") as "YES" | "NO",
      txHref: `${arcDeployment.explorerUrl}/address/${latest.contractAddress ?? latest.id}`
    };
  }, [raw]);

  return (
    <MarketsListView
      state={state === "loading" && markets.length ? "live" : state}
      markets={markets}
      resolvedBanner={resolvedBanner}
      onSelectMarket={(id) => router.push(`/markets/${id}`)}
      onRetry={() => void load()}
    />
  );
}

function isOpenish(m: Market) {
  return m.status === "OPEN" || m.status === "LOCKED" || m.status === "OBSERVATION" || m.status === "CREATED";
}
