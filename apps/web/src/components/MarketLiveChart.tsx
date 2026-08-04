"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { fetchMarketObservation } from "@/lib/api";
import type { Market, MarketObservationEvidence, MarketObservationPoint, Outcome } from "@/lib/types";

type Point = { t: number; v: number };

type MarketLiveChartProps = {
  market: Market;
  feed: "btc" | "weather";
};

const POLL_MS = { btc: 3_000, weather: 15_000 } as const;

const UP = "#1F9D6B";
const DOWN = "#D6544A";
const FLAT = "#5B6A7D";
const START = "#7C5CFF";
const WARN = "#9A6700";

/**
 * Resolver-aligned observation chart.
 *
 * This component deliberately does not infer a final result from a generic market
 * feed or from browser-local samples. It renders the durable raw ticks selected by
 * the same resolver that writes the on-chain winner:
 *   - start = nearest durable tick to observationStart
 *   - end   = first durable tick at/after observationEnd
 *
 * Until the contract is final, any YES/NO direction is explicitly labelled
 * "indicative". Once resolved, the badge is driven by the on-chain winningOutcome.
 */
export function MarketLiveChart({ market, feed }: MarketLiveChartProps) {
  const [evidence, setEvidence] = useState<MarketObservationEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [domain, setDomain] = useState<{ min: number; max: number } | null>(null);

  const marketAddress = market.contractAddress || market.id;
  const obsStart = Date.parse(market.observationStart || "") || 0;
  const obsEnd = Date.parse(market.observationEnd || "") || 0;
  const chartKey = `${marketAddress.toLowerCase()}:${market.observationStart}`;

  const pull = useCallback(async () => {
    try {
      const next = await fetchMarketObservation(marketAddress);
      setEvidence(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Observation evidence unavailable");
    }
  }, [marketAddress]);

  useEffect(() => {
    void pull();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void pull();
    }, POLL_MS[feed]);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [feed, pull]);

  // A different round gets a clean, stable vertical domain.
  useEffect(() => {
    setEvidence(null);
    setDomain(null);
    setError(null);
  }, [chartKey]);

  const phase = useMemo(() => {
    if (!obsStart || !obsEnd) return "unknown" as const;
    if (now < obsStart) return "before" as const;
    if (now < obsEnd) return "live" as const;
    return "after" as const;
  }, [now, obsStart, obsEnd]);

  const start = evidence?.start;
  const end = evidence?.end;
  const startValue = start?.value;

  const points = useMemo(
    () => buildResolverSeries(evidence?.points ?? [], start, end, obsStart, obsEnd, phase),
    [evidence?.points, start, end, obsStart, obsEnd, phase]
  );

  const valueRange = useMemo(() => {
    const values = points.map((point) => point.v);
    if (Number.isFinite(startValue)) values.push(Number(startValue));
    if (!values.length) return null;
    return { min: Math.min(...values), max: Math.max(...values) };
  }, [points, startValue]);

  // Expand the Y domain when a new extreme arrives, but never shrink it during the
  // same round. The previous implementation recalculated min/max every poll, which
  // made a nearly flat BTC line jump vertically even when the price barely moved.
  useEffect(() => {
    if (!valueRange) return;
    const rawSpan = valueRange.max - valueRange.min;
    const center = (valueRange.max + valueRange.min) / 2;
    const minPad = feed === "btc" ? Math.max(Math.abs(center) * 0.00015, 2) : 0.08;
    const pad = Math.max(rawSpan * 0.18, minPad);
    const next = { min: valueRange.min - pad, max: valueRange.max + pad };
    setDomain((previous) =>
      previous
        ? { min: Math.min(previous.min, next.min), max: Math.max(previous.max, next.max) }
        : next
    );
  }, [feed, valueRange]);

  const chart = useMemo(
    () => buildChart(points, startValue, obsStart, obsEnd || now, domain),
    [points, startValue, obsStart, obsEnd, now, domain]
  );

  const latest = points.at(-1)?.v;
  const indicativeOutcome: Outcome | undefined =
    startValue != null && latest != null ? (latest > startValue ? "YES" : "NO") : evidence?.indicativeOutcome;
  const finalOutcome = evidence?.finalOutcome ?? market.winningOutcome;
  const isFinal =
    evidence?.frozen ||
    evidence?.status === "RESOLVED" ||
    evidence?.status === "ARCHIVED" ||
    market.status === "RESOLVED" ||
    market.status === "ARCHIVED";

  const computedFinal =
    startValue != null && end?.value != null ? (end.value > startValue ? "YES" : "NO") : undefined;
  const integrityError =
    evidence?.integrityError ||
    (isFinal && finalOutcome && computedFinal && finalOutcome !== computedFinal
      ? `On-chain winner ${finalOutcome} does not match frozen start/end evidence ${computedFinal}`
      : undefined);

  const displayValue = phase === "after" && end ? end.value : latest ?? startValue;
  const delta = startValue != null && displayValue != null ? displayValue - startValue : null;
  const secToObs = Math.max(0, Math.ceil((obsStart - now) / 1000));
  const secLeft = Math.max(0, Math.ceil((obsEnd - now) / 1000));
  const isBtc = feed === "btc";
  const fmt = isBtc ? fmtUsd : fmtTemp;

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: FLAT, fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase" }}>
            {isBtc ? "BTC/USD · Coinbase" : "London temp · Open-Meteo"} · resolver evidence
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
              {displayValue != null ? fmt(displayValue) : "—"}
            </span>
            {delta != null && delta !== 0 ? (
              <span
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 14,
                  fontWeight: 600,
                  color: delta > 0 ? UP : DOWN
                }}
              >
                {delta > 0 ? "▲" : "▼"} {fmtDelta(delta, isBtc)}
              </span>
            ) : null}
          </div>
          <div style={{ marginTop: 6, fontSize: 12.5, color: FLAT, lineHeight: 1.5 }}>
            YES only if the resolver&apos;s end print is strictly above its start print.
            {start ? (
              <>
                {" "}
                <strong style={{ color: START }}>· start {fmt(start.value)}</strong>
              </>
            ) : phase === "before" ? (
              <span> · start print not selected yet</span>
            ) : null}
          </div>
        </div>
        <PhaseBadge
          phase={phase}
          secToObs={secToObs}
          secLeft={secLeft}
          indicativeOutcome={indicativeOutcome}
          finalOutcome={isFinal ? finalOutcome : undefined}
          frozen={Boolean(evidence?.frozen)}
        />
      </div>

      {integrityError ? (
        <div
          style={{
            marginTop: 12,
            border: "1px solid #E9AAA3",
            background: "#FFF0EE",
            color: "#9F2D24",
            borderRadius: 9,
            padding: "10px 12px",
            fontSize: 12.5,
            fontWeight: 600
          }}
        >
          Oracle integrity warning: {integrityError}
        </div>
      ) : null}

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
            body={`The resolver will select the durable start print in ${fmtClock(secToObs)}.`}
          />
        ) : chart ? (
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${chart.W} ${chart.H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={isBtc ? "Resolver-aligned BTC observation chart" : "Resolver-aligned weather observation chart"}
            style={{ display: "block" }}
          >
            <defs>
              <linearGradient id={`fillAbove-${feed}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={UP} stopOpacity="0.20" />
                <stop offset="100%" stopColor={UP} stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id={`fillBelow-${feed}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={DOWN} stopOpacity="0.02" />
                <stop offset="100%" stopColor={DOWN} stopOpacity="0.20" />
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

            {[0.25, 0.5, 0.75].map((portion) => (
              <line
                key={portion}
                x1={chart.padL}
                x2={chart.W - chart.padR}
                y1={chart.padT + portion * chart.innerH}
                y2={chart.padT + portion * chart.innerH}
                stroke="#E4E9F0"
                strokeWidth={1}
              />
            ))}

            {chart.startY != null ? (
              <>
                <path d={chart.area} fill={`url(#fillAbove-${feed})`} clipPath={`url(#clipAbove-${feed})`} />
                <path d={chart.area} fill={`url(#fillBelow-${feed})`} clipPath={`url(#clipBelow-${feed})`} />
              </>
            ) : (
              <path d={chart.area} fill={`url(#fillAbove-${feed})`} />
            )}

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

            {/* Moving time cursor is separate from the price path, so the path does not
                stretch and re-render every second between real provider prints. */}
            {phase === "live" ? (
              <line
                x1={chart.nowX}
                x2={chart.nowX}
                y1={chart.padT}
                y2={chart.H - chart.padB}
                stroke="#9BA8B7"
                strokeWidth={1}
                strokeDasharray="3 4"
              />
            ) : null}

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
              <circle cx={chart.last.x} cy={chart.last.y} r={4.5} fill={chart.lineColor} stroke="#fff" strokeWidth={2} />
            ) : null}
          </svg>
        ) : (
          <WaitingPanel
            title={error ? `Evidence: ${error}` : "Waiting for durable oracle print…"}
            body={
              error
                ? "The chart will retry automatically. Final Portfolio results still come directly from the contract."
                : "No resolver tick has landed inside this observation window yet."
            }
          />
        )}

        {chart ? (
          <>
            <span style={yLabelStyle(8)}>{fmt(chart.max)}</span>
            <span style={yLabelStyle(undefined, 8)}>{fmt(chart.min)}</span>
            {start && chart.startY != null ? (
              <span
                style={{
                  position: "absolute",
                  right: 10,
                  top: Math.max(8, Math.min(190, chart.startY - 8)),
                  fontSize: 10.5,
                  fontWeight: 600,
                  color: START,
                  background: "rgba(255,255,255,.94)",
                  border: "1px solid #E0D8FF",
                  borderRadius: 6,
                  padding: "2px 6px",
                  fontFamily: "'IBM Plex Mono', monospace"
                }}
              >
                start {fmt(start.value)}
              </span>
            ) : null}

            {isFinal && finalOutcome ? (
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  top: 12,
                  transform: "translateX(-50%)",
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12.5,
                  fontWeight: 700,
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: "#fff",
                  background: finalOutcome === "YES" ? UP : DOWN,
                  boxShadow: "0 4px 12px rgba(11,22,34,.14)"
                }}
              >
                ON-CHAIN WINNER · {finalOutcome}
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
          {evidence?.frozen
            ? `${points.length} durable prints · evidence frozen`
            : phase === "after"
              ? `${points.length} durable prints · awaiting final on-chain confirmation`
              : `${points.length} durable prints · indicative only`}
        </span>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
          {start ? `start ${formatTickTime(start.at)}` : "start —"}
          {end ? ` · end ${formatTickTime(end.at)}` : " · end —"}
        </span>
      </div>

      {start || end ? (
        <div style={{ marginTop: 7, fontSize: 11.5, color: FLAT, lineHeight: 1.45 }}>
          Resolver inputs: {start ? `${fmt(start.value)} @ ${formatTickTime(start.at)}` : "start pending"}
          {" → "}
          {end ? `${fmt(end.value)} @ ${formatTickTime(end.at)}` : "end pending"}
          {evidence?.resolutionTxHash ? (
            <>
              {" · "}
              <a
                href={`https://testnet.arcscan.app/tx/${evidence.resolutionTxHash}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#2775CA", textDecoration: "none" }}
              >
                resolve tx ↗
              </a>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function buildResolverSeries(
  raw: MarketObservationPoint[],
  start: MarketObservationPoint | undefined,
  end: MarketObservationPoint | undefined,
  obsStart: number,
  obsEnd: number,
  phase: "before" | "live" | "after" | "unknown"
): Point[] {
  if (!obsStart || !obsEnd || !start) return [];
  const points = raw
    .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.at))
    .filter((point) => point.at >= obsStart && point.at <= obsEnd)
    .map((point) => ({ t: point.at, v: point.value }));

  // Always anchor the drawn start line at observationStart, while the footer shows
  // the provider's real selected timestamp.
  const anchored: Point[] = [{ t: obsStart, v: start.value }, ...points];
  if (phase === "after" && end) anchored.push({ t: obsEnd, v: end.value });

  const dedup = new Map<number, Point>();
  for (const point of anchored) {
    const bucket = Math.round(point.t / 250);
    dedup.set(bucket, point);
  }
  const sorted = [...dedup.values()].sort((a, b) => a.t - b.t);
  if (sorted.length === 1) {
    sorted.push({ t: Math.min(obsEnd, obsStart + 1), v: sorted[0]!.v });
  }
  return sorted;
}

function PhaseBadge({
  phase,
  secToObs,
  secLeft,
  indicativeOutcome,
  finalOutcome,
  frozen
}: {
  phase: "before" | "live" | "after" | "unknown";
  secToObs: number;
  secLeft: number;
  indicativeOutcome?: Outcome;
  finalOutcome?: Outcome;
  frozen: boolean;
}) {
  if (finalOutcome) {
    return (
      <span style={badgeStyle(finalOutcome === "YES" ? "#E7F5EF" : "#FBEAE8", finalOutcome === "YES" ? UP : DOWN)}>
        Final · {finalOutcome}{frozen ? " · frozen" : ""}
      </span>
    );
  }
  if (phase === "before") {
    return <span style={badgeStyle("#EAF2FB", "#2775CA")}>Observation in {fmtClock(secToObs)}</span>;
  }
  if (phase === "live") {
    return (
      <span style={badgeStyle("#FFF8E8", WARN)}>
        Indicative {indicativeOutcome ?? "—"} · {fmtClock(secLeft)} left
      </span>
    );
  }
  if (phase === "after") {
    return <span style={badgeStyle("#FFF8E8", WARN)}>Awaiting oracle + on-chain confirmation</span>;
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
      <div style={{ fontSize: 13, color: FLAT, maxWidth: 400, lineHeight: 1.45 }}>{body}</div>
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

function buildChart(
  points: Point[],
  startValue: number | undefined,
  t0: number,
  t1: number,
  domain: { min: number; max: number } | null
) {
  if (points.length < 2 || !t0 || !domain) return null;
  const W = 640;
  const H = 220;
  const padL = 8;
  const padR = 8;
  const padT = 18;
  const padB = 16;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const min = domain.min;
  const max = domain.max;
  const range = max - min || 1;
  const tSpan = Math.max(t1 - t0, 1);

  const coords = points.map((point) => ({
    x: padL + clamp01((point.t - t0) / tSpan) * innerW,
    y: padT + (1 - (point.v - min) / range) * innerH
  }));
  const line = linearPath(coords);
  const last = coords[coords.length - 1]!;
  const first = coords[0]!;
  const area = `${line} L${last.x.toFixed(1)} ${(H - padB).toFixed(1)} L${first.x.toFixed(1)} ${(H - padB).toFixed(1)} Z`;
  const latestValue = points.at(-1)!.v;
  const base = startValue ?? points[0]!.v;
  const lineColor = latestValue >= base ? UP : DOWN;
  const startY =
    startValue != null && Number.isFinite(startValue)
      ? padT + (1 - (startValue - min) / range) * innerH
      : null;
  const nowX = padL + clamp01((Date.now() - t0) / tSpan) * innerW;

  return { W, H, padL, padR, padT, padB, innerW, innerH, line, area, last, min, max, startY, lineColor, nowX };
}

/** Straight segments preserve the exact side of the start line between oracle
 * prints. Stable Y bounds and a separate time cursor remove the old visual jitter
 * without inventing curved values the provider never published. */
function linearPath(points: Array<{ x: number; y: number }>): string {
  return points
    .map((point, index) =>
      `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`
    )
    .join(" ");
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function fmtUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function fmtTemp(value: number) {
  return `${value.toFixed(2)}°C`;
}

function fmtDelta(delta: number, isBtc: boolean) {
  const sign = delta > 0 ? "+" : "−";
  const abs = Math.abs(delta);
  return isBtc
    ? `${sign}${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(abs)}`
    : `${sign}${abs.toFixed(2)}°C`;
}

function fmtClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatTickTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
