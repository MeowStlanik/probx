"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MarketCard } from "@/components/MarketCard";
import { apiUrl } from "@/lib/api";
import type { Market } from "@/lib/types";

type Props = {
  initial: Market[];
  /** Home live-markets band (full-width tint section) */
  band?: boolean;
};

/**
 * Client-polled open markets so home stays live.
 */
export function LiveHomeMarkets({ initial, band = false }: Props) {
  const [markets, setMarkets] = useState(initial);

  const pull = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/markets"), { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as Market[];
      if (Array.isArray(next)) setMarkets(next);
    } catch {
      // keep previous
    }
  }, []);

  useEffect(() => {
    void pull();
    const id = window.setInterval(() => void pull(), 4_000);
    const onFocus = () => void pull();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [pull]);

  const live = useMemo(() => {
    const active = markets.filter((m) => m.status === "OPEN" || m.status === "LOCKED");
    return active.length ? active : [];
  }, [markets]);

  return (
    <section className={band ? "homeLiveMarkets" : "marketStack homeMarketsOnly"}>
      <div className="sectionHeader sectionHeaderTight">
        <h2>Live markets</h2>
        <Link href="/markets">View all markets →</Link>
      </div>

      {live.length ? (
        <div className="cardGrid">
          {live.slice(0, 6).map((market) => (
            <MarketCard key={market.id} market={market} />
          ))}
        </div>
      ) : (
        <div className="emptyStatePanel">
          No open markets right now. Next BTC / London window opens as the cycle rolls (~1–2 min).
        </div>
      )}
    </section>
  );
}
