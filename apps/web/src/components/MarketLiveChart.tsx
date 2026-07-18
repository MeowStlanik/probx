"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { apiUrl } from "@/lib/api";
import type { Market } from "@/lib/types";

type Point = { t: number; v: number };

type MarketLiveChartProps = {
  market: Market;
  feed: "btc" | "weather";
};

const POLL_MS = { btc: 1_200, weather: 3_000 } as const;

/**
 * Observation-window chart only.
 * Price path that decides YES/NO starts at observationStart — not during Open/Lock.
 * Before observe: waiting state. During: live path vs threshold.
 */
export function MarketLiveChart({ market, feed }: MarketLiveChartProps) {
  const [price, setPrice] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const histRef = useRef<Point[]>([]);
  const [points, setPoints] = useState<Point[]>([]);

  const obsStart = Date.parse(market.observationStart || "") || 0;
  const obsEnd = Date.parse(market.observationEnd || "") || 0;
  const threshold = useMemo(() => thresholdFromQuestion(market), [market]);

  const phase = useMemo(() => {
    if (!obsStart || !obsEnd) return "unknown" as const;
    if (now < obsStart) return "before" as const;
    if (now >= obsEnd) return "after" as const;
    return "live" as const;
  }, [now, obsStart, obsEnd]);

  const pull = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/demo-data"), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        btcUsd?: { price: number; updatedAt: string; history?: Array<{ value: number; at: number }> };
        londonWeather?: {
          temperatureC: number;
          updatedAt: string;
          history?: Array<{ value: number; at: number }>;
        };
      };

      let value: number | undefined;
      let at: number;
      let serverHist: Point[] = [];

      if (feed === "btc" && data.btcUsd && Number.isFinite(data.btcUsd.price)) {
        value = data.btcUsd.price;
        at = Date.parse(data.btcUsd.updatedAt) || Date.now();
        serverHist = normalize(data.btcUsd.history);
      } else if (
        feed === "weather" &&
        data.londonWeather &&
        Number.isFinite(data.londonWeather.temperatureC)
      ) {
        value = data.londonWeather.temperatureC;
        at = Date.parse(data.londonWeather.updatedAt) || Date.now();
        serverHist = normalize(data.londonWeather.history);
      } else {
        throw new Error("Feed unavailable");
      }

      setPrice(value);
      setError(null);

      const start = Date.parse(market.observationStart || "") || 0;
      const end = Date.parse(market.observationEnd || "") || 0;
      const tNow = Date.now();

      // Only collect / show samples inside the observation window.
      if (!start || tNow < start) {
        histRef.current = [];
        setPoints([]);
        return;
      }

      const windowEnd = end && tNow > end ? end : tNow;
      const tick: Point = { t: Math.min(at, windowEnd), v: value };

      let merged: Point[];
      if (serverHist.length) {
        merged = serverHist.filter((p) => p.t >= start && p.t <= windowEnd);
      } else {
        merged = histRef.current.filter((p) => p.t >= start && p.t <= windowEnd);
      }

      if (tick.t >= start) {
        merged = append(merged, tick, feed === "weather" ? 2_000 : 800);
      }

      // Anchor first point at observation open so the path "starts" there.
      if (merged.length === 1) {
        merged = [{ t: start, v: merged[0].v }, merged[0]];
      } else if (merged.length === 0) {
        merged = [
          { t: start, v: value },
          { t: Math.max(start + 1, tick.t), v: value }
        ];
      } else if (merged[0].t > start + 2_000) {
        merged = [{ t: start, v: merged[0].v }, ...merged];
      }

      histRef.current = merged;
      setPoints(merged);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feed error");
    }
  }, [feed, market.observationStart, market.observationEnd]);

  useEffect(() => {
    void pull();
    const poll = window.setInterval(() => void pull(), POLL_MS[feed]);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [feed, pull]);

  // Reset series when market / observation window changes
  useEffect(() => {
    histRef.current = [];
    setPoints([]);
  }, [market.id, market.observationStart]);

  const isBtc = feed === "btc";
  const fmt = isBtc ? fmtUsd : fmtTemp;
  const chart = useMemo(() => buildChart(points, threshold, obsStart, obsEnd || now), [points, threshold, obsStart, obsEnd, now]);

  const vsThreshold =
    price != null && threshold != null
      ? price >= threshold
        ? "above"
        : "below"
      : null;

  const secToObs = Math.max(0, Math.ceil((obsStart - now) / 1000));
  const secLeft = Math.max(0, Math.ceil((obsEnd - now) / 1000));

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: "#5B6A7D", fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase" }}>
            {isBtc ? "BTC/USD · Coinbase" : "London temp · Open-Meteo"} · observation only
          </div>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 28,
              fontWeight: 600,
              color: "#0B1622",
              marginTop: 4
            }}
          >
            {price != null ? fmt(price) : "—"}
          </div>
          {threshold != null ? (
            <div style={{ marginTop: 6, fontSize: 12.5, color: "#5B6A7D", lineHeight: 1.4 }}>
              {isBtc ? (
                <>
                  YES if BTC is <strong style={{ color: "#1F9D6B" }}>≥ {fmt(threshold)}</strong> when observation ends
                </>
              ) : (
                <>
                  YES if London temp is <strong style={{ color: "#1F9D6B" }}>≥ {fmt(threshold)}</strong> when
                  observation ends
                </>
              )}
              {vsThreshold ? (
                <span style={{ marginLeft: 8, fontWeight: 600, color: vsThreshold === "above" ? "#1F9D6B" : "#D6544A" }}>
                  · now {vsThreshold} threshold
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <PhaseBadge phase={phase} secToObs={secToObs} secLeft={secLeft} />
      </div>

      <div
        style={{
          position: "relative",
          width: "100%",
          height: 220,
          marginTop: 14,
          background: "#F6F8FA",
          border: "1px solid #E4E9F0",
          borderRadius: 12,
          overflow: "hidden"
        }}
      >
        {phase === "before" ? (
          <WaitingPanel
            title="Chart starts at observation"
            body={
              isBtc
                ? `Betting is open now. BTC/USD that settles this market is tracked only during observation — starting in ${fmtClock(secToObs)}.`
                : `Betting is open now. London temperature that settles this market is tracked only during observation — starting in ${fmtClock(secToObs)}.`
            }
            threshold={threshold != null ? fmt(threshold) : null}
          />
        ) : chart ? (
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${chart.W} ${chart.H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={isBtc ? "Observation window BTC chart" : "Observation window London temperature chart"}
            style={{ display: "block" }}
          >
            <defs>
              <linearGradient id="obsFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chart.lineColor} stopOpacity="0.2" />
                <stop offset="100%" stopColor={chart.lineColor} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((p) => (
              <line
                key={p}
                x1={chart.padL}
                x2={chart.W - chart.padR}
                y1={chart.padT + p * chart.innerH}
                y2={chart.padT + p * chart.innerH}
                stroke="#E4E9F0"
                strokeWidth={1}
              />
            ))}
            {chart.thresholdY != null ? (
              <g>
                <line
                  x1={chart.padL}
                  x2={chart.W - chart.padR}
                  y1={chart.thresholdY}
                  y2={chart.thresholdY}
                  stroke="#7C5CFF"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                />
              </g>
            ) : null}
            <path d={chart.area} fill="url(#obsFill)" />
            <path
              d={chart.line}
              fill="none"
              stroke={chart.lineColor}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {chart.last ? (
              <circle
                cx={chart.last.x}
                cy={chart.last.y}
                r={4.5}
                fill={chart.lineColor}
                stroke="#fff"
                strokeWidth={2}
              />
            ) : null}
          </svg>
        ) : (
          <WaitingPanel
            title={error ? `Feed: ${error}` : "Waiting for first observation print…"}
            body="Samples are recorded only after observation starts."
            threshold={threshold != null ? fmt(threshold) : null}
          />
        )}

        {chart && phase !== "before" ? (
          <>
            <span style={yLabelStyle(8)}>{fmt(chart.max)}</span>
            <span style={yLabelStyle(undefined, 8)}>{fmt(chart.min)}</span>
            {threshold != null ? (
              <span
                style={{
                  position: "absolute",
                  right: 10,
                  top: chart.thresholdY != null ? Math.max(8, Math.min(190, chart.thresholdY - 8)) : 8,
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: "#7C5CFF",
                  background: "rgba(255,255,255,.92)",
                  border: "1px solid #E0D8FF",
                  borderRadius: 6,
                  padding: "2px 6px",
                  fontFamily: "'IBM Plex Mono', monospace"
                }}
              >
                {isBtc ? "YES ≥" : "YES ≥"} {fmt(threshold)}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 10,
          fontSize: 12,
          color: "#5B6A7D",
          flexWrap: "wrap"
        }}
      >
        <span>
          {phase === "before"
            ? "No observation samples yet"
            : phase === "live"
              ? `${points.length} prints this window`
              : `${points.length} prints · window closed`}
        </span>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
          {obsStart
            ? `${new Date(obsStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} → ${
                obsEnd
                  ? new Date(obsEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                  : "…"
              }`
            : "—"}
        </span>
      </div>
    </div>
  );
}

function PhaseBadge({
  phase,
  secToObs,
  secLeft
}: {
  phase: "before" | "live" | "after" | "unknown";
  secToObs: number;
  secLeft: number;
}) {
  if (phase === "before") {
    return (
      <span style={badgeStyle("#EAF2FB", "#2775CA")}>
        Observation in {fmtClock(secToObs)}
      </span>
    );
  }
  if (phase === "live") {
    return (
      <span style={badgeStyle("#E7F5EF", "#1F9D6B")}>
        Observing · {fmtClock(secLeft)} left
      </span>
    );
  }
  if (phase === "after") {
    return <span style={badgeStyle("#F6F8FA", "#5B6A7D")}>Observation ended</span>;
  }
  return null;
}

function WaitingPanel({
  title,
  body,
  threshold
}: {
  title: string;
  body: string;
  threshold: string | null;
}) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 20px",
        textAlign: "center",
        gap: 8
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: "#0B1622" }}>{title}</div>
      <div style={{ fontSize: 13, color: "#5B6A7D", maxWidth: 360, lineHeight: 1.45 }}>{body}</div>
      {threshold ? (
        <div
          style={{
            marginTop: 6,
            fontSize: 12,
            fontFamily: "'IBM Plex Mono', monospace",
            color: "#7C5CFF",
            fontWeight: 600
          }}
        >
          Threshold {threshold}
        </div>
      ) : null}
    </div>
  );
}

