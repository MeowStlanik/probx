"use client";

import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCcw, ShieldCheck, ShoppingCart, Ticket, Wallet } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatUnits,
  getAddress,
  parseEventLogs,
  parseUnits
} from "viem";
import { SettlementCountdown } from "@/components/SettlementCountdown";
import { apiUrl } from "@/lib/api";
import { formatUsdc } from "@/lib/format";
import { arcDeployment, engineAbi, hasArcDeployment, marketAbi, poolAbi, usdcAbi } from "@/lib/onchain";
import { pushActivity } from "@/lib/activity";
import { formatFillOdds, latestPositionForMarket, savePosition, type LocalPosition } from "@/lib/positions";
import type { Market, Outcome } from "@/lib/types";
import { readableWalletError, shortHex, useWallet } from "@/lib/wallet";

type Quote = {
  price: bigint;
  payout: bigint;
  requiredReserve: bigint;
  fee: bigint;
  totalDebit: bigint;
  maxAvailableBoostBps: bigint;
  accepted: boolean;
  reason: string;
};

const marketStatuses = ["Created", "Open", "Locked", "Resolved", "Cancelled", "Archived"];

export function OnchainTradeTicket({ market }: { market?: Market }) {
  const {
    address: account,
    chainId: connectedChainId,
    connecting,
    connect,
    getWalletClient,
    publicClient
  } = useWallet();

  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [riskAmount, setRiskAmount] = useState("1");
  const [boost, setBoost] = useState("2");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint>(0n);
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [poolStats, setPoolStats] = useState({ tvl: 0n, reserved: 0n, available: 0n });
  const [marketStatus, setMarketStatus] = useState<number | null>(null);
  const [ticketId, setTicketId] = useState<bigint | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [message, setMessage] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [boughtPosition, setBoughtPosition] = useState<LocalPosition | null>(null);
  const [liveMarket, setLiveMarket] = useState(market);

  const selectedMarketAddress = getAddress(market?.contractAddress ?? arcDeployment.demoMarket);
  const selectedMarketId = market?.id ?? "mkt_demo_green";

  const risk = useMemo(() => {
    try {
      return parseUnits(riskAmount || "0", 6);
    } catch {
      return 0n;
    }
  }, [riskAmount]);

  const boostBps = useMemo(() => BigInt(Math.round(Number(boost || "1") * 10_000)), [boost]);
  const outcomeId = outcome === "YES" ? 1 : 2;

  const refresh = useCallback(async () => {
    if (!hasArcDeployment || risk <= 0n) return;
    const quoteResult = (await publicClient.readContract({
      address: getAddress(arcDeployment.microBoostEngine),
      abi: engineAbi,
      functionName: "quoteTicket",
      args: [selectedMarketAddress, outcomeId, risk, boostBps],
      account: account ?? undefined
    })) as Quote;

    const [tvl, reserved, available, status] = await Promise.all([
      publicClient.readContract({
        address: getAddress(arcDeployment.liquidityPool),
        abi: poolAbi,
        functionName: "managedAssets"
      }),
      publicClient.readContract({
        address: getAddress(arcDeployment.liquidityPool),
        abi: poolAbi,
        functionName: "reservedAssets"
      }),
      publicClient.readContract({
        address: getAddress(arcDeployment.liquidityPool),
        abi: poolAbi,
        functionName: "availableAssets"
      }),
      publicClient.readContract({
        address: selectedMarketAddress,
        abi: marketAbi,
        functionName: "status"
      })
    ]);

    setQuote(quoteResult);
    setPoolStats({ tvl, reserved, available });
    setMarketStatus(Number(status));

    if (account) {
      const [balance, approved] = await Promise.all([
        publicClient.readContract({
          address: getAddress(arcDeployment.usdc),
          abi: usdcAbi,
          functionName: "balanceOf",
          args: [account]
        }),
        publicClient.readContract({
          address: getAddress(arcDeployment.usdc),
          abi: usdcAbi,
          functionName: "allowance",
          args: [account, getAddress(arcDeployment.microBoostEngine)]
        })
      ]);
      setUsdcBalance(balance);
      setAllowance(approved);
    } else {
      setUsdcBalance(0n);
      setAllowance(0n);
    }
  }, [account, boostBps, outcomeId, publicClient, risk, selectedMarketAddress]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 12_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  // Refresh market flow odds after trades (volume-weighted YES/NO share).
  useEffect(() => {
    setLiveMarket(market);
    if (!market?.id) return;
    let cancelled = false;
    async function pullMarket() {
      try {
        const response = await fetch(apiUrl(`/api/markets/${encodeURIComponent(market!.id)}`), { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const next = (await response.json()) as Market;
        if (!cancelled) setLiveMarket(next);
      } catch {
        // Keep last known market payload.
      }
    }
    void pullMarket();
    const interval = window.setInterval(() => void pullMarket(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [market]);

  useEffect(() => {
    if (account) setMessage(`${shortHex(account)} connected — shared session`);
  }, [account]);

  // Restore last local buy for this market (entry + settle timer).
  useEffect(() => {
    const key = market?.contractAddress ?? market?.id ?? selectedMarketAddress;
    const existing = latestPositionForMarket(key);
    if (existing) {
      setBoughtPosition(existing);
      try {
        setTicketId(BigInt(existing.ticketId));
      } catch {
        // ignore
      }
    }
  }, [market?.contractAddress, market?.id, selectedMarketAddress]);

  async function handleConnect() {
    try {
      const next = await connect();
      setMessage(
        next
          ? `${shortHex(next)} connected`
          : "Wallet not connected — use Connect in the header"
      );
      await refresh();
    } catch (error) {
      setMessage(readableWalletError(error));
    }
  }

  async function approve() {
    if (!account || !quote) {
      setMessage(!account ? "Connect wallet first (header)." : "Wait for quote to load.");
      return;
    }
    const walletClient = getWalletClient();
    if (!walletClient) {
      setMessage("Wallet provider unavailable — reconnect in the header.");
      return;
    }
    setBusy(true);
    setMessage("Approving USDC…");
    try {
      const hash = await walletClient.writeContract({
        address: getAddress(arcDeployment.usdc),
        abi: usdcAbi,
        functionName: "approve",
        args: [getAddress(arcDeployment.microBoostEngine), quote.totalDebit]
      });
      setTxHash(hash);
      setMessage(`Approve sent ${shortHex(hash)} — waiting for Arc confirmation…`);
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      pushActivity({
        kind: "fund",
        title: "USDC approved",
        detail: `Allowance for engine · ${shortHex(hash)}`,
        txHash: hash
      });
      setMessage("USDC allowance approved");
      await refresh();
    } catch (error) {
      setMessage(readableWalletError(error));
    } finally {
      setBusy(false);
    }
  }

  async function buyTicket() {
    if (!account || !quote) {
      setMessage(!account ? "Connect wallet first (header)." : "Wait for quote to load.");
      return;
    }
    const walletClient = getWalletClient();
    if (!walletClient) {
      setMessage("Wallet provider unavailable — reconnect in the header.");
      return;
    }
    setBusy(true);
    setMessage("Buying ticket…");
    try {
      const hash = await walletClient.writeContract({
        address: getAddress(arcDeployment.microBoostEngine),
        abi: engineAbi,
        functionName: "buyTicket",
        args: [selectedMarketAddress, outcomeId, risk, boostBps]
      });
      setTxHash(hash);
      setMessage(`Buy sent ${shortHex(hash)} — waiting for confirmation…`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      const logs = parseEventLogs({ abi: engineAbi, logs: receipt.logs, eventName: "TicketBought" });
      const id = logs[0]?.args.ticketId;
      if (id) setTicketId(id);
      const opening = await captureOpenReference(id?.toString(), outcome, market ?? liveMarket);
      const m = market ?? liveMarket;
      if (id && quote) {
        const position: LocalPosition = {
          ticketId: id.toString(),
          marketId: m?.id ?? selectedMarketAddress,
          marketAddress: selectedMarketAddress,
          marketQuestion: m?.question,
          outcome,
          riskAmount: Number(formatUnits(risk, 6)),
          boost: Number(boost),
          fillPrice: Number(quote.price) / 1_000_000,
          payout: Number(formatUnits(quote.payout, 6)),
          fee: Number(formatUnits(quote.fee, 6)),
          referencePrice: opening?.referencePrice,
          referenceFeed: opening?.feed,
          referenceLabel: opening?.label,
          threshold: opening?.threshold,
          lockTime: m?.lockTime,
          observationEnd: m?.observationEnd,
          createdAt: new Date().toISOString(),
          txHash: hash
        };
        savePosition(position);
        setBoughtPosition(position);
        pushActivity({
          kind: "buy",
          title: `Bought ${outcome} ×${position.boost.toFixed(1)} boost · ${position.riskAmount} USDC`,
          detail: m?.question?.slice(0, 80),
          txHash: hash,
          marketId: position.marketId
        });
        window.dispatchEvent(new Event("probx-position-saved"));
        setMessage(
          `Bought ticket #${id.toString()}: ${outcome} · ${position.riskAmount} USDC risk · fill ${formatFillOdds(position.fillPrice)}.`
          + (opening ? ` Entry ${formatOpenValue(opening)}.` : "")
          + " Wait for lock + observation, then claim in Portfolio."
        );
      } else {
        setMessage("Ticket bought. Risk and LP reserve are locked until settlement.");
      }
      await refresh();
      // Pull updated on-chain odds after this buy.
      try {
        if (market?.id) {
          const response = await fetch(apiUrl(`/api/markets/${encodeURIComponent(market.id)}`), { cache: "no-store" });
          if (response.ok) setLiveMarket((await response.json()) as Market);
        }
      } catch {
        // ignore
      }
    } catch (error) {
      setMessage(readableWalletError(error));
    } finally {
      setBusy(false);
    }
  }

  async function settle() {
    if (!account || !ticketId) return;
    const walletClient = getWalletClient();
    if (!walletClient) {
      setMessage("Wallet provider unavailable.");
      return;
    }
    setBusy(true);
    try {
      const hash = await walletClient.writeContract({
        address: getAddress(arcDeployment.microBoostEngine),
        abi: engineAbi,
        functionName: "settleTicket",
        args: [ticketId]
      });
      setTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      setMessage(`Ticket #${ticketId.toString()} settled`);
      await refresh();
    } catch (error) {
      setMessage(readableWalletError(error));
    } finally {
      setBusy(false);
    }
  }

  if (!hasArcDeployment) {
    return null;
  }

  const needsApproval = quote ? allowance < quote.totalDebit : true;
  const wrongNetwork = connectedChainId !== null && connectedChainId !== arcDeployment.chainId;
  const insufficientUsdc = Boolean(account && quote && usdcBalance < quote.totalDebit);
  const insufficientReserve = Boolean(quote && quote.requiredReserve > poolStats.available);
  const effectiveMarketStatus = marketStatus === 1 && market && Date.now() >= Date.parse(market.lockTime) ? 2 : marketStatus;
  const marketUnavailable = effectiveMarketStatus !== null && effectiveMarketStatus !== 1;
  const canSettleLatestTicket = Boolean(ticketId && (marketStatus === 3 || marketStatus === 4));
  const blockingReason = buildBlockingReason({
    wrongNetwork,
    insufficientUsdc,
    insufficientReserve,
    marketUnavailable,
    marketStatus: effectiveMarketStatus,
    quote
  });
  const canBuy = Boolean(account && quote?.accepted && !needsApproval && !blockingReason);

  return (
    <section className="tradeSurface onchainSurface tradeSurfaceCompact" aria-label="Arc onchain trade ticket">
      <div className="surfaceHeader surfaceHeaderCompact">
        <div>
          <span className="eyebrow">Trade</span>
          <h2>Buy ticket</h2>
        </div>
        <button className="iconOnly" onClick={() => void refresh()} type="button" aria-label="Refresh onchain quote">
          <RefreshCcw size={16} aria-hidden />
        </button>
      </div>

      {(liveMarket?.lockTime || market?.lockTime) ? (
        <SettlementCountdown
          compact
          lockTime={liveMarket?.lockTime ?? market?.lockTime}
          observationEnd={liveMarket?.observationEnd ?? market?.observationEnd}
        />
      ) : null}

      {boughtPosition ? (
        <article className="boughtPositionCard" aria-live="polite">
          <div className="boughtPositionHeader">
            <Ticket size={18} aria-hidden />
            <div>
              <span className="eyebrow">You bought</span>
              <strong>Ticket #{boughtPosition.ticketId}</strong>
            </div>
            <span className="statusPill open">OPEN</span>
          </div>
          <div className="boughtPositionGrid">
            <div>
              <span>Side</span>
              <strong className={boughtPosition.outcome === "YES" ? "yesText" : "noText"}>{boughtPosition.outcome}</strong>
            </div>
            <div>
              <span>Risk (shares stake)</span>
              <strong>{formatUsdc(boughtPosition.riskAmount)} USDC</strong>
            </div>
            <div>
              <span>Boost</span>
              <strong>{boughtPosition.boost.toFixed(1)}x</strong>
            </div>
            <div>
              <span>Fill odds</span>
              <strong>{formatFillOdds(boughtPosition.fillPrice)}</strong>
            </div>
            <div>
              <span>Max payout</span>
              <strong>{formatUsdc(boughtPosition.payout)} USDC</strong>
            </div>
            <div>
              <span>Entry level</span>
              <strong>
                {boughtPosition.referencePrice !== undefined
                  ? formatOpenValue({
                      feed: boughtPosition.referenceFeed ?? "none",
                      referencePrice: boughtPosition.referencePrice,
                      label: boughtPosition.referenceLabel ?? "Entry"
                    })
                  : "—"}
              </strong>
            </div>
          </div>
          {boughtPosition.threshold !== undefined && Number.isFinite(boughtPosition.threshold) ? (
            <p className="boughtPositionMeta">
              Side <strong>{boughtPosition.outcome}</strong>
              {" · threshold "}
              <strong>
                {boughtPosition.referenceFeed === "btc"
                  ? `$${boughtPosition.threshold.toLocaleString("en-US")}`
                  : `${boughtPosition.threshold.toFixed(2)}°C`}
              </strong>
            </p>
          ) : null}
          <SettlementCountdown
            lockTime={boughtPosition.lockTime ?? liveMarket?.lockTime ?? market?.lockTime}
            observationEnd={boughtPosition.observationEnd ?? liveMarket?.observationEnd ?? market?.observationEnd}
          />
          <div className="boughtPositionActions">
            <Link className="iconButton settleButton" href="/portfolio">
              Open Portfolio to claim later
            </Link>
          </div>
        </article>
      ) : null}

      <div className="tradeBuyLayout">
        <div className="tradeBuyMain">
          {account ? (
            <div className="successBanner compactBanner" role="status">
              <CheckCircle2 size={16} aria-hidden />
              {shortHex(account)} connected
            </div>
          ) : (
            <p className="walletHint">Connect in the header once — session is shared.</p>
          )}

          <div className="outcomeSwitch outcomeSwitchCompact" role="group" aria-label="Select onchain outcome">
            <button
              aria-pressed={outcome === "YES"}
              className={outcome === "YES" ? "yes selected" : "yes"}
              onClick={() => setOutcome("YES")}
              type="button"
            >
              <span className="outcomeLabel">YES</span>
              <span className="outcomePrice">{formatPercentNumber(liveMarket?.yesPrice ?? market?.yesPrice ?? 0.5)}</span>
            </button>
            <button
              aria-pressed={outcome === "NO"}
              className={outcome === "NO" ? "no selected" : "no"}
              onClick={() => setOutcome("NO")}
              type="button"
            >
              <span className="outcomeLabel">NO</span>
              <span className="outcomePrice">{formatPercentNumber(liveMarket?.noPrice ?? market?.noPrice ?? 0.5)}</span>
            </button>
          </div>

          <label className="fieldLabel" htmlFor="onchainRisk">
            Risk amount
          </label>
          <div className="amountInput">
            <input
              id="onchainRisk"
              inputMode="decimal"
              onChange={(event) => setRiskAmount(event.target.value)}
              step="0.1"
              type="number"
              value={riskAmount}
            />
            <span>USDC</span>
          </div>

          <div className="fieldRow compactFieldRow">
            <label className="fieldLabel" htmlFor="onchainBoost">
              Micro Boost {Number(boost).toFixed(1)}x
            </label>
          </div>
          <input
            className="rangeInput boostRange"
            id="onchainBoost"
            max="5"
            min="1"
            onChange={(event) => setBoost(event.target.value)}
            step="0.5"
            type="range"
            value={boost}
          />
          <div className="boostVisual" aria-live="polite">
            <div className="boostVisualRow">
              <span>LP reserve covers payout</span>
              <strong>
                {quote
                  ? `${formatUsdcCompact(quote.requiredReserve)} / ${formatUsdcCompact(poolStats.available)} free`
                  : "…"}
              </strong>
            </div>
            <div className="boostMeter" aria-hidden>
              <span
                className="boostMeterFill"
                style={{
                  width: `${boostMeterPct(quote?.requiredReserve, poolStats.available)}%`
                }}
              />
            </div>
            <p className="boostVisualNote">
              Max loss = your stake only · boost multiplies payout.
            </p>
          </div>

          {blockingReason ? (
            <div className="failBanner compactBanner" role="alert">
              <AlertTriangle size={16} aria-hidden />
              {blockingReason}
            </div>
          ) : null}

          <div className="tradeActionStack">
            {!account ? (
              <button
                className="confirmButton"
                disabled={busy || connecting}
                onClick={() => void handleConnect()}
                type="button"
              >
                <Wallet size={18} aria-hidden />
                {connecting ? "Connecting…" : "Connect Arc wallet"}
              </button>
            ) : quote && needsApproval && !blockingReason ? (
              <button
                className="confirmButton"
                disabled={busy}
                onClick={approve}
                type="button"
              >
                {busy ? "Approving..." : `Approve ${formatUsdc6(quote.totalDebit)}`}
              </button>
            ) : (
              <button
                className="confirmButton"
                disabled={busy || !canBuy}
                onClick={buyTicket}
                type="button"
              >
                <ShoppingCart size={18} aria-hidden />
                {busy
                  ? "Waiting for wallet..."
                  : `Buy ${outcome} · ${riskAmount || "0"} USDC`}
              </button>
            )}

            {ticketId ? (
              <button className="iconButton settleButton" disabled={busy || !canSettleLatestTicket} onClick={settle} type="button">
                {canSettleLatestTicket
                  ? `Claim ticket #${ticketId.toString()}`
                  : `Ticket #${ticketId.toString()} — wait to claim`}
              </button>
            ) : null}
          </div>
        </div>

        <div className="tradeBuySide">
          <div className="previewGrid previewGridCompact">
            <div>
              <span className="metricLabel">
                <ShieldCheck size={14} aria-hidden />
                Wallet
              </span>
              <strong>{formatUsdc6(usdcBalance)}</strong>
            </div>
            <div>
              <span className="metricLabel">Payout</span>
              <strong>{quote ? formatUsdc6(quote.payout) : "-"}</strong>
            </div>
            <div>
              <span className="metricLabel">Reserve</span>
              <strong>{quote ? formatUsdc6(quote.requiredReserve) : "-"}</strong>
            </div>
            <div>
              <span className="metricLabel">LP free</span>
              <strong>{formatUsdc6(poolStats.available)}</strong>
            </div>
          </div>

          <div className="feeRow feeRowCompact">
            <span>Status</span>
            <strong>{effectiveMarketStatus === null ? "…" : marketStatuses[effectiveMarketStatus]}</strong>
          </div>
          <div className="feeRow feeRowCompact">
            <span>Quote</span>
            <strong>{quote?.accepted ? "OK" : quote?.reason ?? "…"}</strong>
          </div>
          <div className="feeRow feeRowCompact">
            <span>Fee / total</span>
            <strong>{quote ? `${formatUsdc6(quote.fee)} / ${formatUsdc6(quote.totalDebit)}` : "…"}</strong>
          </div>

          <div className="onchainAddressGrid onchainAddressGridCompact">
            <span>Engine</span>
            <a href={`${arcDeployment.explorerUrl}/address/${arcDeployment.microBoostEngine}`} target="_blank" rel="noreferrer">
              {shortHex(arcDeployment.microBoostEngine)} <ExternalLink size={12} aria-hidden />
            </a>
            <span>Market</span>
            <a href={`${arcDeployment.explorerUrl}/address/${selectedMarketAddress}`} target="_blank" rel="noreferrer">
              {shortHex(selectedMarketAddress)} <ExternalLink size={12} aria-hidden />
            </a>
          </div>
        </div>
      </div>

      {txHash ? (
        <a className="txLink" href={`${arcDeployment.explorerUrl}/tx/${txHash}`} target="_blank" rel="noreferrer">
          View tx <ExternalLink size={13} aria-hidden />
        </a>
      ) : null}
      <p className="settlementNote">{message}</p>
    </section>
  );
}

function boostMeterPct(required?: bigint | null, available?: bigint | null): number {
  if (!required || required <= 0n) return 0;
  if (!available || available <= 0n) return 100;
  const pct = Number((required * 1000n) / available) / 10;
  return Math.max(4, Math.min(100, pct));
}

function buildBlockingReason({
  wrongNetwork,
  insufficientUsdc,
  insufficientReserve,
  marketUnavailable,
  marketStatus,
  quote
}: {
  wrongNetwork: boolean;
  insufficientUsdc: boolean;
  insufficientReserve: boolean;
  marketUnavailable: boolean;
  marketStatus: number | null;
  quote: Quote | null;
}): string | null {
  if (wrongNetwork) return `Wrong network. Switch wallet to ${arcDeployment.chainName} (${arcDeployment.chainId}).`;
  if (insufficientUsdc) {
    return "Not enough USDC on your wallet for stake + fee. Use “No USDC — add funds” in the header.";
  }
  if (insufficientReserve) return "Insufficient LP reserve for this boost. Lower the amount or boost.";
  if (marketUnavailable) return `Market is ${marketStatuses[marketStatus ?? 0]?.toLowerCase() ?? "not open"}; buys are only allowed while open.`;
  if (quote && !quote.accepted) return readableQuoteReason(quote.reason);
  return null;
}

function readableQuoteReason(reason: string): string {
  const normalized = reason.toLowerCase();
  if (normalized.includes("locked")) return "Market locked. Try the OPEN demo market.";
  if (normalized.includes("reserve") || normalized.includes("liquidity")) {
    return "Insufficient LP reserve for this quote.";
  }
  if (normalized.includes("oracle") && (normalized.includes("early") || normalized.includes("late"))) {
    return "Oracle timing window is not valid yet, or it has already passed.";
  }
  return reason || "Quote rejected by contract.";
}

function formatUsdc6(value: bigint): string {
  return `${Number(formatUnits(value, 6)).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`;
}

function formatUsdcCompact(value: bigint): string {
  return `${Number(formatUnits(value, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`;
}

function formatPercentNumber(value: number): string {
  const pct = value * 100;
  if (!Number.isFinite(pct)) return "—";
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function formatUsdcPlain(value: number): string {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;
}

function formatOpenValue(opening: { feed: "btc" | "weather" | "none"; referencePrice: number; label: string }): string {
  if (opening.feed === "btc") {
    return `${opening.label} $${opening.referencePrice.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (opening.feed === "weather") {
    return `${opening.label} ${opening.referencePrice.toFixed(2)}°C`;
  }
  return `${opening.label} ${opening.referencePrice}`;
}

async function captureOpenReference(
  ticketId: string | undefined,
  outcome: Outcome,
  market?: Market
): Promise<{
  ticketId: string;
  referencePrice: number;
  feed: "btc" | "weather" | "none";
  label: string;
  threshold?: number;
} | null> {
  if (!ticketId) return null;
  try {
    const response = await fetch(apiUrl("/api/demo-data"), { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json() as {
      btcUsd?: { price?: number; source?: string };
      londonWeather?: { temperatureC?: number; source?: string };
    };
    const role = market?.demoRole;
    const question = market?.question ?? "";
    let feed: "btc" | "weather" | "none" = "none";
    let referencePrice = Number.NaN;
    let label = "Reference";
    let source: string | undefined;
    let threshold: number | undefined;

    if (role === "btc_price" || market?.category === "crypto-candle" || /btc|bitcoin/i.test(question)) {
      feed = "btc";
      referencePrice = Number(data.btcUsd?.price);
      label = "BTC/USD";
      source = data.btcUsd?.source;
      const match = question.match(/above\s+\$?([\d,]+(?:\.\d+)?)/i);
      threshold = match ? Number(match[1].replace(/,/g, "")) : undefined;
    } else if (role === "london_weather" || market?.category === "weather" || /london|weather/i.test(question)) {
      feed = "weather";
      referencePrice = Number(data.londonWeather?.temperatureC);
      label = "London temp";
      source = data.londonWeather?.source;
      const match = question.match(/at least\s+(-?[\d.]+)\s*C/i);
      threshold = match ? Number(match[1]) : undefined;
    }

    if (!Number.isFinite(referencePrice)) return null;

    await fetch(apiUrl("/api/tickets/open-meta"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId,
        marketId: market?.id,
        marketAddress: market?.contractAddress,
        outcome,
        referencePrice,
        referenceFeed: feed,
        threshold,
        source
      })
    }).catch(() => undefined);

    return { ticketId, referencePrice, feed, label, threshold };
  } catch {
    return null;
  }
}
