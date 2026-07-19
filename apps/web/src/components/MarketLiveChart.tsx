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

const UP = "#1F9D6B";
const DOWN = "#D6544A";
const FLAT = "#5B6A7D";
const START = "#7C5CFF";

/**
 * Observation-window chart.
 *
 * The price path that decides YES/NO runs during the observation window only.
 * At observation open we lock a horizontal "start" reference line. The live path
 * is drawn above or below that line, and once the window closes we show the
 * verdict: closed above = YES, closed below = NO.
 */
export function MarketLiveChart({ market, feed }: MarketLiveChartProps) {
  const [price, setPrice] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const histRef = useRef<Point[]>([]);
  const startRef = useRef<number | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [startValue, setStartValue] = useState<number | null>(null);

  const obsStart = Date.parse(market.observationStart || "") || 0;
  const obsEnd = Date.parse(market.observationEnd || "") || 0;

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

      // Nothing to plot until the observation window opens.
      if (!start || tNow < start) {
        histRef.current = [];
        startRef.current = null;
        setPoints([]);
        setStartValue(null);
        return;
      }

      const windowEnd = end && tNow > end ? end : tNow;
      const tick: Point = { t: Math.min(at, windowEnd), v: value };

      // Prefer server history inside the window; fall back to locally collected ticks.
      let merged: Point[];
      if (serverHist.length) {
        merged = serverHist.filter((p) => p.t >= start && p.t <= windowEnd);
      } else {
        merged = histRef.current.filter((p) => p.t >= start && p.t <= windowEnd);
      }

      if (tick.t >= start && tick.t <= windowEnd) {
        merged = append(merged, tick, feed === "weather" ? 2_000 : 800);
      }

      // Anchor the first plotted point exactly at observation open so the path
      // visibly "starts" on the start line.
      if (merged.length === 1) {
        merged = [{ t: start, v: merged[0]!.v }, merged[0]!];
      } else if (merged.length === 0) {
        merged = [
          { t: start, v: value },
          { t: Math.max(start + 1, tick.t), v: value }
        ];
      } else if (merged[0]!.t > start + 2_000) {
        merged = [{ t: start, v: merged[0]!.v }, ...merged];
      }

      // Lock the start reference once, at the value of the first sample in the window.
      if (startRef.current == null) {
        startRef.current = merged[0]!.v;
        setStartValue(startRef.current);
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

  // Reset the series when the market or observation window changes.
  useEffect(() => {
    histRef.current = [];
    startRef.current = null;
    setPoints([]);
    setStartValue(null);
  }, [market.id, market.observationStart]);

  const isBtc = feed === "btc";
  const fmt = isBtc ? fmtUsd : fmtTemp;

  const chart = useMemo(
    () => buildChart(points, startValue ?? undefined, obsStart, obsEnd || now),
    [points, startValue, obsStart, obsEnd, now]
  );

  const lastValue = points.length ? points[points.length - 1]!.v : price;
  const delta = startValue != null && lastValue != null ? lastValue - startValue : null;
  const dir: "above" | "below" | "flat" | null =
    delta == null ? null : delta > 0 ? "above" : delta < 0 ? "below" : "flat";

  const secToObs = Math.max(0, Math.ceil((obsStart - now) / 1000));
  const secLeft = Math.max(0, Math.ceil((obsEnd - now) / 1000));

  const verdict =
    phase === "after" && dir
      ? dir === "above"
        ? "YES"
        : dir === "below"
          ? "NO"
          : "TIE"
      : null;

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: FLAT, fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase" }}>
            {isBtc ? "BTC/USD · Coinbase" : "London temp · Open-Meteo"} · observation window
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 28,
                fontWeight: 600,
                color: "#0B1622"
              }}
            >
              {lastValue != null ? fmt(lastValue) : "—"}
            </span>
            {delta != null && dir && dir !== "flat" ? (
              <span
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 14,
                  fontWeight: 600,
                  color: dir === "above" ? UP : DOWN
                }}
              >
                {delta > 0 ? "▲" : "▼"} {fmtDelta(delta, isBtc)}
              </span>
            ) : null}
          </div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: FLAT, lineHeight: 1.4 }}>
            {isBtc
              ? "YES if BTC closes higher than the start line"
              : "YES if London temp closes higher than the start line"}
            {startValue != null ? (
              <>
                {" "}
                <strong style={{ color: START }}>· start {fmt(startValue)}</strong>
              </>
            ) : phase === "before" ? (
              <span> · start locks when observation begins</span>
            ) : null}
          </div>
        </div>
        <PhaseBadge phase={phase} secToObs={secToObs} secLeft={secLeft} verdict={verdict} />
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
                ? `Locks a start line and tracks BTC above or below it — begins in ${fmtClock(secToObs)}.`
                : `Locks a start line and tracks London temp above or below it — begins in ${fmtClock(secToObs)}.`
            }
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
              <linearGradient id={`fillAbove-${feed}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={UP} stopOpacity="0.22" />
                <stop offset="100%" stopColor={UP} stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id={`fillBelow-${feed}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={DOWN} stopOpacity="0.02" />
                <stop offset="100%" stopColor={DOWN} stopOpacity="0.22" />
              </linearGradient>
              {chart.startY != null ? (
                <>
                  <clipPath id={`clipAbove-${feed}`}>
                    <rect x="0" y="0" width={chart.W} height={chart.startY} />
                  </clipPath>
                  <clipPath id={`clipBelow-${feed}`}>
                    <rect x="0" y={chart.startY} width={chart.W} height={chart.H - chart.startY} />
                  </clipPath>
                </>
              ) : null}
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

            {/* Area, split at the start line so the fill shows which side the path is on. */}
            {chart.startY != null ? (
              <>
                <path d={chart.area} fill={`url(#fillAbove-${feed})`} clipPath={`url(#clipAbove-${feed})`} />
                <path d={chart.area} fill={`url(#fillBelow-${feed})`} clipPath={`url(#clipBelow-${feed})`} />
              </>
            ) : (
              <path d={chart.area} fill={`url(#fillAbove-${feed})`} />
            )}

            {/* Start reference line — locked at observation open. */}
            {chart.startY != null ? (
              <line
                x1={chart.padL}
                x2={chart.W - chart.padR}
                y1={chart.startY}
                y2={chart.startY}
                stroke={START}
                strokeWidth={2}
                strokeDasharray="6 4"
              />
            ) : null}

            {/* Live path, colored by whether it is currently above or below start. */}
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
          />
        )}

        {chart && phase !== "before" ? (
          <>
            <span style={yLabelStyle(8)}>{fmt(chart.max)}</span>
            <span style={yLabelStyle(undefined, 8)}>{fmt(chart.min)}</span>
            {startValue != null && chart.startY != null ? (
              <span
                style={{
                  position: "absolute",
                  right: 10,
                  top: Math.max(8, Math.min(190, chart.startY - 8)),
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: START,
                  background: "rgba(255,255,255,.92)",
                  border: "1px solid #E0D8FF",
                  borderRadius: 6,
                  padding: "2px 6px",
                  fontFamily: "'IBM Plex Mono', monospace"
                }}
              >
                start {fmt(startValue)}
              </span>
            ) : null}

            {verdict ? (
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  top: 12,
                  transform: "translateX(-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12.5,
                  fontWeight: 700,
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: "#fff",
                  background: verdict === "YES" ? UP : verdict === "NO" ? DOWN : FLAT,
                  boxShadow: "0 4px 12px rgba(11,22,34,.14)"
                }}
              >
                {verdict === "TIE" ? "CLOSED FLAT" : `CLOSED ${dir?.toUpperCase()} → ${verdict}`}
              </div>
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
          color: FLAT,
          flexWrap: "wrap"
        }}
      >
        <span>
          {phase === "before"
            ? "No observation samples yet"
            : phase === "live"
              ? `${points.length} prints · live`
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
  secLeft,
  verdict
}: {
  phase: "before" | "live" | "after" | "unknown";
  secToObs: number;
  secLeft: number;
  verdict: string | null;
}) {
  if (phase === "before") {
    return <span style={badgeStyle("#EAF2FB", "#2775CA")}>Observation in {fmtClock(secToObs)}</span>;
  }
  if (phase === "live") {
    return <span style={badgeStyle("#E7F5EF", UP)}>Observing · {fmtClock(secLeft)} left</span>;
  }
  if (phase === "after") {
    if (verdict === "YES") return <span style={badgeStyle("#E7F5EF", UP)}>Closed above · YES</span>;
    if (verdict === "NO") return <span style={badgeStyle("#FBEAE8", DOWN)}>Closed below · NO</span>;
    return <span style={badgeStyle("#F6F8FA", FLAT)}>Observation ended</span>;
  }
  return null;
}