function badgeStyle(bg: string, fg: string): CSSProperties {
  return {
    display: "inline-block",
    fontSize: 12,
    fontWeight: 600,
    color: fg,
    background: bg,
    borderRadius: 8,
    padding: "6px 10px",
    whiteSpace: "nowrap"
  };
}

function yLabelStyle(top?: number, bottom?: number): CSSProperties {
  return {
    position: "absolute",
    left: 10,
    top,
    bottom,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 10,
    color: "#5B6A7D"
  };
}

function buildChart(points: Point[], threshold: number | undefined, t0: number, t1: number) {
  if (points.length < 2 || !t0) return null;
  const W = 640;
  const H = 220;
  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 16;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const vals = points.map((p) => p.v);
  if (threshold != null && Number.isFinite(threshold)) vals.push(threshold);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  const span = max - min;
  const pad = span < 1e-9 ? Math.max(Math.abs(max) * 0.002, max > 50 ? 8 : 0.3) : Math.max(span * 0.14, 0.01);
  min -= pad;
  max += pad;
  const range = max - min || 1;
  const tSpan = Math.max(t1 - t0, 1);

  const coords = points.map((p) => ({
    x: padL + ((p.t - t0) / tSpan) * innerW,
    y: padT + (1 - (p.v - min) / range) * innerH
  }));

  const lastPt = points[points.length - 1];
  const firstPt = points[0];
  const up = lastPt.v >= firstPt.v;
  const lineColor = up ? "#1F9D6B" : "#D6544A";

  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];
  const area = `${line} L${last.x.toFixed(1)} ${(H - padB).toFixed(1)} L${coords[0].x.toFixed(1)} ${(H - padB).toFixed(1)} Z`;

  let thresholdY: number | null = null;
  if (threshold != null && Number.isFinite(threshold)) {
    thresholdY = padT + (1 - (threshold - min) / range) * innerH;
  }

  return { W, H, padL, padR, padT, padB, innerW, innerH, line, area, last, min, max, thresholdY, lineColor };
}

