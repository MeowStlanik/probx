/** Lifecycle progress bar — matches design Open · Lock · Pause · Observe · Resolve */

type Props = {
  /** 0–100 position of the “now” marker */
  progressPct: number;
  size?: "sm" | "md" | "lg";
  showLabels?: boolean;
  className?: string;
};

/** Approximate phase widths from design mock (50 / 6 / 8 / 31 / 5). */
const SEGMENTS = [
  { key: "open", width: 50, shade: false },
  { key: "lock", width: 6, shade: true },
  { key: "pause", width: 8, shade: false },
  { key: "observe", width: 31, shade: true },
  { key: "resolve", width: 5, shade: false }
] as const;

const LABELS = ["Open", "Lock", "Pause", "Observe", "Resolve"];

export function LifecycleBar({ progressPct, size = "md", showLabels = true, className = "" }: Props) {
  const pct = Math.min(100, Math.max(0, progressPct));
  const h = size === "lg" ? 8 : size === "sm" ? 4 : 6;
  const markerPad = size === "sm" ? 3 : 4;

  return (
    <div className={`lifecycleBar ${className}`.trim()}>
      <div className="lifecycleBarTrack" style={{ height: h }}>
        {SEGMENTS.map((seg, i) => (
          <div
            key={seg.key}
            className={seg.shade ? "lifecycleBarSeg shade" : "lifecycleBarSeg"}
            style={{
              width: `${seg.width}%`,
              borderRight: i < SEGMENTS.length - 1 ? "1px solid #fff" : undefined
            }}
          />
        ))}
        <div
          className="lifecycleBarMarker"
          style={{
            left: `${pct}%`,
            top: -markerPad,
            bottom: -markerPad
          }}
        />
      </div>
      {showLabels ? (
        <div className="lifecycleBarLabels">
          {LABELS.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Rough progress for a market from open → resolve timeline. */
export function marketLifecycleProgress(market: {
  status: string;
  openTime?: string;
  lockTime: string;
  observationStart?: string;
  observationEnd: string;
}): number {
  const now = Date.now();
  const open = market.openTime ? new Date(market.openTime).getTime() : NaN;
  const lock = new Date(market.lockTime).getTime();
  const obsStart = market.observationStart
    ? new Date(market.observationStart).getTime()
    : lock;
  const obsEnd = new Date(market.observationEnd).getTime();

  if (market.status === "RESOLVED" || market.status === "CANCELLED") return 100;
  if (market.status === "CREATED") return 2;

  if (Number.isFinite(open) && now < open) return 0;
  if (now < lock) {
    const start = Number.isFinite(open) ? open : lock - 60_000;
    const t = (now - start) / Math.max(1, lock - start);
    return Math.min(50, Math.max(0, t * 50));
  }
  if (now < obsStart) {
    const t = (now - lock) / Math.max(1, obsStart - lock);
    return 50 + Math.min(14, Math.max(0, t * 14));
  }
  if (now < obsEnd) {
    const t = (now - obsStart) / Math.max(1, obsEnd - obsStart);
    return 64 + Math.min(31, Math.max(0, t * 31));
  }
  return 96;
}
