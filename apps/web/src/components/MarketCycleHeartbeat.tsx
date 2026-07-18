"use client";

import { useEffect, useRef } from "react";

/**
 * Drives BTC/weather cycle on Vercel Hobby (cron is only daily):
 * while the tab is open, hit /api/cron/market-cycle about every 45s.
 * Requires ORACLE_PRIVATE_KEY (or DEPLOYER/PRIVATE_KEY) on the server.
 */
/** Faster tick so a new OPEN market appears sooner after resolve (Vercel Hobby). */
const INTERVAL_MS = 20_000;

export function MarketCycleHeartbeat() {
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled || inFlight.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      inFlight.current = true;
      try {
        await fetch("/api/cron/market-cycle", {
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
      } catch {
        // best-effort — next interval retries
      } finally {
        inFlight.current = false;
      }
    }

    void tick();
    const id = window.setInterval(() => void tick(), INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    const onFocus = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return null;
}
