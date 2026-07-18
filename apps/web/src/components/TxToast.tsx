"use client";

import { ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ActivityItem } from "@/lib/activity";
import { arcDeployment } from "@/lib/onchain";

type Toast = {
  id: string;
  title: string;
  detail?: string;
  href?: string;
};

/**
 * Bottom-left toast when a tx / activity event fires (replaces On-chain pulse panel).
 */
export function TxToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const onActivity = (event: Event) => {
      const detail = (event as CustomEvent<ActivityItem>).detail;
      if (!detail?.title) return;
      const href =
        detail.href ??
        (detail.txHash ? `${arcDeployment.explorerUrl}/tx/${detail.txHash}` : undefined);
      const toast: Toast = {
        id: detail.id || `${Date.now()}`,
        title: detail.title,
        detail: detail.detail,
        href
      };
      setToasts((prev) => [toast, ...prev].slice(0, 3));
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, 8_000);
    };
    window.addEventListener("probx-activity", onActivity as EventListener);
    return () => window.removeEventListener("probx-activity", onActivity as EventListener);
  }, []);

  if (!toasts.length) return null;

  return (
    <div className="txToastStack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="txToast" role="status">
          <div className="txToastBody">
            <strong>{toast.title}</strong>
            {toast.detail ? <span>{toast.detail}</span> : null}
            {toast.href ? (
              <a href={toast.href} target="_blank" rel="noreferrer">
                View on ArcScan
                <ExternalLink size={12} aria-hidden />
              </a>
            ) : null}
          </div>
          <button
            type="button"
            className="txToastClose"
            aria-label="Dismiss"
            onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
