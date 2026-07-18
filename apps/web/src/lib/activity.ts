"use client";

export type ActivityItem = {
  id: string;
  kind: "buy" | "resolve" | "claim" | "fund" | "info";
  title: string;
  detail?: string;
  at: string;
  txHash?: string;
  marketId?: string;
  href?: string;
};

const STORAGE_KEY = "probx.activity.v1";
const MAX_ITEMS = 40;

export function loadActivity(): ActivityItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActivityItem[];
    return Array.isArray(parsed) ? parsed.filter((item) => item?.id && item?.title) : [];
  } catch {
    return [];
  }
}

export function pushActivity(item: Omit<ActivityItem, "id" | "at"> & { id?: string; at?: string }): ActivityItem[] {
  const nextItem: ActivityItem = {
    id: item.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: item.at ?? new Date().toISOString(),
    kind: item.kind,
    title: item.title,
    detail: item.detail,
    txHash: item.txHash,
    marketId: item.marketId,
    href: item.href
  };
  const next = [nextItem, ...loadActivity().filter((row) => row.id !== nextItem.id)].slice(0, MAX_ITEMS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("probx-activity", { detail: nextItem }));
  } catch {
    // ignore quota
  }
  return next;
}
