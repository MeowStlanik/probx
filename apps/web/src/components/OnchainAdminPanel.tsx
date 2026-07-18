"use client";

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
  // Redesigned admin form state (matches the Arc UI spec).
  const [category, setCategory] = useState<"crypto" | "weather" | "network">("crypto");
  const [duration, setDuration] = useState("60");
  const [source, setSource] = useState("Coinbase BTC/USD");
  const [resolverOpen, setResolverOpen] = useState(false);
  const [resolverAddress, setResolverAddress] = useState("");
  const [resolveOutcome, setResolveOutcome] = useState<"YES" | "NO" | null>(null);

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

  // Map the redesigned category tabs onto the existing backend templates and
  // default the resolution source + placeholder question.
  function selectCategory(next: "crypto" | "weather" | "network") {
    setCategory(next);
    if (next === "crypto") {
      applyTemplate("btc");
      setSource("Coinbase BTC/USD");
    } else if (next === "weather") {
      applyTemplate("weather");
      setSource("Open-Meteo London");
    } else {
      applyTemplate("demo");
      setSource("Arc block time");
    }
  }

  // Create using the current form, honoring the selected duration as lock seconds.
  async function createFromForm() {
    setNewLockSeconds(duration);
    await createAndOpenMarket();
  }

  async function forceResolveSelected() {
    if (!resolveOutcome) {
      setStatus("Pick Force YES or Force NO first.");
      return;
    }
    if (resolverAddress.trim()) {
      setSelectedMarket(resolverAddress.trim());
    }
    await resolve(resolveOutcome === "YES" ? 1 : 2);
  }

  const questionPlaceholder =
    category === "crypto"
      ? "BTC/USD above $X in the next window?"
      : category === "weather"
        ? "London temperature above X°C in the next window?"
        : "Arc block time under X seconds?";

  return (
    <section className="adminPanel adminCreateCol">
      <div className="adminCreatePanel adminCreatePanelPrimary">
        <span className="adminCardTitle">Create test market</span>
        <div className="adminCategoryTabs">
          {(["crypto", "weather", "network"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`adminCategoryTab ${category === key ? "isActive" : ""}`}
              onClick={() => selectCategory(key)}
            >
              {key === "crypto" ? "Crypto" : key === "weather" ? "Weather" : "Network"}
            </button>
          ))}
        </div>

        <label className="adminField">
          <span>Question</span>
          <input
            value={newQuestion}
            placeholder={questionPlaceholder}
            onChange={(event) => setNewQuestion(event.target.value)}
          />
        </label>

        <div className="adminCreateGrid two">
          <label className="adminField">
            <span>Duration</span>
            <select value={duration} onChange={(event) => setDuration(event.target.value)}>
              <option value="60">60 seconds</option>
              <option value="300">5 minutes</option>
              <option value="3600">1 hour</option>
            </select>
          </label>
          <label className="adminField">
            <span>Resolution source</span>
            <input value={source} onChange={(event) => setSource(event.target.value)} />
          </label>
        </div>

        <button
          className="confirmButton"
          disabled={busy || !newQuestion.trim()}
          onClick={() => void createFromForm()}
          type="button"
        >
          {busy ? "Creating…" : "Create market on Arc"}
        </button>

        {createdMarketAddress ? (
          <div className="adminCreatedBanner">
            Market created ·{" "}
            <a href={`/markets/${createdMarketAddress}`}>open {shortHex(createdMarketAddress)}</a>
            {txHash ? (
              <>
                {" · "}
                <a href={`${arcDeployment.explorerUrl}/tx/${txHash}`} target="_blank" rel="noreferrer" className="mono">
                  tx {txHash.slice(0, 6)} ↗
                </a>
              </>
            ) : null}
          </div>
        ) : null}
        {status && status !== "Ready" ? <p className="settlementNote">{status}</p> : null}
      </div>

      <div className="adminCreatePanel">
        <button
          type="button"
          className="adminResolverToggle"
          onClick={() => setResolverOpen((open) => !open)}
        >
          <span className="adminCardTitle">Resolver tools (manual override)</span>
          <span className="adminResolverToggleHint">{resolverOpen ? "Hide ▲" : "Show ▼"}</span>
        </button>

        {resolverOpen ? (
          <div className="adminResolverBody">
            <label className="adminField">
              <span>Market address</span>
              <input
                className="mono"
                value={resolverAddress}
                placeholder={selectedMarket ? shortHex(selectedMarket) : "0x6644…e900"}
                onChange={(event) => setResolverAddress(event.target.value)}
              />
            </label>
            <div className="adminForceGrid">
              <button
                type="button"
                className={`adminForceBtn yes ${resolveOutcome === "YES" ? "isActive" : ""}`}
                onClick={() => setResolveOutcome("YES")}
              >
                Force YES
              </button>
              <button
                type="button"
                className={`adminForceBtn no ${resolveOutcome === "NO" ? "isActive" : ""}`}
                onClick={() => setResolveOutcome("NO")}
              >
                Force NO
              </button>
            </div>
            <button
              type="button"
              className="adminForceResolve"
              disabled={busy || !resolveOutcome}
              onClick={() => void forceResolveSelected()}
            >
              {busy ? "Resolving…" : "Force resolve"}
            </button>
          </div>
        ) : null}
      </div>
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
