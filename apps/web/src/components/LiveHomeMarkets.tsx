"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MarketCard } from "@/components/MarketCard";
import { MarketLifecycleStage } from "@/components/MarketLifecycleStage";
import { apiUrl } from "@/lib/api";
import type { Market } from "@/lib/types";

type Props = {
  initial: Market[];
};

/**
 * Client-polled open markets so home stays live.
 */
export function LiveHomeMarkets({ initial }: Props) {
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

  const featured = useMemo(() => pickFeatured(live.length ? live : markets), [live, markets]);

  return (
    <>
      {featured ? <MarketLifecycleStage market={featured} className="homeLifecycle" /> : null}

      <section className="marketStack homeMarketsOnly">
        <div className="sectionHeader">
          <div>
            <h2>Live markets</h2>
          </div>
          <Link href="/markets">View all markets →</Link>
        </div>

        {live.length ? (
          <div className="cardGrid">
            {live.map((market) => (
              <MarketCard key={market.id} market={market} />
            ))}
          </div>
        ) : (
          <div className="marketsEmptyState">
            <strong>No open markets</strong>
            <p>Next BTC / London window opens as the cycle rolls (~1–2 min). Pulling live status…</p>
            <Link className="iconButton secondary" href="/markets">
              View markets
            </Link>
          </div>
        )}
      </section>
    </>
  );
}

function pickFeatured(markets: Market[]): Market | undefined {
  if (!markets.length) return undefined;
  const open = markets.filter((m) => m.status === "OPEN");
  const pool = open.length ? open : markets;
  return (
    pool.find((m) => m.demoRole === "btc_price") ??
    pool.find((m) => m.demoRole === "london_weather") ??
    pool[0]
  );
}
