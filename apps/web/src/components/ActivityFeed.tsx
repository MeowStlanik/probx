"use client";

import { Activity, ExternalLink, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/api";
import { loadActivity, type ActivityItem } from "@/lib/activity";
import { loadPositions } from "@/lib/positions";
import { arcDeployment } from "@/lib/onchain";

type Props = {
  compact?: boolean;
  className?: string;
};

type ServerOpening = {
  ticketId: string;
  marketId?: string;
  marketAddress?: string;
  outcome?: "YES" | "NO";
  openedAt: string;
  threshold?: number;
  referencePrice?: number;
  referenceFeed?: string;
};

export function ActivityFeed({ compact = false, className = "" }: Props) {
  const [items, setItems] = useState<ActivityItem[]>([]);

  useEffect(() => {
    const merge = (server: ServerOpening[] = []) => {
      const local = loadActivity();
      const fromPositions = loadPositions().map((p) => ({
        id: `pos-${p.ticketId}`,
        kind: "buy" as const,
        title: `Bought ${p.outcome} · ${p.boost.toFixed(1)}x boost · ${p.riskAmount} USDC`,
        detail: p.marketQuestion?.slice(0, 72) ?? p.marketId,
        at: p.createdAt,
        txHash: p.txHash,
        marketId: p.marketId
      }));
      const fromServer = server.map((row) => ({
        id: `open-${row.ticketId}`,
        kind: "buy" as const,
        title: `Ticket open · ${row.outcome ?? "?"} · #${row.ticketId}`,
        detail:
          row.referenceFeed && row.referencePrice != null
            ? `Ref ${row.referenceFeed} ${row.referencePrice}${row.threshold != null ? ` · thr ${row.threshold}` : ""}`
            : row.marketAddress?.slice(0, 12),
        at: row.openedAt,
        marketId: row.marketId ?? row.marketAddress
      }));
      const merged = [...local, ...fromPositions, ...fromServer]
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .filter((item, index, arr) => arr.findIndex((x) => x.id === item.id) === index)
        .slice(0, compact ? 6 : 12);
      setItems(merged);
    };

    merge();
    const onLocal = () => merge();
    window.addEventListener("probx-activity", onLocal as EventListener);
    window.addEventListener("storage", onLocal);

    let cancelled = false;
    const pull = async () => {
      try {
        const res = await fetch(apiUrl("/api/activity"), { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { openings?: ServerOpening[] };
        if (!cancelled) merge(body.openings ?? []);
      } catch {
        // ignore — local feed still works
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 12_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("probx-activity", onLocal as EventListener);
      window.removeEventListener("storage", onLocal);
    };
  }, [compact]);

  return (
    <section className={`activityFeed ${compact ? "isCompact" : ""} ${className}`.trim()}>
      <div className="sectionHeader sectionHeaderCompact">
        <div>
          <span className="eyebrow">On-chain pulse</span>
          <h2 className="activityFeedTitle">
            <Activity size={18} aria-hidden />
            Activity
          </h2>
        </div>
        <span className="activityFeedHint">ArcScan links when tx is known</span>
      </div>

      {items.length === 0 ? (
        <p className="activityEmpty">
          <Sparkles size={16} aria-hidden />
          No activity yet — buy a boosted ticket to populate this feed.
        </p>
      ) : (
        <ul className="activityList">
          {items.map((item) => (
            <li key={item.id} className={`activityItem kind-${item.kind}`}>
              <div className="activityItemMain">
                <strong>{item.title}</strong>
                {item.detail ? <span>{item.detail}</span> : null}
                <time dateTime={item.at}>{formatWhen(item.at)}</time>
              </div>
              <div className="activityItemLinks">
                {item.txHash ? (
                  <a
                    href={`${arcDeployment.explorerUrl}/tx/${item.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Tx <ExternalLink size={12} aria-hidden />
                  </a>
                ) : null}
                {item.marketId ? (
                  <Link href={`/markets/${encodeURIComponent(item.marketId)}`}>Market</Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const delta = Date.now() - t;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
