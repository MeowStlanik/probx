"use client";

import { type ReactNode, useEffect, useState } from "react";
import { theme } from "../theme";
import type { ActivityRow, LoadState, MarketDetail, Side } from "../types";
import { LifecycleBar, LifecycleLabels } from "../components/MarketCard";
import { ActivityTable } from "../components/Tables";
import { AmountInput } from "../components/AmountInput";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";

interface Props {
  state: LoadState;
  market: MarketDetail | null;
  activity: ActivityRow[];
  onRetry: () => void;
  onBack: () => void;
  /** True when engine allowance is below the quoted total debit for current stake/boost. */
  needsApproval: boolean;
  /** Debounced quote refresh when ticket inputs change. */
  onPreviewQuote?: (side: Side, stake: number, boost: number) => void;
  onApprove: (side: Side, stake: number, boost: number) => Promise<void>;
  onConfirmTicket: (side: Side, stake: number, boost: number) => Promise<{ txHash: string; gas: string }>;
  /** Live feed chart (btc/weather) from shell — replaces placeholder. */
  chart?: ReactNode;
}

function fmtClock(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Simple sparkline from priceHistory (0–1 samples)
function OddsSparkline({ samples }: { samples: number[] }) {
  if (!samples.length) return null;
  const w = 560;
  const h = 200;
  const pad = 12;
  const min = Math.min(...samples, 0.05);
  const max = Math.max(...samples, 0.95);
  const span = Math.max(0.01, max - min);
  const pts = samples
    .map((v, i) => {
      const x = pad + (i / Math.max(1, samples.length - 1)) * (w - pad * 2);
      const y = pad + (1 - (v - min) / span) * (h - pad * 2);
      return `${x},${y}`;
    })
    .join(" ");
  const last = samples[samples.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 220, display: "block" }} role="img" aria-label="YES odds history">
      <rect x={0} y={0} width={w} height={h} fill={theme.color.tint} rx={8} />
      <polyline fill="none" stroke={theme.color.yes} strokeWidth={2.5} points={pts} />
      <text x={pad} y={h - 4} fontSize={11} fill={theme.color.muted} fontFamily={theme.font.mono}>
        YES {(last * 100).toFixed(1)}%
      </text>
    </svg>
  );
}

