import { theme } from "../theme";
import type { MarketSummary } from "../types";

/**
 * Lifecycle segments (no Pause — Lock covers the whole post-open pre-observe window).
 * OPEN 50% · LOCK 14% · OBSERVE 31% · RESOLVE 5%
 */
export const LIFECYCLE_SEGMENTS = [
  { key: "OPEN" as const, label: "Open", width: 50 },
  { key: "LOCK" as const, label: "Lock", width: 14 },
  { key: "OBSERVE" as const, label: "Observe", width: 31 },
  { key: "RESOLVE" as const, label: "Resolve", width: 5 }
];

export function LifecycleBar({ nowPct, height = 5 }: { nowPct: number; height?: number }) {
  return (
    <div
      style={{
        position: "relative",
        height,
        borderRadius: height / 2,
        background: "#EDF1F6",
        display: "flex",
        overflow: "hidden"
      }}
    >
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

export function LifecycleLabels({ active }: { active?: MarketSummary["stage"] }) {
  // Map legacy PAUSE → LOCK highlight
  const activeKey = active === "PAUSE" ? "LOCK" : active;
  return (
    <div
      style={{
        display: "flex",
        marginTop: 8,
        width: "100%",
        userSelect: "none",
        minHeight: 16
      }}
      role="list"
      aria-label="Market lifecycle stages"
    >
      {LIFECYCLE_SEGMENTS.map((seg) => {
        const isActive = activeKey === seg.key;
        const tight = seg.width <= 8;
        return (
          <span
            key={seg.key}
            role="listitem"
            title={seg.label}
            style={{
              flex: `0 0 ${seg.width}%`,
              maxWidth: `${seg.width}%`,
              minWidth: 0,
              boxSizing: "border-box",
              textAlign: "center",
              fontSize: tight ? 10 : 11,
              lineHeight: "16px",
              fontWeight: isActive ? 700 : 500,
              color: isActive ? theme.color.ink : theme.color.muted,
              letterSpacing: tight ? "0" : "0.02em",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "clip",
              padding: "2px 1px",
              borderRadius: 4,
              background: isActive ? "rgba(39,117,202,.1)" : "transparent"
            }}
          >
            {seg.label}
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
  const s = stage === "PAUSE" ? "LOCK" : stage;
  return { OPEN: "locks in", LOCK: "observes in", OBSERVE: "resolves in", RESOLVE: "reopens in", PAUSE: "observes in" }[
    s
  ];
}

const stagePillTone: Record<MarketSummary["stage"], { bg: string; fg: string }> = {
  OPEN: { bg: theme.color.yesSoft, fg: theme.color.yes },
  LOCK: { bg: theme.color.blueSoft, fg: theme.color.blue },
  PAUSE: { bg: theme.color.blueSoft, fg: theme.color.blue },
  OBSERVE: { bg: theme.color.purpleSoft, fg: theme.color.purple },
  RESOLVE: { bg: theme.color.tint, fg: theme.color.muted }
};

/**
 * @param variant `hero` — home featured card · `grid` — markets list
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
  const stage = market.stage === "PAUSE" ? "LOCK" : market.stage;
  const pill = stagePillTone[stage];
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
        minWidth: 0,
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
          {stage}
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

      <div style={{ marginTop: isHero ? 18 : 16 }}>
        <LifecycleBar nowPct={market.nowPct} height={isHero ? 6 : 5} />
        <LifecycleLabels active={stage} />
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
        {market.stats} · {phaseVerb(stage)} {fmtClock(market.secondsToNextStage)}
      </div>
    </div>
  );
}
