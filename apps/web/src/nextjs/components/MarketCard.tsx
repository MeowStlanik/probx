import { theme } from "../theme";
import type { MarketSummary } from "../types";

/** Design segment widths — labels MUST match these or the marker looks “under the wrong stage”. */
export const LIFECYCLE_SEGMENTS = [
  { key: "OPEN" as const, label: "Open", width: 50 },
  { key: "LOCK" as const, label: "Lock", width: 6 },
  { key: "PAUSE" as const, label: "Pause", width: 8 },
  { key: "OBSERVE" as const, label: "Observe", width: 31 },
  { key: "RESOLVE" as const, label: "Resolve", width: 5 }
];

// Lifecycle bar: OPEN 50% · LOCK 6% · PAUSE 8% · OBSERVE 31% · RESOLVE 5% + marker.
export function LifecycleBar({ nowPct, height = 4 }: { nowPct: number; height?: number }) {
  return (
    <div style={{ position: "relative", height, borderRadius: height / 2, background: "#EDF1F6", display: "flex" }}>
      {LIFECYCLE_SEGMENTS.map((seg, i) => (
        <div
          key={seg.key}
          style={{
            width: `${seg.width}%`,
            borderRight: i < LIFECYCLE_SEGMENTS.length - 1 ? "1px solid #fff" : undefined,
            background: i % 2 === 1 ? "#E1E7EF" : "#EDF1F6"
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          top: -3,
          bottom: -3,
          width: 2,
          background: theme.color.blue,
          borderRadius: 2,
          left: `${Math.min(100, Math.max(0, nowPct))}%`,
          boxShadow: "0 0 0 3px rgba(39,117,202,.14)",
          transform: "translateX(-1px)"
        }}
      />
    </div>
  );
}

/**
 * Labels under the bar — same flex geometry as LifecycleBar (50/6/8/31/5).
 * Absolute + full words on 5–8% bands always overflowed on card width.
 * Tight bands use short labels; full name stays in `title` for hover.
 */
function lifecycleLabelText(key: (typeof LIFECYCLE_SEGMENTS)[number]["key"], width: number) {
  if (width <= 5) return "Res";
  if (width <= 6) return "Lk";
  if (width <= 8) return "Pa";
  return LIFECYCLE_SEGMENTS.find((s) => s.key === key)?.label ?? key;
}

export function LifecycleLabels({ active }: { active?: MarketSummary["stage"] }) {
  return (
    <div
      style={{
        display: "flex",
        marginTop: 8,
        width: "100%",
        lineHeight: "14px",
        userSelect: "none"
      }}
    >
      {LIFECYCLE_SEGMENTS.map((seg) => {
        const isActive = active === seg.key;
        return (
          <span
            key={seg.key}
            title={seg.label}
            style={{
              flex: `0 0 ${seg.width}%`,
              maxWidth: `${seg.width}%`,
              minWidth: 0,
              boxSizing: "border-box",
              overflow: "hidden",
              textOverflow: "clip",
              whiteSpace: "nowrap",
              textAlign: "center",
              fontSize: seg.width <= 8 ? 9 : 10,
              fontWeight: isActive ? 700 : 500,
              color: isActive ? theme.color.ink : theme.color.muted,
              letterSpacing: seg.width <= 8 ? "0" : ".02em",
              textTransform: "uppercase"
            }}
          >
            {lifecycleLabelText(seg.key, seg.width)}
          </span>
        );
      })}
    </div>
  );
}

function fmtClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function phaseVerb(stage: MarketSummary["stage"]) {
  return { OPEN: "locks in", LOCK: "pauses in", PAUSE: "observes in", OBSERVE: "resolves in", RESOLVE: "reopens in" }[
    stage
  ];
}

const stagePillTone: Record<MarketSummary["stage"], { bg: string; fg: string }> = {
  OPEN: { bg: theme.color.yesSoft, fg: theme.color.yes },
  LOCK: { bg: theme.color.blueSoft, fg: theme.color.blue },
  PAUSE: { bg: theme.color.tint, fg: theme.color.muted },
  OBSERVE: { bg: theme.color.purpleSoft, fg: theme.color.purple },
  RESOLVE: { bg: theme.color.tint, fg: theme.color.muted }
};

/**
 * @param variant `hero` — home featured card (stage labels, no volume bar, larger type).
 *                `grid` — markets list / live grid (volume bar, compact).
 */
export function MarketCard({
  market,
  onClick,
  variant = "grid"
}: {
  market: MarketSummary;
  onClick?: () => void;
  variant?: "hero" | "grid";
}) {
  const isHero = variant === "hero";
  const pill = stagePillTone[market.stage];
  const yesSelected = market.yesPct >= market.noPct;

  return (
    <div
      onClick={onClick}
      style={{
        cursor: onClick ? "pointer" : undefined,
        background: "#fff",
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.xl,
        boxShadow: theme.shadow.card,
        padding: isHero ? "20px 22px" : 20,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        transition: "box-shadow .15s, border-color .15s"
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = theme.color.blue;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = theme.color.border;
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <span
          suppressHydrationWarning
          style={{
            fontFamily: theme.font.mono,
            fontSize: isHero ? 22 : 18,
            fontWeight: 600,
            color: theme.color.ink,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: ".02em"
          }}
        >
          {fmtClock(market.secondsToNextStage)}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: pill.fg,
            background: pill.bg,
            borderRadius: 6,
            padding: "3px 8px"
          }}
        >
          {market.stage}
        </span>
        <span style={{ fontSize: 12, color: theme.color.muted, marginLeft: "auto" }}>{market.category}</span>
      </div>

      <h3
        style={{
          fontSize: isHero ? 18 : 16,
          fontWeight: 600,
          color: theme.color.ink,
          margin: "12px 0 0",
          lineHeight: 1.25,
          minHeight: isHero ? undefined : 42
        }}
      >
        {market.question}
      </h3>

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <div
          style={{
            flex: 1,
            border: yesSelected ? `1.5px solid ${theme.color.yes}` : `1px solid ${theme.color.yesBorder}`,
            background: theme.color.yesSoft,
            borderRadius: 11,
            padding: "11px 14px"
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.color.yes }}>YES</div>
          <div style={{ fontFamily: theme.font.mono, fontSize: 22, fontWeight: 600, color: theme.color.yes, marginTop: 2 }}>
            {(market.yesPct * 100).toFixed(1)}%
          </div>
        </div>
        <div
          style={{
            flex: 1,
            border: !yesSelected ? `1.5px solid ${theme.color.no}` : `1px solid ${theme.color.border}`,
            background: !yesSelected ? theme.color.noSoft : "#fff",
            borderRadius: 11,
            padding: "11px 14px"
          }}
        >
          <div style={{ fontSize: 11.5, fontWeight: 600, color: theme.color.no }}>NO</div>
          <div style={{ fontFamily: theme.font.mono, fontSize: 22, fontWeight: 600, color: theme.color.no, marginTop: 2 }}>
            {(market.noPct * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Lifecycle bar + labels aligned to segment widths (50/6/8/31/5) */}
      <div style={{ marginTop: isHero ? 18 : 16 }}>
        <LifecycleBar nowPct={market.nowPct} height={isHero ? 6 : 5} />
        <LifecycleLabels active={market.stage} />
      </div>

      <div
        style={{
          marginTop: isHero ? 14 : 10,
          fontSize: 12,
          color: theme.color.muted,
          fontFamily: theme.font.mono,
          flex: 1
        }}
      >
        {market.stats} · {phaseVerb(market.stage)} {fmtClock(market.secondsToNextStage)}
      </div>
    </div>
  );
}
