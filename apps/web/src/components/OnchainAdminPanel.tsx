"use client";

import { Ban, Check, ExternalLink, RadioTower, RotateCcw, Trash2 } from "lucide-react";
import {
  createPublicClient,
  fallback,
  getAddress,
  http
} from "viem";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/api";
import { arcChain, arcDeployment, arcRpcUrls, hasArcDeployment, marketAbi } from "@/lib/onchain";

type DemoMarketConfig = {
  id?: string;
  label?: string;
  question?: string;
  role?: "open" | "btc_price" | "london_weather" | "near_lock" | "resolved" | "legacy";
  status?: string;
  market: string;
};

type AdminActionResponse = {
  hash?: `0x${string}`;
  createHash?: `0x${string}`;
  openHash?: `0x${string}`;
  status?: string;
  error?: string;
  marketAddress?: string;
  settledCount?: number;
  hiddenCount?: number;
  createdCount?: number;
  outcome?: "YES" | "NO";
  observedValue?: number;
  threshold?: number;
  referenceSource?: string;
  settled?: Array<{ ticketId: string; hash: `0x${string}`; status: string }>;
  markets?: Array<{ id?: string; contractAddress?: string; question?: string }>;
  market?: {
    id?: string;
    contractAddress?: string;
  };
};

const marketStatuses = ["Created", "Open", "Locked", "Resolved", "Cancelled", "Archived"];

