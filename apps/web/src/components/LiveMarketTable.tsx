"use client";

import { useCallback, useEffect, useState } from "react";
import { MarketTable } from "@/components/MarketTable";
import { apiUrl } from "@/lib/api";
import type { Market } from "@/lib/types";

export function LiveMarketTable({ initial }: { initial: Market[] }) {
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
    return () => window.clearInterval(id);
  }, [pull]);

  return <MarketTable markets={markets} />;
}
