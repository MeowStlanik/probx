import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { dispatchApiRequest } from "./dispatch.js";
import { startAutoResolveWorker } from "./services/autoResolveWorker.js";
import { runMarketCycleOnce } from "./services/marketCycleWorker.js";

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "127.0.0.1";

const server = createServer(async (req, res) => {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const body =
      req.method === "POST" || req.method === "PUT" || req.method === "PATCH"
        ? await readJson(req)
        : {};

    const result = await dispatchApiRequest({
      method: req.method ?? "GET",
      path: url.pathname,
      searchParams: url.searchParams,
      body,
      headers: pickHeaders(req)
    });

    json(res, result.body, result.status);
  } catch (error) {
    const status = (error as { statusCode?: number })?.statusCode ?? 500;
    json(res, { error: error instanceof Error ? error.message : "unknown error" }, status);
  }
});

server.listen(port, host, () => {
  console.log(`ProbX Arc API listening on http://${host}:${port}`);
  startAutoResolveWorker();
  // Local/dev: drive the 60s open + 60s observe BTC/weather cycle.
  if (process.env.MARKET_CYCLE_ENABLED !== "0") {
    const intervalMs = Number(process.env.MARKET_CYCLE_INTERVAL_MS ?? 55_000);
    const safe = Number.isFinite(intervalMs) && intervalMs >= 20_000 ? intervalMs : 55_000;
    console.log(`[market-cycle] local timer every ${safe}ms`);
    void runMarketCycleOnce().catch((error) => console.error("[market-cycle] initial", error));
    const timer = setInterval(() => {
      void runMarketCycleOnce().catch((error) => console.error("[market-cycle]", error));
    }, safe);
    timer.unref?.();
  }
});

function pickHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const get = (name: string) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    authorization: get("authorization"),
    "x-session-email": get("x-session-email"),
    "x-session-token": get("x-session-token")
  };
}

/**
 * CORS: open (*) by default for local dev. Set CORS_ORIGINS=comma-separated
 * list in production to reflect only trusted origins.
 */
function allowedOrigin(requestOrigin: string | undefined): string {
  const configured = (process.env.CORS_ORIGINS ?? "").trim();
  if (!configured || configured === "*") return "*";
  const allowed = configured.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0] ?? "null";
}

function setCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin(req.headers.origin));
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-session-email, x-session-token");
  res.setHeader("Vary", "Origin");
}

function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

const MAX_BODY_BYTES = 1_000_000; // 1 MB — API payloads are tiny JSON

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      req.destroy();
      const error = new Error("Request body too large (max 1 MB).") as Error & { statusCode: number };
      error.statusCode = 413;
      throw error;
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const error = new Error("Invalid JSON body.") as Error & { statusCode: number };
    error.statusCode = 400;
    throw error;
  }
}
