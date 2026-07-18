"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";
import { pickLiveMarketHref } from "@/lib/marketLinks";
import type { Market } from "@/lib/types";

/**
 * Header navigation.
 *
 * "Quick trade" must open the current live market (prefer an OPEN one, else the
 * latest LOCKED / OBSERVATION market), not the markets list. We poll the same
 * markets endpoint the home page uses and keep the freshest open market cached
 * so the link is instant. If nothing is live yet we fall back to /markets.
 */
export function TopNav() {
  const pathname = usePathname();
  const [quickHref, setQuickHref] = useState<string>("/markets");

  const pull = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/markets"), { cache: "no-store" });
      if (!res.ok) return;
      const markets = (await res.json()) as Market[];
      if (!Array.isArray(markets)) return;

      // Prefer any live market: BTC first, then weather, then anything open.
      const href =
        pickLiveMarketHref(markets, "btc") ??
        pickLiveMarketHref(markets, "weather") ??
        firstLiveHref(markets);
      setQuickHref(href ?? "/markets");
    } catch {
      // keep previous target
    }
  }, []);

  useEffect(() => {
    void pull();
    const id = window.setInterval(() => void pull(), 5_000);
    const onFocus = () => void pull();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [pull]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav className="topNav" aria-label="Main navigation">
      <Link href="/markets" aria-current={isActive("/markets") ? "page" : undefined}>
        Markets
      </Link>
      <Link href={quickHref} aria-current={pathname.startsWith("/markets/") ? "page" : undefined}>
        Quick trade
      </Link>
      <Link href="/lp" aria-current={isActive("/lp") ? "page" : undefined}>
        LP
      </Link>
      <Link href="/portfolio" aria-current={isActive("/portfolio") ? "page" : undefined}>
        Portfolio
      </Link>
    </nav>
  );
}

/** Any live market (OPEN preferred, else LOCKED/OBSERVATION), regardless of feed. */
function firstLiveHref(markets: Market[]): string | undefined {
  const live = markets.filter(
    (m) => m.status === "OPEN" || m.status === "LOCKED" || m.status === "OBSERVATION"
  );
  if (!live.length) return undefined;
  const open = live.find((m) => m.status === "OPEN");
  return `/markets/${(open ?? live[0]).id}`;
}
