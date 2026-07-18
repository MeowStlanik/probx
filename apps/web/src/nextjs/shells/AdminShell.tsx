"use client";

import { useCallback, useState } from "react";
import { getAddress } from "viem";
import { apiUrl } from "@/lib/api";
import { AdminView } from "../views/AdminView";

type Created = { question: string; meta: string };

type AdminActionResponse = {
  hash?: `0x${string}`;
  createHash?: `0x${string}`;
  openHash?: `0x${string}`;
  status?: string;
  error?: string;
  marketAddress?: string;
  market?: { id?: string; contractAddress?: string };
};

const ADMIN_SECRET_KEY = "probx.adminSecret";

function readAdminSecret(): string {
  try {
    return window.sessionStorage.getItem(ADMIN_SECRET_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeAdminSecret(value: string) {
  try {
    if (value) window.sessionStorage.setItem(ADMIN_SECRET_KEY, value);
    else window.sessionStorage.removeItem(ADMIN_SECRET_KEY);
  } catch {
    /* ignore */
  }
}

/** Same endpoint used by OnchainAdminPanel.postAdminAction */
async function postAdminAction(path: string, body: Record<string, unknown>): Promise<AdminActionResponse> {
  const adminSecret = readAdminSecret();
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(adminSecret ? { ...body, adminSecret } : body)
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to fetch";
    throw new Error(
      `${msg}. Check that /api is same-origin (not :3001). On Codespace open port 3000 only.`
    );
  }

  let payload: AdminActionResponse;
  try {
    payload = (await response.json()) as AdminActionResponse;
  } catch {
    throw new Error(`Admin endpoint returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `Admin endpoint HTTP ${response.status}`);
  }
  return payload;
}

function roleForQuestion(question: string): "btc_price" | "london_weather" | "legacy" {
  const n = question.toLowerCase();
  if (n.includes("btc") || n.includes("bitcoin")) return "btc_price";
  if (n.includes("london") || n.includes("weather") || n.includes("°c")) return "london_weather";
  return "legacy";
}

/**
 * Wires AdminView → POST /api/markets/create-demo + POST /api/oracle/resolve
 * (same as OnchainAdminPanel).
 */
export function AdminShell() {
  const [createdMarkets, setCreatedMarkets] = useState<Created[]>([]);
  const [adminSecret, setAdminSecret] = useState(() =>
    typeof window !== "undefined" ? readAdminSecret() : ""
  );
  const [error, setError] = useState<string | null>(null);

  const onAdminSecretChange = useCallback((value: string) => {
    setAdminSecret(value);
    writeAdminSecret(value);
  }, []);

  const onCreateMarket = useCallback(
    async (input: { category: string; question: string; duration: string; source: string }) => {
      setError(null);
      const lockSeconds = Math.max(45, Math.min(86_400, Number(input.duration) || 60));
      const observationSeconds = Math.max(15, Math.floor(lockSeconds / 2));
      const question =
        input.question.trim() ||
        (input.category === "weather"
          ? "London temperature above threshold in the next window?"
          : input.category === "network"
            ? "Arc block time under threshold?"
            : "BTC/USD above threshold in the next window?");

      try {
        const payload = await postAdminAction("/api/markets/create-demo", {
          question,
          demoRole: roleForQuestion(question),
          yesPricePercent: 50,
          lockSeconds,
          observationSeconds
        });

        const market = payload.marketAddress ?? payload.market?.contractAddress ?? payload.market?.id;
        const txHash = payload.openHash ?? payload.createHash ?? payload.hash ?? "0x";
        if (market) {
          setCreatedMarkets((prev) => [
            {
              question,
              meta: `${input.category} · ${input.duration}s · ${input.source} · ${getAddress(market).slice(0, 10)}…`
            },
            ...prev
          ]);
        }
        return { txHash };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Create failed";
        setError(message);
        throw e;
      }
    },
    []
  );

  const onForceResolve = useCallback(async (marketAddress: string, outcome: "YES" | "NO") => {
    setError(null);
    if (!marketAddress.trim()) {
      const message = "Market address required";
      setError(message);
      throw new Error(message);
    }
    try {
      await postAdminAction("/api/oracle/resolve", {
        marketId: marketAddress.trim(),
        outcome
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Resolve failed";
      setError(message);
      throw e;
    }
  }, []);

  return (
    <AdminView
      onCreateMarket={onCreateMarket}
      createdMarkets={createdMarkets}
      onForceResolve={onForceResolve}
      adminSecret={adminSecret}
      onAdminSecretChange={onAdminSecretChange}
      error={error}
    />
  );
}
