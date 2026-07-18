"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "@/lib/api";
import type { Market } from "@/lib/types";

type Point = { t: number; v: number };

type MarketLiveChartProps = {
  market: Market;
  feed: "btc" | "weather";
};

const POLL_MS = { btc: 1_200, weather: 3_000 } as const;
const CAP = 90;

/**
 * Self-contained live chart for market detail.
 * Inline styles only — no dependency on legacy LiveReferencePanel CSS that
 * collapsed the SVG / hid axes.
 */
export function MarketLiveChart({ market, feed }: MarketLiveChartProps) {
  const [points, setPoints] = useState<Point[]>([]);
  const [price, setPrice] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const histRef = useRef<Point[]>([]);

  const threshold = useMemo(() => thresholdFromQuestion(market), [market]);

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
      } else if (feed === "weather" && data.londonWeather && Number.isFinite(data.londonWeather.temperatureC)) {
        value = data.londonWeather.temperatureC;
        at = Date.parse(data.londonWeather.updatedAt) || Date.now();
        serverHist = normalize(data.londonWeather.history);
      } else {
        throw new Error("Feed unavailable");
      }

      const tick: Point = { t: at, v: value };
      let next: Point[];
      if (serverHist.length >= 2) {
        next = append(serverHist, tick, feed === "weather" ? 2_000 : 500);
      } else if (histRef.current.length >= 1) {
        next = append(histRef.current, tick, feed === "weather" ? 2_000 : 500);
      } else {
        next = [
          { t: at - 60_000, v: value },
          tick
        ];
      }
      next = next.slice(-CAP);
      histRef.current = next;
      setPoints(next);
      setPrice(value);
      setUpdatedAt(new Date(at).toLocaleTimeString());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feed error");
    }
  }, [feed]);

  useEffect(() => {
    void pull();
    const id = window.setInterval(() => void pull(), POLL_MS[feed]);
    return () => window.clearInterval(id);
  }, [feed, pull]);

  const chart = useMemo(() => buildChart(points, threshold), [points, threshold]);
  const isBtc = feed === "btc";
  const fmt = isBtc ? fmtUsd : fmtTemp;
  const delta =
    points.length >= 2 ? points[points.length - 1].v - points[Math.max(0, points.length - 8)].v : 0;
  const up = delta > (isBtc ? 0.05 : 0.02);
  const down = delta < -(isBtc ? 0.05 : 0.02);
  const lineColor = up ? "#1F9D6B" : down ? "#D6544A" : "#2775CA";

  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 12
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: "#5B6A7D", fontWeight: 500 }}>
            {isBtc ? "BTC/USD · Coinbase" : "London temp · Open-Meteo"}
          </div>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 28,
              fontWeight: 600,
              color: "#0B1622",
              marginTop: 2,
              letterSpacing: "-0.02em"
            }}
          >
            {price != null ? fmt(price) : "—"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <span
            style={{
              display: "inline-block",
              fontSize: 11.5,
              fontWeight: 600,
              color: up ? "#1F9D6B" : down ? "#D6544A" : "#5B6A7D",
              background: up ? "#E7F5EF" : down ? "#FBEDEB" : "#F6F8FA",
              borderRadius: 6,
              padding: "4px 8px"
            }}
          >
            {up ? "▲" : down ? "▼" : "●"}{" "}
            {points.length >= 2
              ? `${delta >= 0 ? "+" : ""}${isBtc ? delta.toFixed(2) : delta.toFixed(2) + "°"}`
              : "flat"}
          </span>
          {threshold != null ? (
            <div style={{ fontSize: 11, color: "#5B6A7D", marginTop: 6, fontFamily: "'IBM Plex Mono', monospace" }}>
              threshold {fmt(threshold)}
            </div>
          ) : null}
        </div>
      </div>

      <div
        style={{
          position: "relative",
          width: "100%",
          height: 200,
          background: "#F6F8FA",
          border: "1px solid #E4E9F0",
          borderRadius: 12,
          overflow: "hidden"
        }}
      >
        {chart ? (
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${chart.W} ${chart.H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Live price chart"
            style={{ display: "block" }}
          >
            <defs>
              <linearGradient id="mktChartFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity="0.22" />
                <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {/* grid */}
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
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                />
              </g>
            ) : null}
            <path d={chart.area} fill="url(#mktChartFill)" />
            <path
              d={chart.line}
              fill="none"
              stroke={lineColor}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {chart.last ? (
              <circle cx={chart.last.x} cy={chart.last.y} r={4} fill={lineColor} stroke="#fff" strokeWidth={2} />
            ) : null}
          </svg>
        ) : (
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#5B6A7D",
              fontSize: 13
            }}
          >
            {error ? `Feed: ${error}` : "Loading chart…"}
          </div>
        )}

        {chart ? (
          <>
            <span
              style={{
                position: "absolute",
                top: 8,
                left: 10,
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 10,
                color: "#5B6A7D"
              }}
            >
              {fmt(chart.max)}
            </span>
            <span
              style={{
                position: "absolute",
                bottom: 8,
                left: 10,
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 10,
                color: "#5B6A7D"
              }}
            >
              {fmt(chart.min)}
            </span>
          </>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          fontSize: 11.5,
          color: "#5B6A7D"
        }}
      >
        <span>{points.length} samples</span>
        <span>{updatedAt ? `Updated ${updatedAt}` : "—"}</span>
        {threshold != null ? (
          <span style={{ color: "#7C5CFF", fontWeight: 600 }}>threshold {fmt(threshold)}</span>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}

function buildChart(points: Point[], threshold?: number) {
  if (points.length < 2) return null;
  const W = 640;
  const H = 200;
  const padL = 8;
  const padR = 8;
  const padT = 16;
  const padB = 16;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const vals = points.map((p) => p.v);
  if (threshold != null && Number.isFinite(threshold)) vals.push(threshold);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  const span = max - min;
  const pad = span < 1e-9 ? Math.max(Math.abs(max) * 0.002, max > 50 ? 8 : 0.3) : Math.max(span * 0.12, span * 0.02);
  min -= pad;
  max += pad;
  const range = max - min || 1;

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const tSpan = Math.max(t1 - t0, 1);

  const coords = points.map((p) => ({
    x: padL + ((p.t - t0) / tSpan) * innerW,
    y: padT + (1 - (p.v - min) / range) * innerH
  }));

  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];
  const area = `${line} L${last.x.toFixed(1)} ${(H - padB).toFixed(1)} L${coords[0].x.toFixed(1)} ${(H - padB).toFixed(1)} Z`;

  let thresholdY: number | null = null;
  if (threshold != null && Number.isFinite(threshold)) {
    thresholdY = padT + (1 - (threshold - min) / range) * innerH;
  }

  return { W, H, padL, padR, padT, padB, innerW, innerH, line, area, last, min, max, thresholdY };
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
      q.match(/above\s+\$?([\d,]+(?:\.\d+)?)/i) ||
      q.match(/≥\s*\$?([\d,]+(?:\.\d+)?)/i) ||
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