function WaitingPanel({ title, body }: { title: string; body: string }) {
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
      <div style={{ fontSize: 13, color: FLAT, maxWidth: 360, lineHeight: 1.45 }}>{body}</div>
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
    color: FLAT
  };
}

function buildChart(points: Point[], startValue: number | undefined, t0: number, t1: number) {
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
  if (startValue != null && Number.isFinite(startValue)) vals.push(startValue);
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

  const lastPt = points[points.length - 1]!;
  const base = startValue ?? points[0]!.v;
  const up = lastPt.v >= base;
  const lineColor = up ? UP : DOWN;

  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1]!;
  const area = `${line} L${last.x.toFixed(1)} ${(H - padB).toFixed(1)} L${coords[0]!.x.toFixed(1)} ${(H - padB).toFixed(1)} Z`;

  let startY: number | null = null;
  if (startValue != null && Number.isFinite(startValue)) {
    startY = padT + (1 - (startValue - min) / range) * innerH;
  }

  return { W, H, padL, padR, padT, padB, innerW, innerH, line, area, last, min, max, startY, lineColor };
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
  const last = hist[hist.length - 1]!;
  if (tick.t < last.t - 2_000) return hist;
  if (tick.t - last.t < minGap) {
    return [...hist.slice(0, -1), { t: Math.max(last.t, tick.t), v: tick.v }];
  }
  return [...hist, tick];
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

function fmtDelta(delta: number, isBtc: boolean) {
  const sign = delta > 0 ? "+" : "−";
  const abs = Math.abs(delta);
  return isBtc
    ? `${sign}${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs)}`
    : `${sign}${abs.toFixed(2)}°C`;
}

function fmtClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