export function OnchainAdminPanel() {
  const demoMarkets = useMemo(() => deployedDemoMarkets(), []);
  const [createdMarkets, setCreatedMarkets] = useState<DemoMarketConfig[]>(() => loadCreatedMarkets());
  const [backendMarkets, setBackendMarkets] = useState<DemoMarketConfig[]>([]);
  // Prefer live backend list so hidden/reset markets disappear from Admin too.
  const adminMarkets = useMemo(
    () => uniqueMarkets(backendMarkets.length ? [...backendMarkets, ...createdMarkets] : [...backendMarkets, ...createdMarkets, ...demoMarkets]),
    [createdMarkets, backendMarkets, demoMarkets]
  );
  const [selectedMarket, setSelectedMarket] = useState(demoMarkets[0]?.market ?? arcDeployment.demoMarket);
  const selectedMarketConfig = useMemo(
    () => adminMarkets.find((market) => sameAddressSafe(market.market, selectedMarket)),
    [adminMarkets, selectedMarket]
  );
  const [selectedStatus, setSelectedStatus] = useState<number | null>(null);
  const [newQuestion, setNewQuestion] = useState("Will the next admin-created demo signal be GREEN?");
  const [newYesPrice, setNewYesPrice] = useState("50");
  const [newLockSeconds, setNewLockSeconds] = useState("60");
  const [newObservationSeconds, setNewObservationSeconds] = useState("30");
  const [createdMarketAddress, setCreatedMarketAddress] = useState<string | null>(null);
  const [adminSecret, setAdminSecretState] = useState<string>(() => readAdminSecret());
  const [status, setStatus] = useState("Ready");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);

  function updateAdminSecret(value: string) {
    setAdminSecretState(value);
    try {
      if (value) {
        window.sessionStorage.setItem(ADMIN_SECRET_STORAGE_KEY, value);
      } else {
        window.sessionStorage.removeItem(ADMIN_SECRET_STORAGE_KEY);
      }
    } catch {
      // storage blocked — secret simply won't persist across rerenders
    }
  }

  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: arcChain,
        transport: fallback(arcRpcUrls.map((url) => http(url)), { rank: false })
      }),
    []
  );

  const refreshMarketStatus = useCallback(async (marketAddress = selectedMarket) => {
    try {
      const nextStatus = await publicClient.readContract({
        address: getAddress(marketAddress),
        abi: marketAbi,
        functionName: "status"
      });
      setSelectedStatus(Number(nextStatus));
    } catch {
      setSelectedStatus(null);
    }
  }, [publicClient, selectedMarket]);

  useEffect(() => {
    void refreshMarketStatus();
  }, [refreshMarketStatus]);

  const refreshAdminMarkets = useCallback(async () => {
    try {
      // Same-origin on Vercel: apiUrl("/api/...") works with empty base
      const response = await fetch(apiUrl("/api/markets"), { cache: "no-store" });
      if (!response.ok) return;
      const markets = (await response.json()) as Array<{
        id?: string;
        question?: string;
        contractAddress?: string;
        demoRole?: DemoMarketConfig["role"];
        status?: string;
      }>;
      setBackendMarkets(markets
        .filter((market) => typeof market.contractAddress === "string")
        .map((market) => ({
          id: market.id,
          label: market.question ?? market.id ?? shortHex(market.contractAddress as string),
          question: market.question,
          role: market.demoRole,
          status: market.status,
          market: market.contractAddress as string
        })));
    } catch {
      // Keep local/deployment markets if the indexer is temporarily unavailable.
    }
  }, []);

  useEffect(() => {
    void refreshAdminMarkets();
    const interval = window.setInterval(() => void refreshAdminMarkets(), 10_000);
    return () => window.clearInterval(interval);
  }, [refreshAdminMarkets]);

  if (!hasArcDeployment) return null;

  async function resolve(outcome: 1 | 2) {
    setBusy(true);
    try {
      const payload = await postAdminAction("/api/oracle/resolve", {
        marketId: selectedMarket,
        outcome: outcome === 1 ? "YES" : "NO"
      });
      setTxHash(payload.hash ?? null);
      setStatus(payload.status === "success" ? `Resolved ${outcome === 1 ? "YES" : "NO"} via backend signer` : "Resolve transaction failed");
      await refreshMarketStatus();
    } catch (error) {
      setStatus(readableAdminError(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    try {
      const payload = await postAdminAction("/api/oracle/cancel", {
        marketId: selectedMarket,
        reason: "demo oracle cancelled"
      });
      setTxHash(payload.hash ?? null);
      setStatus(payload.status === "success" ? "Market cancelled via backend signer" : "Cancel transaction failed");
      await refreshMarketStatus();
    } catch (error) {
      setStatus(readableAdminError(error));
    } finally {
      setBusy(false);
    }
  }

  async function resolveFromReferenceFeed() {
    setBusy(true);
    try {
      const payload = await postAdminAction("/api/oracle/resolve-reference", {
        marketId: selectedMarket
      });
      setTxHash(payload.hash ?? null);
      if (payload.error) {
        setStatus(payload.error);
      } else {
        setStatus(`Resolved ${payload.outcome ?? "-"} from ${payload.referenceSource ?? "reference feed"}: observed ${formatReferenceNumber(payload.observedValue)} vs threshold ${formatReferenceNumber(payload.threshold)}.`);
      }
      await refreshMarketStatus();
      await refreshAdminMarkets();
    } catch (error) {
      setStatus(readableAdminError(error));
    } finally {
      setBusy(false);
    }
  }

  async function settleSelectedMarket() {
    setBusy(true);
    try {
      const payload = await postAdminAction("/api/tickets/settle-market", {
        marketId: selectedMarket
      });
      setTxHash(payload.settled?.at(-1)?.hash ?? null);
      setStatus(`Settled ${payload.settledCount ?? 0} open ticket(s) for selected market`);
      await refreshMarketStatus();
      await refreshAdminMarkets();
    } catch (error) {
      setStatus(readableAdminError(error));
    } finally {
      setBusy(false);
    }
  }

  async function createAndOpenMarket() {
    setBusy(true);
    try {
      const lockSeconds = clampInteger(newLockSeconds, 45, 86_400);
      const observationSeconds = clampInteger(newObservationSeconds, 15, 86_400);
      const payload = await postAdminAction("/api/markets/create-demo", {
        question: newQuestion,
        demoRole: roleForQuestion(newQuestion),
        yesPricePercent: clampNumber(newYesPrice, 1, 99),
        lockSeconds,
        observationSeconds
      });
      const market = payload.marketAddress ?? payload.market?.contractAddress ?? payload.market?.id;
      if (!market) {
        setStatus("Market address missing in backend response");
        return;
      }
      setTxHash(payload.openHash ?? payload.createHash ?? null);

      const created: DemoMarketConfig = {
        id: `mkt_${market.slice(2, 10).toLowerCase()}`,
        label: newQuestion.trim(),
        question: newQuestion.trim(),
        role: roleForQuestion(newQuestion),
        status: "OPEN",
        market: getAddress(market)
      };
      const nextCreatedMarkets = uniqueMarkets([created, ...createdMarkets]);
      setCreatedMarkets(nextCreatedMarkets);
      saveCreatedMarkets(nextCreatedMarkets);
      setCreatedMarketAddress(created.market);
      setSelectedMarket(created.market);
      setStatus(payload.status === "success" ? "Created and opened admin demo market" : "Market create/open transaction failed");
      await refreshMarketStatus(created.market);
      await refreshAdminMarkets();
    } catch (error) {
      setStatus(readableAdminError(error));
    } finally {
      setBusy(false);
    }
  }

  async function hideSelectedMarket() {
    setBusy(true);
    try {
      const payload = await postAdminAction("/api/markets/hide", { marketId: selectedMarket });
      setBackendMarkets((markets) => markets.filter((market) => !sameAddressSafe(market.market, selectedMarket)));
      setCreatedMarkets((markets) => {
        const next = markets.filter((market) => !sameAddressSafe(market.market, selectedMarket));
        saveCreatedMarkets(next);
        return next;
      });
      setSelectedMarket(demoMarkets[0]?.market ?? arcDeployment.demoMarket);
      setStatus(`Hidden selected market from UI list. Hidden total: ${payload.hiddenCount ?? "-"}`);
      await refreshAdminMarkets();
    } catch (error) {
      setStatus(readableAdminError(error));
    } finally {
      setBusy(false);
    }
  }

  async function resetBaseMarkets() {
    setBusy(true);
    try {
      const payload = await postAdminAction("/api/markets/reset-demo", {});
      setCreatedMarkets([]);
      saveCreatedMarkets([]);
      setStatus(`Reset demo list: created ${payload.createdCount ?? 0} base market(s), hidden ${payload.hiddenCount ?? 0} old market(s).`);
      await refreshAdminMarkets();
      const firstMarket = payload.markets?.[0]?.contractAddress ?? payload.markets?.[0]?.id;
      if (firstMarket) {
        setSelectedMarket(firstMarket);
        await refreshMarketStatus(firstMarket);
      }
    } catch (error) {
      setStatus(readableAdminError(error));
    } finally {
      setBusy(false);
    }
  }

  function applyTemplate(template: "btc" | "weather" | "demo") {
    if (template === "btc") {
      // Backend injects the live Coinbase spot into the onchain question so auto-resolve works.
      setNewQuestion("Will BTC/USD be above the current Coinbase spot during the 1-minute observation window?");
      setNewYesPrice("50");
      setNewLockSeconds("3600");
      setNewObservationSeconds("60");
      return;
    }
    if (template === "weather") {
      // Backend injects the live Open-Meteo temperature so auto-resolve works.
      setNewQuestion("Will London temperature be at least the current Open-Meteo reading during the 1-minute observation window?");
      setNewYesPrice("50");
      setNewLockSeconds("3600");
      setNewObservationSeconds("60");
      return;
    }
    setNewQuestion("Will the next demo oracle signal be GREEN?");
    setNewYesPrice("50");
    setNewLockSeconds("3600");
    setNewObservationSeconds("30");
  }

  return (
    <section className="adminPanel">
      <div className="adminCreatePanel adminCreatePanelPrimary">
        <h2>Create test market</h2>
        <p className="adminCreateLead">Spin up a short YES/NO market on Arc for the demo.</p>
        <label>
          <span>Admin secret (only if the server has ADMIN_SECRET set)</span>
          <input
            type="password"
            autoComplete="off"
            value={adminSecret}
            placeholder="Leave empty for open local dev"
            onChange={(event) => updateAdminSecret(event.target.value)}
          />
        </label>
        <div className="templateButtons">
          <button className="miniLinkButton" disabled={busy} onClick={() => applyTemplate("btc")} type="button">BTC 1m</button>
          <button className="miniLinkButton" disabled={busy} onClick={() => applyTemplate("weather")} type="button">London weather</button>
          <button className="miniLinkButton" disabled={busy} onClick={() => applyTemplate("demo")} type="button">Demo signal</button>
        </div>
        <label>
          <span>Question</span>
          <input value={newQuestion} onChange={(event) => setNewQuestion(event.target.value)} />
        </label>
        <div className="adminCreateGrid">
          <label>
            <span>YES price %</span>
            <input inputMode="decimal" value={newYesPrice} onChange={(event) => setNewYesPrice(event.target.value)} />
          </label>
          <label>
            <span>Lock seconds</span>
            <input inputMode="numeric" value={newLockSeconds} onChange={(event) => setNewLockSeconds(event.target.value)} />
          </label>
          <label>
            <span>Observation seconds</span>
            <input inputMode="numeric" value={newObservationSeconds} onChange={(event) => setNewObservationSeconds(event.target.value)} />
          </label>
        </div>
        <button className="iconButton adminActionButton createAction" disabled={busy || !newQuestion.trim()} onClick={() => void createAndOpenMarket()} type="button">
          <Check size={18} aria-hidden />
          Create and open market
        </button>
        {createdMarketAddress ? (
          <a className="createdMarketLink" href={`/markets/${createdMarketAddress}`}>
            Open created market {shortHex(createdMarketAddress)}
          </a>
        ) : null}
        <p className="settlementNote">{busy ? "Submitting backend transaction..." : status}</p>
        {txHash ? (
          <a className="txLink" href={`${arcDeployment.explorerUrl}/tx/${txHash}`} target="_blank">
            View tx <ExternalLink size={13} aria-hidden />
          </a>
        ) : null}
      </div>

      <details className="adminResolverDetails">
        <summary className="adminResolverSummary">Advanced · Resolver tools</summary>
        <div className="adminResolverBody">
          <p className="adminCreateLead adminResolverNote">
            Manual resolve / cancel / settle — usually auto-resolve handles BTC & weather.
          </p>
          <select aria-label="Arc demo market" value={selectedMarket} onChange={(event) => setSelectedMarket(event.target.value)}>
            {adminMarkets.map((market) => (
              <option key={market.market} value={market.market}>
                {marketOptionLabel(market)}
              </option>
            ))}
          </select>
          <div className="adminSelectedMarket">
            <span>Selected market</span>
            <strong>{selectedMarketConfig ? marketDisplayName(selectedMarketConfig) : shortHex(selectedMarket)}</strong>
            <small>{shortHex(selectedMarket)}</small>
          </div>
          <div className="adminStatusRow">
            <span>Market status</span>
            <strong>{selectedStatus === null ? "Reading..." : marketStatuses[selectedStatus] ?? `Unknown ${selectedStatus}`}</strong>
            <button className="miniLinkButton" disabled={busy} onClick={() => void refreshMarketStatus()} type="button">
              Refresh
            </button>
          </div>
          <div className="adminActions">
            <button className="iconButton adminActionButton yesAction" disabled={busy || (selectedStatus !== null && selectedStatus !== 1 && selectedStatus !== 2)} onClick={() => void resolve(1)} type="button">
              <Check size={18} aria-hidden />
              Resolve YES
            </button>
            <button className="iconButton adminActionButton noAction" disabled={busy || (selectedStatus !== null && selectedStatus !== 1 && selectedStatus !== 2)} onClick={() => void resolve(2)} type="button">
              <Check size={18} aria-hidden />
              Resolve NO
            </button>
            <button className="iconButton adminActionButton referenceAction" disabled={busy || (selectedStatus !== null && selectedStatus !== 1 && selectedStatus !== 2)} onClick={() => void resolveFromReferenceFeed()} type="button">
              <RadioTower size={18} aria-hidden />
              Resolve from live feed now
            </button>
            <button className="iconButton adminActionButton cancelAction" disabled={busy || selectedStatus === 3 || selectedStatus === 5} onClick={() => void cancel()} type="button">
              <Ban size={18} aria-hidden />
              Cancel market
            </button>
            <button className="iconButton adminActionButton createAction" disabled={busy || (selectedStatus !== 3 && selectedStatus !== 4)} onClick={() => void settleSelectedMarket()} type="button">
              <Check size={18} aria-hidden />
              Settle market tickets
            </button>
            <button className="iconButton adminActionButton cancelAction" disabled={busy} onClick={() => void hideSelectedMarket()} type="button">
              <Trash2 size={18} aria-hidden />
              Hide market
            </button>
            <button className="iconButton adminActionButton createAction" disabled={busy} onClick={() => void resetBaseMarkets()} type="button">
              <RotateCcw size={18} aria-hidden />
              Reset demo list
            </button>
          </div>
        </div>
      </details>
    </section>
  );
}

const ADMIN_SECRET_STORAGE_KEY = "probx.admin.secret";

function readAdminSecret(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.sessionStorage.getItem(ADMIN_SECRET_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

async function postAdminAction(path: string, body: Record<string, unknown>): Promise<AdminActionResponse> {
  // Empty base is valid (same-origin unified Next API on Vercel)
  const adminSecret = readAdminSecret();
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(adminSecret ? { ...body, adminSecret } : body)
  });
  const payload = (await response.json()) as AdminActionResponse;
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `Admin endpoint returned HTTP ${response.status}`);
  }
  return payload;
}