function normalize(raw?: Array<{ value: number; at: number }>): Point[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => Number.isFinite(p?.value) && Number.isFinite(p?.at))
    .map((p) => ({ t: p.at, v: p.value }))
    .sort((a, b) => a.t - b.t);
}

function append(hist: Point[], tick: Point, minGap: number): Point[] {
  if (!hist.length) return [tick];
  const last = hist[hist.length - 1];
  if (tick.t < last.t - 2_000) return hist;
  if (tick.t - last.t < minGap) {
    return [...hist.slice(0, -1), { t: Math.max(last.t, tick.t), v: tick.v }];
  }
  return [...hist, tick];
}

function thresholdFromQuestion(market: Market): number | undefined {
  const q = market.question || "";
  if (market.demoRole === "btc_price" || market.category === "crypto-candle") {
    const m =
      q.match(/(?:at or above|above|≥)\s+\$?([\d,]+(?:\.\d+)?)/i) ||
      q.match(/\$([\d,]+(?:\.\d+)?)/);
    if (!m) return undefined;
    const v = Number(m[1].replace(/,/g, ""));
    return Number.isFinite(v) ? v : undefined;
  }
  if (market.demoRole === "london_weather" || market.category === "weather") {
    const m =
      q.match(/at least\s+(-?[\d.]+)\s*°?C/i) ||
      q.match(/≥\s*(-?[\d.]+)\s*°?C/i) ||
      q.match(/(-?[\d.]+)\s*°C/i);
    if (!m) return undefined;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

function fmtUsd(v: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(v);
}

function fmtTemp(v: number) {
  return `${v.toFixed(2)}°C`;
}

function fmtClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
