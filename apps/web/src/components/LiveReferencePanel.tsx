"use client";

import { Bitcoin, CloudSun, Minus, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import Link from "next/link";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { apiUrl } from "@/lib/api";

type Direction = "up" | "down" | "flat";

type HistoryPoint = {
  value: number;
  at: number;
};

type DemoReferenceData = {
  btcUsd?: {
    symbol: string;
    price: number;
    bid?: number;
    ask?: number;
    source: string;
    updatedAt: string;
    history?: HistoryPoint[];
  };
  londonWeather?: {
    city: string;
    temperatureC: number;
    feelsLikeC?: number;
    humidity?: number;
    source: string;
    observedAt?: string;
    updatedAt: string;
    history?: HistoryPoint[];
  };
  updatedAt: string;
};

type LiveReferencePanelProps = {
  compact?: boolean;
  /** Nested inside market detail — no double white card, tight chart */
  embedded?: boolean;
  feed?: "all" | "btc" | "weather";
  markers?: Array<{ value: number; label: string; tone?: "open" | "threshold" | "neutral" }>;
  /** Live market deep-links so users can bet from the feed tiles */
  btcMarketHref?: string;
  weatherMarketHref?: string;
};

const BTC_POLL_MS = 1_000;
const WEATHER_POLL_MS = 3_000;
const ALL_POLL_MS = 2_000;

const BTC_HISTORY_CAP = 100;
const WEATHER_HISTORY_CAP = 120;

export function LiveReferencePanel({
  compact = false,
  embedded = false,
  feed = "all",
  markers = [],
  btcMarketHref,
  weatherMarketHref
}: LiveReferencePanelProps) {
  const btcHistoryRef = useRef<HistoryPoint[]>([]);
  const weatherHistoryRef = useRef<HistoryPoint[]>([]);
  const [data, setData] = useState<DemoReferenceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [btcHistory, setBtcHistory] = useState<HistoryPoint[]>([]);
  const [weatherHistory, setWeatherHistory] = useState<HistoryPoint[]>([]);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const showBtc = feed === "all" || feed === "btc";
  const showWeather = feed === "all" || feed === "weather";
  const title = feed === "btc"
    ? "BTC/USD — trade the next 1-min window"
    : feed === "weather"
      ? "London temp — trade the next 1-min window"
      : "Live feeds · bet YES/NO on the next window";
  const pollMs = feed === "weather" ? WEATHER_POLL_MS : feed === "btc" ? BTC_POLL_MS : ALL_POLL_MS;

  const applyHistory = useCallback((
    kind: "btc" | "weather",
    serverHistory: HistoryPoint[] | undefined,
    tick: HistoryPoint
  ) => {
    const ref = kind === "btc" ? btcHistoryRef : weatherHistoryRef;
    const cap = kind === "btc" ? BTC_HISTORY_CAP : WEATHER_HISTORY_CAP;
    const setHist = kind === "btc" ? setBtcHistory : setWeatherHistory;
    const prev = ref.current;
    const server = normalizeHistory(serverHistory);

    let next: HistoryPoint[];
    if (server.length >= 2) {
      next = appendTickStable(server, tick, kind === "weather" ? 2_000 : 500);
    } else if (prev.length >= 2) {
      next = appendTickStable(prev, tick, kind === "weather" ? 2_000 : 500);
    } else if (Number.isFinite(tick.value)) {
      next = [
        { value: tick.value, at: tick.at - 60_000 },
        tick
      ];
    } else {
      next = prev;
    }

    next = next.slice(-cap);
    if (historyLooksSame(prev, next)) return;
    ref.current = next;
    setHist(next);
  }, []);

  const refresh = useCallback(async (manual = false) => {
    if (manual) setManualRefreshing(true);
    try {
      // Empty api base = same-origin /api on Vercel — do not treat as "unavailable"
      const response = await fetch(apiUrl("/api/demo-data"), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = (await response.json()) as DemoReferenceData;

      if (showBtc && next.btcUsd && Number.isFinite(next.btcUsd.price)) {
        applyHistory("btc", next.btcUsd.history, {
          value: next.btcUsd.price,
          at: Date.parse(next.btcUsd.updatedAt) || Date.now()
        });
      }

      if (showWeather && next.londonWeather && Number.isFinite(next.londonWeather.temperatureC)) {
        applyHistory("weather", next.londonWeather.history, {
          value: next.londonWeather.temperatureC,
          at: Date.parse(next.londonWeather.updatedAt) || Date.now()
        });
      }

      setData(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Feed error");
    } finally {
      if (manual) setManualRefreshing(false);
    }
  }, [applyHistory, showBtc, showWeather]);

  useEffect(() => {
    void refresh(false);
    const interval = window.setInterval(() => void refresh(false), pollMs);
    return () => window.clearInterval(interval);
  }, [pollMs, refresh]);

  const chartMarkers = useMemo(
    () => markers.filter((marker) => Number.isFinite(marker.value)),
    [markers]
  );

  const panelClass = [
    "liveReferencePanel",
    compact ? "compact" : "",
    embedded ? "embedded" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={panelClass} aria-label="Live reference feeds">
      {!embedded ? (
        <div className="liveReferenceHeader">
          <div>
            <span className="eyebrow">Live feeds</span>
            <h2 className="liveReferenceTitle">{title}</h2>
            <p className="liveReferenceLead">
              Tap a feed to open the current market and buy a YES/NO ticket before lock.
            </p>
          </div>
          <button
            className="miniLinkButton liveRefreshButton"
            disabled={manualRefreshing}
            onClick={() => void refresh(true)}
            type="button"
          >
            <RefreshCw size={14} aria-hidden className={manualRefreshing ? "spinIcon" : undefined} />
            Refresh
          </button>
        </div>
      ) : (
        <div className="liveReferenceHeader embeddedHeader">
          <div>
            <span className="eyebrow">Live feed</span>
            <h2 className="liveReferenceTitle">
              {feed === "btc" ? "BTC/USD" : feed === "weather" ? "London temp" : "Live"}
            </h2>
          </div>
          <button
            className="miniLinkButton liveRefreshButton"
            disabled={manualRefreshing}
            onClick={() => void refresh(true)}
            type="button"
          >
            <RefreshCw size={14} aria-hidden className={manualRefreshing ? "spinIcon" : undefined} />
            Refresh
          </button>
        </div>
      )}

      <div className={embedded ? "liveReferenceGrid single" : "liveReferenceGrid"}>
        {showBtc ? (
          <ReferenceTile
            compact={compact || embedded}
            cta={btcMarketHref ? "Trade BTC market →" : "Waiting for open BTC market…"}
            delta={deltaFromHistory(btcHistory, 0.05)}
            direction={directionFromHistory(btcHistory, 0.05)}
            embedded={embedded}
            history={btcHistory}
            href={embedded ? undefined : btcMarketHref}
            icon="btc"
            label="BTC/USD"
            markers={chartMarkers}
            source={data?.btcUsd?.source ?? "Coinbase Exchange"}
            value={data?.btcUsd ? formatUsdHundredths(data.btcUsd.price) : "--"}
            valueNumber={data?.btcUsd?.price}
            bidAsk={
              data?.btcUsd?.bid && data?.btcUsd?.ask
                ? `bid ${formatUsdHundredths(data.btcUsd.bid)} · ask ${formatUsdHundredths(data.btcUsd.ask)}`
                : undefined
            }
          />
        ) : null}
        {showWeather ? (
          <ReferenceTile
            compact={compact || embedded}
            cta={weatherMarketHref ? "Trade London weather →" : "Waiting for open weather market…"}
            delta={deltaFromHistory(weatherHistory, 0.03)}
            direction={directionFromHistory(weatherHistory, 0.03)}
            embedded={embedded}
            history={weatherHistory}
            href={embedded ? undefined : weatherMarketHref}
            icon="weather"
            label="London temp"
            markers={feed === "weather" ? chartMarkers : []}
            source={data?.londonWeather?.source ?? "Open-Meteo"}
            value={data?.londonWeather ? formatTempHundredths(data.londonWeather.temperatureC) : "--"}
            valueNumber={data?.londonWeather?.temperatureC}
            bidAsk={
              data?.londonWeather
                ? [
                    Number.isFinite(data.londonWeather.feelsLikeC)
                      ? `feels ${formatTempHundredths(data.londonWeather.feelsLikeC as number)}`
                      : null,
                    Number.isFinite(data.londonWeather.humidity)
                      ? `RH ${Math.round(data.londonWeather.humidity as number)}%`
                      : null,
                    weatherHistory.length ? `${weatherHistory.length} pts` : null
                  ].filter(Boolean).join(" · ") || undefined
                : undefined
            }
          />
        ) : null}
      </div>

      {!embedded ? (
        <div className="liveReferenceFooter">
          <span>{data ? `Updated ${new Date(data.updatedAt).toLocaleTimeString()}` : "Waiting for first update"}</span>
          <span className={error ? "feedState reconnecting" : "feedState"}>
            {error ? "Feed reconnecting…" : "Coinbase · Open-Meteo · click a tile to bet"}
          </span>
        </div>
      ) : error ? (
        <div className="liveReferenceFooter">
          <span className="feedState reconnecting">Feed reconnecting…</span>
        </div>
      ) : null}
    </section>
  );
}

const ReferenceTile = memo(function ReferenceTile({
  bidAsk,
  compact,
  cta,
  delta,
  direction,
  embedded,
  history,
  href,
  icon,
  label,
  markers,
  source,
  value,
  valueNumber
}: {
  bidAsk?: string;
  compact: boolean;
  cta: string;
  delta: number | null;
  direction: Direction;
  embedded?: boolean;
  history: HistoryPoint[];
  href?: string;
  icon: "btc" | "weather";
  label: string;
  markers: Array<{ value: number; label: string; tone?: "open" | "threshold" | "neutral" }>;
  source: string;
  value: string;
  valueNumber?: number;
}) {
  const Icon = icon === "btc" ? Bitcoin : CloudSun;
  const DirectionIcon = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
  const range = rangeFromHistory(history);
  const deltaText = formatDelta(delta, icon === "btc");

  const body = (
    <>
      <div className="referenceTileTop">
        <span className="referenceIcon">
          <Icon size={18} aria-hidden />
        </span>
        <div className="referenceTileLabels">
          <strong>{label}</strong>
          <span>{source}</span>
        </div>
      </div>
      <div className="referenceValueRow">
        <div className="referenceValueBlock">
          <span className="referenceValue">{value}</span>
          {bidAsk ? <span className="referenceValueExact">{bidAsk}</span> : null}
        </div>
        <span className={`directionPill ${direction}`}>
          <DirectionIcon size={14} aria-hidden />
          {direction === "up" ? "Up" : direction === "down" ? "Down" : "Flat"}
          {deltaText ? ` ${deltaText}` : ""}
        </span>
      </div>
      <LiveLineChart
        compact={compact || Boolean(embedded)}
        direction={direction}
        markers={markers}
        points={history}
        valueFormatter={icon === "btc" ? formatUsdHundredths : formatTempHundredths}
      />
      <div className="referenceChartMeta">
        <span>Min {range ? (icon === "btc" ? formatUsdHundredths(range.min) : formatTempHundredths(range.min)) : "--"}</span>
        <span>{history.length} pts</span>
        <span>Max {range ? (icon === "btc" ? formatUsdHundredths(range.max) : formatTempHundredths(range.max)) : "--"}</span>
      </div>
      {Number.isFinite(valueNumber) && markers.length ? (
        <div className="referenceMarkersLegend">
          {markers.map((marker) => (
            <span key={`${marker.label}-${marker.value}`} className={`markerChip ${marker.tone ?? "neutral"}`}>
              {marker.label}: {icon === "btc" ? formatUsdHundredths(marker.value) : formatTempHundredths(marker.value)}
            </span>
          ))}
        </div>
      ) : null}
      {!embedded ? <span className={href ? "referenceCta" : "referenceCta muted"}>{cta}</span> : null}
    </>
  );

  const tileClass = `referenceTile ${direction}${embedded ? " embeddedTile" : ""}`;

  // Tour "Pick a live market" targets a bettable feed tile when market cards aren't on this page.
  const tourAttr = href && !embedded ? { "data-tour": "market-card" as const } : {};

  if (href) {
    return (
      <Link className={`${tileClass} clickable`} href={href} {...tourAttr}>
        {body}
      </Link>
    );
  }

  return <article className={tileClass}>{body}</article>;
});

const LiveLineChart = memo(function LiveLineChart({
  compact,
  direction,
  markers,
  points,
  valueFormatter
}: {
  compact: boolean;
  direction: Direction;
  markers: Array<{ value: number; label: string; tone?: "open" | "threshold" | "neutral" }>;
  points: HistoryPoint[];
  valueFormatter: (value: number) => string;
}) {
  const gradientId = useId().replace(/:/g, "");
  const width = 360;
  const height = compact ? 96 : 128;
  const padX = 12;
  const padY = 16;
  const yRangeRef = useRef<{ min: number; max: number; seriesKey: string } | null>(null);

  const chart = useMemo(() => {
    const ready = points.length >= 2 && points.some((p) => p.value !== 1 || points.length > 2);
    if (!ready) {
      return {
        linePath: "",
        areaPath: "",
        min: 0,
        max: 1,
        last: null as null | { x: number; y: number; value: number },
        markerLines: [] as Array<{ value: number; label: string; tone?: string; y: number }>,
        isPlaceholder: true
      };
    }

    const values = points;
    const nums = values.map((point) => point.value);
    const markerVals = markers.map((marker) => marker.value).filter((value) => Number.isFinite(value));
    let dataMin = Math.min(...nums, ...(markerVals.length ? markerVals : nums));
    let dataMax = Math.max(...nums, ...(markerVals.length ? markerVals : nums));
    const rawSpan = dataMax - dataMin;

    if (rawSpan < 1e-9) {
      const pad = Math.max(Math.abs(dataMax) * 0.0015, dataMax > 100 ? 5 : 0.25);
      dataMin -= pad;
      dataMax += pad;
    } else {
      const pad = Math.max(rawSpan * 0.1, rawSpan * 0.02);
      dataMin -= pad;
      dataMax += pad;
    }

    const seriesKey = `${values[0].at}:${values.length}:${Math.round(values[0].value)}`;
    const prev = yRangeRef.current;
    let min = dataMin;
    let max = dataMax;
    if (prev && prev.seriesKey === seriesKey) {
      min = Math.min(prev.min, dataMin);
      max = Math.max(prev.max, dataMax);
      const prevSpan = prev.max - prev.min || 1;
      if (dataMin > prev.min + prevSpan * 0.05 && dataMax < prev.max - prevSpan * 0.05) {
        min = prev.min;
        max = prev.max;
      }
    }
    yRangeRef.current = { min, max, seriesKey };
    const range = max - min || 1;

    const t0 = values[0].at;
    const t1 = values[values.length - 1].at;
    const tSpan = Math.max(t1 - t0, 1);

    const coords = values.map((point) => {
      const x = padX + ((point.at - t0) / tSpan) * (width - padX * 2);
      const y = padY + (1 - (point.value - min) / range) * (height - padY * 2);
      return { x, y, value: point.value, at: point.at };
    });

    const linePath = coords
      .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
      .join(" ");
    const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(2)} ${(height - 2).toFixed(2)} L ${coords[0].x.toFixed(2)} ${(height - 2).toFixed(2)} Z`;
    const last = coords[coords.length - 1];
    const markerLines = markers
      .filter((marker) => Number.isFinite(marker.value))
      .map((marker) => ({
        ...marker,
        y: padY + (1 - (marker.value - min) / range) * (height - padY * 2)
      }));

    return { linePath, areaPath, min, max, last, markerLines, isPlaceholder: false };
  }, [height, markers, points]);

  if (chart.isPlaceholder) {
    return (
      <div className="liveLineChart placeholder chartSkeleton" aria-busy="true" aria-label="Loading chart">
        <div className="chartSkeletonShimmer" />
        <span className="chartSkeletonLabel">Syncing feed…</span>
      </div>
    );
  }

  return (
    <div className={`liveLineChart ${direction}`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Live reference chart" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`fill-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.26" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {chart.markerLines.map((marker) => (
          <g key={`${marker.label}-${marker.value}`} className={`chartMarker ${marker.tone ?? "neutral"}`}>
            <line x1={padX} x2={width - padX} y1={marker.y} y2={marker.y} strokeDasharray="4 3" />
          </g>
        ))}
        <path className="chartArea" d={chart.areaPath} fill={`url(#fill-${gradientId})`} />
        <path
          className="chartLine"
          d={chart.linePath}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {chart.last ? <circle className="chartDot chartDotLast" cx={chart.last.x} cy={chart.last.y} r={3.5} /> : null}
      </svg>
      <div className="chartYLabels" aria-hidden>
        <span>{valueFormatter(chart.max)}</span>
        <span>{valueFormatter(chart.min)}</span>
      </div>
      {chart.last ? (
        <span className="chartLastBadge">{valueFormatter(chart.last.value)}</span>
      ) : null}
    </div>
  );
});

