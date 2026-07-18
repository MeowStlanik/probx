"use client";

import { Clock3, Hourglass, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { secondsUntil } from "@/lib/format";
import { settlementPhase } from "@/lib/positions";

type SettlementCountdownProps = {
  lockTime?: string;
  observationEnd?: string;
  compact?: boolean;
  className?: string;
};

export function SettlementCountdown({
  lockTime,
  observationEnd,
  compact = false,
  className = ""
}: SettlementCountdownProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const phase = settlementPhase(now, lockTime, observationEnd);
  const seconds = phase.target ? secondsUntil(phase.target) : 0;
  const clock = formatClock(seconds);
  const Icon = phase.phase === "observation" ? Radio : phase.phase === "ready" ? Hourglass : Clock3;

  if (compact) {
    return (
      <span className={`settlementCountdown compact phase-${phase.phase} ${className}`.trim()}>
        <Icon size={15} aria-hidden />
        {phase.phase === "ready" ? phase.label : `${phase.label} ${clock}`}
      </span>
    );
  }

  return (
    <div className={`settlementCountdown phase-${phase.phase} ${className}`.trim()}>
      <div className="settlementCountdownTop">
        <Icon size={18} aria-hidden />
        <div>
          <strong>{phase.phase === "ready" ? phase.label : `${phase.label}: ${clock}`}</strong>
          <p>{phase.detail}</p>
        </div>
      </div>
      {lockTime || observationEnd ? (
        <div className="settlementTimeline">
          {lockTime ? (
            <span>
              Lock {new Date(lockTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          ) : null}
          {observationEnd ? (
            <span>
              Settle after {new Date(observationEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatClock(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0:00";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
