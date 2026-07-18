"use client";

import { CheckCircle2, ExternalLink, Hourglass, LockKeyhole, Radio, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api";
import { secondsUntil } from "@/lib/format";
import { arcDeployment } from "@/lib/onchain";
import { settlementPhase } from "@/lib/positions";
import type { Market } from "@/lib/types";

type Props = {
  market: Market;
  className?: string;
};

type FeedSnapshot = {
  btc?: number;
  weather?: number;
  updatedAt?: string;
};

export function MarketLifecycleStage({ market, className = "" }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState(market);
  const [feed, setFeed] = useState<FeedSnapshot>({});
  const [resolvedFlash, setResolvedFlash] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setLive(market);
  }, [market]);

  // Poll market status for resolve moment
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(apiUrl(`/api/markets/${encodeURIComponent(market.id)}`), { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as Market;
        if (cancelled) return;
        setLive((prev) => {
          if (prev.status !== "RESOLVED" && next.status === "RESOLVED") {
            setResolvedFlash(true);
            window.setTimeout(() => setResolvedFlash(false), 4200);
          }
          return next;
        });
      } catch {
        // ignore
      }
    };
    void tick();
    // Fast poll so lock → observe → resolve advances without full page refresh.
    const id = window.setInterval(() => void tick(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [market.id]);

  // Live reference for observation compare
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(apiUrl("/api/demo-data"), { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as {
          btcUsd?: { price?: number };
          londonWeather?: { temperatureC?: number };
          updatedAt?: string;
        };
        if (cancelled) return;
        setFeed({
          btc: data.btcUsd?.price,
          weather: data.londonWeather?.temperatureC,
          updatedAt: data.updatedAt
        });
      } catch {
        // ignore
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const timePhase = settlementPhase(now, live.lockTime, live.observationEnd);
  const isResolved = live.status === "RESOLVED";
  const isCancelled = live.status === "CANCELLED";

  // Prefer on-chain status so UI advances even if timestamps lag.
  const phaseName =
    isResolved || isCancelled
      ? timePhase.phase
      : live.status === "LOCKED"
        ? now >= Date.parse(live.observationEnd)
          ? "ready"
          : "observation"
        : timePhase.phase;

  const phaseTarget =
    phaseName === "open"
      ? live.lockTime
      : phaseName === "observation"
        ? live.observationEnd
        : timePhase.target;
  const seconds = phaseTarget ? secondsUntil(phaseTarget) : 0;
  const clock = formatClock(seconds);

  const threshold = useMemo(() => parseThreshold(live.question, live.demoRole, live.category), [live]);
  const liveValue = useMemo(() => {
    if (live.demoRole === "btc_price" || live.category === "crypto-candle") return feed.btc;
    if (live.demoRole === "london_weather" || live.category === "weather") return feed.weather;
    return undefined;
  }, [live, feed]);

  const compareLabel = useMemo(() => {
    if (liveValue === undefined || threshold === null) return null;
    if (live.demoRole === "btc_price" || live.category === "crypto-candle") {
      return {
        live: `BTC $${Math.round(liveValue).toLocaleString("en-US")}`,
        thr: `threshold $${Math.round(threshold).toLocaleString("en-US")}`,
        ahead: liveValue > threshold
      };
    }
    return {
      live: `${liveValue.toFixed(1)}°C`,
      thr: `threshold ${threshold.toFixed(1)}°C`,
      ahead: liveValue >= threshold
    };
  }, [live, liveValue, threshold]);

  const stages = [
    { key: "open", label: "Open", done: phaseName !== "open" || isResolved || isCancelled },
    { key: "lock", label: "Lock", done: phaseName === "observation" || phaseName === "ready" || isResolved || isCancelled },
    { key: "obs", label: "Observe", done: phaseName === "ready" || isResolved || isCancelled },
    { key: "resolve", label: "Resolve", done: isResolved || isCancelled },
    { key: "claim", label: "Claim", done: isResolved }
  ];

  const headline = isResolved
    ? `RESOLVED: ${live.winningOutcome ?? "—"} ✓`
    : isCancelled
      ? "CANCELLED"
      : phaseName === "open"
        ? `LOCK in ${clock}`
        : phaseName === "observation"
          ? `OBSERVATION ${clock}`
          : phaseName === "ready"
            ? "READY TO CLAIM"
            : timePhase.label;

  const Icon = isResolved
    ? CheckCircle2
    : phaseName === "observation"
      ? Radio
      : phaseName === "ready"
        ? Hourglass
        : phaseName === "open"
          ? LockKeyhole
          : Sparkles;

  const explorerMarket = live.contractAddress || live.id;
  const explorerHref =
    explorerMarket.startsWith("0x") && explorerMarket.length >= 42
      ? `${arcDeployment.explorerUrl}/address/${explorerMarket}`
      : null;

  return (
    <section
      className={`lifecycleStage phase-${isResolved ? "resolved" : phaseName} ${resolvedFlash ? "isFlash" : ""} ${className}`.trim()}
    >
      <div className="lifecycleStageTop">
        <div className="lifecycleStageBadge">
          <Icon size={18} aria-hidden />
          <span>Live cycle · ~2 min</span>
        </div>
        <strong className={`lifecycleHeadline ${isResolved ? "isResolved" : ""}`}>{headline}</strong>
        {!isResolved && !isCancelled ? (
          <p className="lifecycleDetail">
            {phaseName === "open" && "Entries open. After lock, observation runs, then auto-resolve."}
            {phaseName === "observation" && "Trading closed. Live feed vs threshold decides YES/NO."}
            {phaseName === "ready" && "Observation ended — claim winning tickets in Portfolio."}
            {phaseName === "unknown" && timePhase.detail}
          </p>
        ) : isResolved ? (
          <p className="lifecycleDetail">
            Winning side: <strong>{live.winningOutcome ?? "—"}</strong>
            {explorerHref ? (
              <>
                {" · "}
                <a href={explorerHref} target="_blank" rel="noreferrer" className="lifecycleTxLink">
                  Market on ArcScan <ExternalLink size={13} aria-hidden />
                </a>
              </>
            ) : null}
          </p>
        ) : (
          <p className="lifecycleDetail">Market cancelled — stake refund path in Portfolio.</p>
        )}
      </div>

      <ol className="lifecycleTrack" aria-label="Market lifecycle">
        {stages.map((stage, index) => {
          const active =
            (!isResolved && !isCancelled &&
              ((stage.key === "open" && phaseName === "open") ||
                (stage.key === "lock" && phaseName === "observation") ||
                (stage.key === "obs" && phaseName === "observation") ||
                (stage.key === "resolve" && phaseName === "ready") ||
                (stage.key === "claim" && phaseName === "ready"))) ||
            (isResolved && stage.key === "claim");
          return (
            <li key={stage.key} className={`${stage.done ? "isDone" : ""} ${active ? "isActive" : ""}`.trim()}>
              <span className="lifecycleDot">{index + 1}</span>
              <span>{stage.label}</span>
            </li>
          );
        })}
      </ol>

      {(phaseName === "observation" || phaseName === "ready") && compareLabel ? (
        <div className={`lifecycleCompare ${compareLabel.ahead ? "isYesLean" : "isNoLean"}`}>
          <div>
            <span>Live feed</span>
            <strong>{compareLabel.live}</strong>
          </div>
          <div className="lifecycleCompareVs">vs</div>
          <div>
            <span>Threshold</span>
            <strong>{compareLabel.thr}</strong>
          </div>
          <p className="lifecycleCompareHint">
            {compareLabel.ahead ? "Feed above threshold → YES lean" : "Feed at/below threshold → NO lean"}
          </p>
        </div>
      ) : null}

      {isResolved && resolvedFlash ? (
        <div className="lifecycleResolveBurst" role="status">
          <CheckCircle2 size={22} aria-hidden />
          RESOLVED: {live.winningOutcome ?? "—"} ✓
        </div>
      ) : null}
    </section>
  );
}

function formatClock(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0:00";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function parseThreshold(question: string, role?: string, category?: string): number | null {
  if (role === "btc_price" || category === "crypto-candle") {
    const m = question.match(/above\s+\$?([\d,]+(?:\.\d+)?)/i);
    if (!m) return null;
    return Number(m[1].replace(/,/g, ""));
  }
  if (role === "london_weather" || category === "weather") {
    const m = question.match(/at least\s+(-?[\d.]+)\s*C/i);
    if (!m) return null;
    return Number(m[1]);
  }
  return null;
}