export function MarketDetailView({
  state,
  market,
  activity,
  onRetry,
  onBack,
  needsApproval,
  onPreviewQuote,
  onApprove,
  onConfirmTicket,
  chart
}: Props) {
  const [side, setSide] = useState<Side>("YES");
  const [stake, setStake] = useState("1");
  const maxBoost = market?.maxBoost ?? 5;
  const [boost, setBoost] = useState(Math.min(2, maxBoost));
  const [receipt, setReceipt] = useState<{ txHash: string; gas: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Keep boost within market max when market loads / changes
    setBoost((b) => Math.min(b, maxBoost));
  }, [maxBoost]);

  // Keep shell allowance / totalDebit in sync with ticket inputs
  useEffect(() => {
    if (!market || !onPreviewQuote) return;
    const stakeN = Number(stake) || 0;
    if (stakeN <= 0) return;
    const t = window.setTimeout(() => onPreviewQuote(side, stakeN, boost), 350);
    return () => window.clearTimeout(t);
  }, [market, side, stake, boost, onPreviewQuote]);

  return (
    <main style={{ maxWidth: theme.layout.maxWidth, margin: "0 auto", padding: "32px 24px 80px", flex: 1 }}>
      <button
        onClick={onBack}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 13,
          color: theme.color.muted,
          padding: 0,
          marginBottom: 20
        }}
      >
        ← All markets
      </button>

      {state === "error" && !market && (
        <EmptyState
          tone="error"
          title="Couldn't load this market"
          description="It may have been removed, or the Arc RPC call failed."
          action={
            <button
              onClick={onRetry}
              style={{
                background: theme.color.ink,
                color: "#fff",
                border: "none",
                borderRadius: 9,
                padding: "9px 16px",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer"
              }}
            >
              Retry
            </button>
          }
        />
      )}

      {state === "loading" && !market && (
        <div>
          <div style={{ height: 20, width: 120, borderRadius: 5, background: theme.color.tint }} />
          <div style={{ height: 30, width: "70%", borderRadius: 6, background: theme.color.tint, marginTop: 14 }} />
          <div style={{ height: 110, borderRadius: 12, background: theme.color.tint, marginTop: 20 }} />
        </div>
      )}

      {market && (
        <>
          <div style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span
                suppressHydrationWarning
                style={{
                  fontFamily: theme.font.mono,
                  fontSize: 26,
                  fontWeight: 600,
                  color: theme.color.ink,
                  fontVariantNumeric: "tabular-nums",
                  letterSpacing: ".02em"
                }}
              >
                {fmtClock(market.secondsToNextStage)}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: theme.color.yes,
                  background: theme.color.yesSoft,
                  borderRadius: 6,
                  padding: "3px 8px"
                }}
              >
                {market.stage}
              </span>
            </div>
            <h1 style={{ fontSize: 28, fontWeight: 600, color: theme.color.ink, maxWidth: "32ch", lineHeight: 1.18 }}>
              {market.question}
            </h1>
            <p style={{ fontSize: 13, color: theme.color.muted, margin: "10px 0 0" }}>
              Resolves from {market.resolutionSource} · market{" "}
              <a
                href={`https://testnet.arcscan.app/address/${market.marketAddress}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontFamily: theme.font.mono, color: theme.color.purple }}
              >
                {market.marketAddress.slice(0, 6)}…{market.marketAddress.slice(-4)} ↗
              </a>
            </p>
          </div>

          <div
            style={{
              marginTop: 20,
              background: "#fff",
              border: `1px solid ${theme.color.border}`,
              borderRadius: 12,
              boxShadow: theme.shadow.card,
              padding: 20
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Market lifecycle</span>
              <span style={{ fontSize: 11.5, color: theme.color.muted, fontFamily: theme.font.mono }}>
                now · {market.stage}
              </span>
            </div>
            <LifecycleBar nowPct={market.nowPct} height={8} />
            {/* Same widths as bar segments — equal spacing put "PAUSE" under the OPEN end marker */}
            <LifecycleLabels active={market.stage} />
          </div>

          <div
            style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20, alignItems: "start" }}
            data-breakpoint="720:1fr"
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div
                style={{
                  background: "#fff",
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 12,
                  boxShadow: theme.shadow.card,
                  padding: 20
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>
                  {chart ? "Live reference" : "Price history"}
                </span>
                <div style={{ marginTop: 14 }}>
                  {chart ?? <OddsSparkline samples={market.priceHistory} />}
                </div>
              </div>

              <div
                style={{
                  background: "#fff",
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 12,
                  boxShadow: theme.shadow.card,
                  padding: 20
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>How this market is priced</span>
                <div style={{ marginTop: 16, display: "flex", alignItems: "stretch", gap: 10, flexWrap: "wrap" }}>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 90,
                      textAlign: "center",
                      background: theme.color.tint,
                      border: `1px solid ${theme.color.border}`,
                      borderRadius: 10,
                      padding: "14px 8px"
                    }}
                  >
                    <div style={{ fontSize: 11, color: theme.color.muted }}>Fair mid</div>
                    <div
                      style={{
                        fontFamily: theme.font.mono,
                        fontSize: 19,
                        fontWeight: 600,
                        color: theme.color.ink,
                        marginTop: 4
                      }}
                    >
                      {(market.fairMid * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 90,
                      textAlign: "center",
                      background: theme.color.yesSoft,
                      border: `1px solid ${theme.color.yesBorder}`,
                      borderRadius: 10,
                      padding: "14px 8px"
                    }}
                  >
                    <div style={{ fontSize: 11, color: theme.color.yes }}>Quoted YES</div>
                    <div
                      style={{
                        fontFamily: theme.font.mono,
                        fontSize: 19,
                        fontWeight: 600,
                        color: theme.color.yes,
                        marginTop: 4
                      }}
                    >
                      {(market.quotedYes * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 90,
                      textAlign: "center",
                      background: theme.color.blueSoft,
                      border: "1px solid #CFE2F5",
                      borderRadius: 10,
                      padding: "14px 8px"
                    }}
                  >
                    <div style={{ fontSize: 11, color: theme.color.blue }}>Max boost</div>
                    <div
                      style={{
                        fontFamily: theme.font.mono,
                        fontSize: 19,
                        fontWeight: 600,
                        color: theme.color.blue,
                        marginTop: 4
                      }}
                    >
                      {maxBoost.toFixed(1)}×
                    </div>
                  </div>
                </div>
              </div>

              <div
                style={{
                  background: "#fff",
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 12,
                  boxShadow: theme.shadow.card,
                  padding: 20,
                  overflowX: "auto"
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Recent activity</span>
                {activity.length ? (
                  <ActivityTable rows={activity} />
                ) : (
                  <EmptyState title="No activity yet" description="Be the first to buy a ticket on this market." />
                )}
              </div>

              <div
                style={{
                  background: "#fff",
                  border: `1px solid ${theme.color.border}`,
                  borderRadius: 12,
                  boxShadow: theme.shadow.card,
                  padding: 20
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Resolution</span>
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: theme.color.muted }}>Data source</span>
                    <span style={{ color: theme.color.ink }}>{market.resolutionSource}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: theme.color.muted }}>Rule</span>
                    <span style={{ color: theme.color.ink, textAlign: "right", maxWidth: "60%" }}>
                      YES if last print meets the threshold at window close
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div
              style={{
                background: "#fff",
                border: `1px solid ${theme.color.border}`,
                borderRadius: 12,
                boxShadow: theme.shadow.card,
                padding: 20,
                position: "sticky",
                top: 88
              }}
            >
              {!receipt ? (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <h2 style={{ fontSize: 16, fontWeight: 600, color: theme.color.ink, margin: 0 }}>Buy ticket</h2>
                    <span style={{ fontSize: 11, color: theme.color.muted, fontFamily: theme.font.mono }}>
                      max loss = stake
                    </span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
                    <button
                      type="button"
                      onClick={() => setSide("YES")}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                        padding: 12,
                        borderRadius: 11,
                        cursor: "pointer",
                        color: theme.color.yes,
                        border: side === "YES" ? `1.5px solid ${theme.color.yes}` : `1px solid ${theme.color.border}`,
                        background: side === "YES" ? "#F1F9F5" : "#fff"
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 600 }}>YES</span>
                      <span style={{ fontFamily: theme.font.mono, fontSize: 20, fontWeight: 600 }}>
                        {(market.quotedYes * 100).toFixed(1)}%
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSide("NO")}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 3,
                        padding: 12,
                        borderRadius: 11,
                        cursor: "pointer",
                        color: theme.color.no,
                        border: side === "NO" ? `1.5px solid ${theme.color.no}` : `1px solid ${theme.color.border}`,
                        background: side === "NO" ? "#FCF5F4" : "#fff"
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 600 }}>NO</span>
                      <span style={{ fontFamily: theme.font.mono, fontSize: 20, fontWeight: 600 }}>
                        {((1 - market.quotedYes) * 100).toFixed(1)}%
                      </span>
                    </button>
                  </div>
                  <label style={{ display: "block", fontSize: 12, color: theme.color.muted, margin: "18px 0 6px", fontWeight: 500 }}>
                    Stake (USDC)
                  </label>
                  <AmountInput value={stake} onChange={setStake} />
                  <div style={{ marginTop: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: theme.color.muted, fontWeight: 500 }}>
                        Boost (max {maxBoost.toFixed(1)}×)
                      </span>
                      <span style={{ fontFamily: theme.font.mono, fontSize: 14, fontWeight: 600, color: theme.color.ink }}>
                        {boost.toFixed(1)}×
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={maxBoost}
                      step={0.1}
                      value={boost}
                      onChange={(e) => setBoost(Number(e.target.value))}
                      style={{ width: "100%" }}
                    />
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginTop: 4,
                        fontSize: 11,
                        color: theme.color.muted,
                        fontFamily: theme.font.mono
                      }}
                    >
                      <span>1×</span>
                      <span>{maxBoost.toFixed(1)}×</span>
                    </div>
                  </div>
                  <div style={{ marginTop: 20, borderTop: `1px solid ${theme.color.border}`, paddingTop: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13 }}>
                      <span style={{ color: theme.color.muted }}>Stake</span>
                      <span style={{ fontFamily: theme.font.mono, color: theme.color.ink }}>
                        {money(Number(stake) || 0)}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        padding: "12px 0 4px",
                        marginTop: 4,
                        borderTop: `1px solid ${theme.color.border}`
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Est. payout</span>
                      <span style={{ fontFamily: theme.font.mono, fontSize: 26, fontWeight: 600, color: theme.color.yes }}>
                        {money(
                          ((Number(stake) || 0) /
                            Math.max(0.05, side === "YES" ? market.quotedYes : 1 - market.quotedYes)) *
                            boost
                        )}
                      </span>
                    </div>
                  </div>
                  {needsApproval ? (
                    <p style={{ margin: "12px 0 0", fontSize: 12, color: theme.color.muted, lineHeight: 1.4 }}>
                      First <strong>Approve USDC</strong> for the engine, then the button becomes Confirm.
                    </p>
                  ) : null}
                  <Button
                    fullWidth
                    disabled={busy}
                    style={{ marginTop: 14 }}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        if (needsApproval) {
                          await onApprove(side, Number(stake) || 0, boost);
                        } else {
                          setReceipt(await onConfirmTicket(side, Number(stake) || 0, boost));
                        }
                      } catch (e) {
                        window.alert(e instanceof Error ? e.message : "Ticket failed");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy
                      ? needsApproval
                        ? "Approving…"
                        : "Confirming…"
                      : needsApproval
                        ? "Approve USDC"
                        : `Confirm · $${stake} USDC → payout if ${side}`}
                  </Button>
                  <p style={{ textAlign: "center", fontSize: 11, color: theme.color.muted, margin: "10px 0 0" }}>
                    Gas paid in USDC · you can only lose your stake.
                  </p>
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: theme.color.yesSoft,
                        color: theme.color.yes,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 13
                      }}
                    >
                      ✓
                    </span>
                    <h2 style={{ fontSize: 16, fontWeight: 600, color: theme.color.ink, margin: 0 }}>Ticket confirmed</h2>
                  </div>
                  <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                      <span style={{ color: theme.color.muted }}>tx hash</span>
                      <a
                        href={`https://testnet.arcscan.app/tx/${receipt.txHash}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontFamily: theme.font.mono, color: theme.color.purple }}
                      >
                        {receipt.txHash.slice(0, 8)}…{receipt.txHash.slice(-4)} ↗
                      </a>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 12.5,
                        borderTop: `1px solid ${theme.color.border}`,
                        paddingTop: 10
                      }}
                    >
                      <span style={{ color: theme.color.muted }}>gas</span>
                      <span style={{ fontFamily: theme.font.mono, color: theme.color.ink }}>{receipt.gas}</span>
                    </div>
                  </div>
                  <Button variant="secondary" fullWidth style={{ marginTop: 16 }} onClick={() => setReceipt(null)}>
                    Buy another ticket
                  </Button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </main>
  );
}