function deployedDemoMarkets(): DemoMarketConfig[] {
  const deployment = arcDeployment as typeof arcDeployment & {
    demoMarkets?: Array<{ id?: string; label?: string; role?: string; market?: string }>;
  };
  if (Array.isArray(deployment.demoMarkets) && deployment.demoMarkets.length > 0) {
    return deployment.demoMarkets
      .filter((market) => Boolean(market.market))
      .map((market) => ({
        id: market.id,
        label: market.label,
        role: normalizeDemoRole(market.role),
        market: market.market as string
      }));
  }
  return [{ id: "mkt_demo_green", label: "Legacy demo market", role: "legacy", market: arcDeployment.demoMarket }];
}

function normalizeDemoRole(role: string | undefined): DemoMarketConfig["role"] {
  if (role === "open" || role === "btc_price" || role === "london_weather" || role === "near_lock" || role === "resolved" || role === "legacy") return role;
  return undefined;
}

function roleForQuestion(question: string): DemoMarketConfig["role"] {
  const normalized = question.toLowerCase();
  if (normalized.includes("btc/usd") || normalized.includes("bitcoin")) return "btc_price";
  if (normalized.includes("london temperature") || normalized.includes("weather") || normalized.includes("open-meteo")) return "london_weather";
  return "open";
}

