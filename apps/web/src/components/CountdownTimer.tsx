"use client";

import { useEffect, useState } from "react";
import { secondsUntil } from "@/lib/format";

interface CountdownTimerProps {
  target: string;
  label?: string;
  finishedLabel?: string;
  /** When true, show a small clock icon (default false for clean Arc UI). */
  showIcon?: boolean;
}

/**
 * Client-only clock. SSR renders a stable placeholder so hydration never
 * mismatches when server/client clocks disagree by a few seconds.
 */
export function CountdownTimer({
  target,
  label = "Locks in",
  finishedLabel = "Done",
  showIcon = false
}: CountdownTimerProps) {
  // null until mounted — avoids SSR text vs client text mismatch
  const [seconds, setSeconds] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setSeconds(secondsUntil(target));
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [target]);

  const text = formatCountdown(seconds, label, finishedLabel);

  return (
    <span
      className="countdown"
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      suppressHydrationWarning
    >
      {showIcon ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
          <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : null}
      {text}
    </span>
  );
}

function formatCountdown(
  seconds: number | null,
  label: string,
  finishedLabel: string
): string {
  // Stable SSR + first paint before useEffect
  if (seconds === null) {
    return label ? `${label} —:——` : "——:——";
  }

  if (seconds === 0) return finishedLabel;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const clock =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;

  return label ? `${label} ${clock}` : clock;
}
