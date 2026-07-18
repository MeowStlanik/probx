"use client";

export type LocalPosition = {
  ticketId: string;
  marketId: string;
  marketAddress: string;
  marketQuestion?: string;
  outcome: "YES" | "NO";
  riskAmount: number;
  boost: number;
  /** Fill odds 0–1 (on-chain quoted price). */
  fillPrice: number;
  payout: number;
  fee?: number;
  referencePrice?: number;
  referenceFeed?: "btc" | "weather" | "none";
  referenceLabel?: string;
  threshold?: number;
  lockTime?: string;
  observationEnd?: string;
  createdAt: string;
  txHash?: string;
};

const STORAGE_KEY = "probx.positions.v1";

export function loadPositions(): LocalPosition[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LocalPosition[];
    return Array.isArray(parsed) ? parsed.filter((item) => item?.ticketId && item?.marketId) : [];
  } catch {
    return [];
  }
}

export function savePosition(position: LocalPosition): LocalPosition[] {
  const next = [position, ...loadPositions().filter((item) => item.ticketId !== position.ticketId)].slice(0, 40);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore quota
  }
  return next;
}

export function positionsForMarket(marketIdOrAddress: string): LocalPosition[] {
  const key = marketIdOrAddress.toLowerCase();
  return loadPositions().filter(
    (item) => item.marketId.toLowerCase() === key || item.marketAddress.toLowerCase() === key
  );
}

export function latestPositionForMarket(marketIdOrAddress: string): LocalPosition | undefined {
  return positionsForMarket(marketIdOrAddress)[0];
}

export function formatFillOdds(price: number): string {
  const pct = price * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export function settlementPhase(nowMs: number, lockTime?: string, observationEnd?: string): {
  phase: "open" | "observation" | "ready" | "unknown";
  target?: string;
  label: string;
  detail: string;
} {
  const lock = lockTime ? Date.parse(lockTime) : Number.NaN;
  const obsEnd = observationEnd ? Date.parse(observationEnd) : Number.NaN;

  if (Number.isFinite(obsEnd) && nowMs >= obsEnd) {
    return {
      phase: "ready",
      label: "Ready to settle",
      detail: "Market observation ended — claim from Portfolio when resolved."
    };
  }
  if (Number.isFinite(lock) && nowMs >= lock) {
    return {
      phase: "observation",
      target: observationEnd,
      label: "Observation",
      detail: "Trading closed. Waiting for auto-resolve after observation."
    };
  }
  if (Number.isFinite(lock)) {
    return {
      phase: "open",
      target: lockTime,
      label: "Until lock",
      detail: Number.isFinite(obsEnd)
        ? `Then ~${Math.max(0, Math.round((obsEnd - lock) / 1000))}s observation before settle.`
        : "Then short observation before settle."
    };
  }
  return {
    phase: "unknown",
    label: "Pending",
    detail: "Waiting for market timers."
  };
}
