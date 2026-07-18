import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimeFile } from "../runtimePaths.js";

export type TicketOpeningMeta = {
  ticketId: string;
  marketId?: string;
  marketAddress?: string;
  outcome?: "YES" | "NO";
  referencePrice?: number;
  referenceFeed?: "btc" | "weather" | "none";
  referenceLabel?: string;
  threshold?: number;
  source?: string;
  openedAt: string;
};

const storePath = runtimeFile("ticket-openings.json");

function loadAll(): Record<string, TicketOpeningMeta> {
  try {
    if (!existsSync(storePath)) return {};
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, TicketOpeningMeta>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, TicketOpeningMeta>): void {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(data, null, 2));
}

export function getTicketOpening(ticketId: string): TicketOpeningMeta | undefined {
  return loadAll()[ticketId];
}

export function upsertTicketOpening(meta: TicketOpeningMeta): TicketOpeningMeta {
  const all = loadAll();
  all[meta.ticketId] = meta;
  saveAll(all);
  return meta;
}

export function listOpenings(): TicketOpeningMeta[] {
  return Object.values(loadAll());
}