function shortHex(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatReferenceNumber(value: number | undefined): string {
  if (!Number.isFinite(value)) return "-";
  return (value as number).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

function marketDisplayName(market: DemoMarketConfig): string {
  return market.question ?? market.label ?? market.id ?? shortHex(market.market);
}

function marketOptionLabel(market: DemoMarketConfig): string {
  const parts = [marketDisplayName(market)];
  if (market.status) parts.push(market.status);
  if (market.role && market.role !== "legacy") parts.push(market.role.replace("_", " "));
  parts.push(shortHex(market.market));
  return parts.join(" · ");
}

function sameAddressSafe(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

function clampNumber(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function clampInteger(value: string, min: number, max: number): number {
  return Math.round(clampNumber(value, min, max));
}

function loadCreatedMarkets(): DemoMarketConfig[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("probx.createdMarkets");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((market) => typeof market?.market === "string") : [];
  } catch {
    return [];
  }
}

function saveCreatedMarkets(markets: DemoMarketConfig[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem("probx.createdMarkets", JSON.stringify(markets));
}

function uniqueMarkets(markets: DemoMarketConfig[]): DemoMarketConfig[] {
  const seen = new Set<string>();
  return markets.filter((market) => {
    const key = market.market.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readableAdminError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? Number((error as { code?: number }).code) : undefined;
  if (code === 4001) return "Transaction rejected in wallet.";
  const message = typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: string }).message)
    : "Admin transaction failed.";
  if (message.toLowerCase().includes("user rejected")) return "Transaction rejected in wallet.";
  return message;
}