function normalizeHistory(raw?: HistoryPoint[]): HistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((point) => Number.isFinite(point?.value) && Number.isFinite(point?.at))
    .sort((a, b) => a.at - b.at);
}

function appendTickStable(history: HistoryPoint[], next: HistoryPoint, minGapMs: number): HistoryPoint[] {
  if (!Number.isFinite(next.value) || !Number.isFinite(next.at)) return history;
  if (!history.length) return [next];
  const last = history[history.length - 1];
  if (next.at < last.at - 2_000) return history;
  if (next.at - last.at < minGapMs) {
    return [...history.slice(0, -1), { value: next.value, at: Math.max(last.at, next.at) }];
  }
  return [...history, next];
}

function historyLooksSame(a: HistoryPoint[], b: HistoryPoint[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  if (!a.length) return true;
  const aL = a[a.length - 1];
  const bL = b[b.length - 1];
  const a0 = a[0];
  const b0 = b[0];
  return a0.at === b0.at && a0.value === b0.value && aL.at === bL.at && aL.value === bL.value;
}

function directionFromHistory(history: HistoryPoint[], epsilon: number): Direction {
  const delta = deltaFromHistory(history, epsilon);
  if (delta === null) return "flat";
  return delta > 0 ? "up" : "down";
}

function deltaFromHistory(history: HistoryPoint[], epsilon: number): number | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  let prior = history[history.length - 2];
  for (let i = history.length - 2; i >= 0; i -= 1) {
    if (last.at - history[i].at >= 20_000) {
      prior = history[i];
      break;
    }
  }
  const delta = last.value - prior.value;
  if (Math.abs(delta) < epsilon) return null;
  return delta;
}

function rangeFromHistory(history: HistoryPoint[]): { min: number; max: number } | null {
  if (!history.length) return null;
  const values = history.map((point) => point.value);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function formatDelta(delta: number | null, isUsd: boolean): string {
  if (delta === null || !Number.isFinite(delta)) return "";
  const sign = delta > 0 ? "+" : "";
  return isUsd ? `${sign}${delta.toFixed(2)}` : `${sign}${delta.toFixed(2)}°`;
}

function formatUsdHundredths(value: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    style: "currency"
  }).format(value);
}

function formatTempHundredths(value: number): string {
  return `${value.toFixed(2)}°C`;
}
