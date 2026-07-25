"use client";

import { useMemo, useState } from "react";
import { theme } from "../theme";
import type { LpLedgerRow } from "../types";
import { LpLedgerTable } from "../components/Tables";
import { AmountInput } from "../components/AmountInput";
import { Button } from "../components/Button";

export type LpAction = "approve" | "deposit" | "withdraw";
export type LpAnyChainSource = "Base_Sepolia" | "Ethereum_Sepolia";

/** Pending Unified Balance spend after deposit succeeded (recovery UX). */
export type PendingUbSpendUi = {
  source: LpAnyChainSource;
  amount: string;
  recipientAddress: string;
  sourceWalletAddress?: string;
  depositHash?: string | null;
};

interface Props {
  tvl: string;
  reserved: string;
  available: string;
  utilization: string;
  ledger: LpLedgerRow[];
  apy: string;
  yourShare: string;
  /** Current USDC allowance to the vault (human units). */
  allowanceUsdc: number;
  onAction: (action: LpAction, amount: number) => Promise<string>;
  /** Multichain fund → Arc → optional vault deposit via App Kit. */
  onAnyChainDeposit?: (source: LpAnyChainSource, amount: number) => Promise<string>;
  /** Spend-only recovery after a successful UB deposit. */
  pendingUbSpend?: PendingUbSpendUi | null;
  onCompleteUbSpend?: () => Promise<string>;
  onDismissUbSpend?: () => void;
  /** When true, vault has open ticket reserves — deposit/withdraw blocked on-chain. */
  riskEpochActive?: boolean;
  /** Human estimate for when deposit/withdraw unlocks (hackathon epoch UX). */
  unlockEta?: string | null;
}

// /lp — vault stats, recent deposits, deposit/withdraw + App Kit multichain fund.
export function LPView({
  tvl,
  reserved,
  available,
  utilization,
  ledger,
  apy,
  yourShare,
  allowanceUsdc,
  onAction,
  onAnyChainDeposit,
  pendingUbSpend,
  onCompleteUbSpend,
  onDismissUbSpend,
  riskEpochActive = false,
  unlockEta = null
}: Props) {
  const [tab, setTab] = useState<"deposit" | "withdraw" | "anychain">("deposit");
  const [amount, setAmount] = useState("1");
  const [anySource, setAnySource] = useState<LpAnyChainSource>("Base_Sepolia");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const amountNum = Number(amount) || 0;
  const needsApproval = tab === "deposit" && amountNum > 0 && amountNum > allowanceUsdc + 1e-9;

  const buttonLabel = useMemo(() => {
    if (busy) return "Working…";
    if (tab === "withdraw") return "Withdraw USDC";
    if (tab === "anychain") return "Bridge → Arc & deposit";
    if (needsApproval) return "Approve USDC";
    return "Deposit USDC";
  }, [tab, needsApproval, busy]);

  const stat = (label: string, value: string, color: string = theme.color.ink) => (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${theme.color.border}`,
        borderRadius: 12,
        boxShadow: theme.shadow.card,
        padding: 20
      }}
    >
      <div style={{ fontSize: 11.5, color: theme.color.muted }}>{label}</div>
      <div style={{ fontFamily: theme.font.mono, fontSize: 24, fontWeight: 600, color, marginTop: 4 }}>{value}</div>
    </div>
  );

  const isError =
    message &&
    /fail|error|not enough|exceed|unavailable|reject|wrong network|switch|retry spend|deposit succeeded, but spend/i.test(
      message
    );

  return (
    <main style={{ maxWidth: theme.layout.maxWidth, margin: "0 auto", padding: "40px 24px 72px", flex: 1 }}>
      <h1 style={{ fontSize: 26, fontWeight: 600, color: theme.color.ink }}>LP vault</h1>
      <p style={{ fontSize: 13.5, color: theme.color.muted, margin: "6px 0 28px" }}>
        Liquidity underwriting every Micro Boost ticket on Arc. Deposit on Arc or fund from any CCTP chain via{" "}
        <strong>Circle App Kit</strong>.
      </p>
      {riskEpochActive ? (
        <div
          style={{
            marginBottom: 16,
            padding: "12px 14px",
            borderRadius: 10,
            background: theme.color.blueSoft,
            border: `1px solid ${theme.color.border}`,
            fontSize: 13,
            color: theme.color.ink,
            lineHeight: 1.45
          }}
        >
          <strong>Open ticket reserves</strong> — {reserved} USDC is ring-fenced for live tickets. Free capital (
          {available} USDC) stays depositable/withdrawable; only the reserved slice is locked until settlement.
          {unlockEta ? (
            <div style={{ marginTop: 6, color: theme.color.muted }}>
              Full reserved unlock: <strong style={{ color: theme.color.ink }}>{unlockEta}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 16 }}>
        {stat("TVL", tvl)}
        {stat("Reserved", reserved, theme.color.blue)}
        {stat("Available", available, theme.color.yes)}
        {stat("Utilization", utilization)}
      </div>

      <div
        style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}
        data-breakpoint="720:1fr"
      >
        <div
          style={{
            background: "#fff",
            border: `1px solid ${theme.color.border}`,
            borderRadius: 12,
            boxShadow: theme.shadow.card,
            padding: 20,
            overflowX: "auto",
            minHeight: 280
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Recent deposits</span>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: theme.color.muted }}>
            Last vault deposits &amp; withdraws (up to 5)
          </p>
          <LpLedgerTable rows={ledger} />
        </div>

        <div
          style={{
            background: "#fff",
            border: `1px solid ${theme.color.border}`,
            borderRadius: 12,
            boxShadow: theme.shadow.card,
            padding: 20,
            position: "sticky",
            top: 88,
            minHeight: 280
          }}
        >
          <div style={{ display: "flex", gap: 6, background: theme.color.tint, borderRadius: 9, padding: 4 }}>
            {(
              [
                ["deposit", "Deposit"],
                ["withdraw", "Withdraw"],
                ["anychain", "Any chain"]
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setTab(t);
                  setMessage(null);
                }}
                style={{
                  flex: 1,
                  border: "none",
                  borderRadius: 7,
                  padding: 9,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: theme.font.sans,
                  background: tab === t ? "#fff" : "transparent",
                  color: tab === t ? theme.color.ink : theme.color.muted,
                  boxShadow: tab === t ? "0 1px 2px rgba(16,32,64,.08)" : "none"
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {pendingUbSpend && onCompleteUbSpend ? (
            <div
              style={{
                marginTop: 14,
                padding: "12px 12px",
                borderRadius: 10,
                background: theme.color.blueSoft,
                border: `1px solid ${theme.color.border}`,
                fontSize: 12.5,
                color: theme.color.ink,
                lineHeight: 1.45
              }}
            >
              <strong>Unified Balance deposit succeeded</strong> — spend to Arc still needs to finish.
              <br />
              <span style={{ color: theme.color.muted, fontSize: 12 }}>
                {pendingUbSpend.amount} USDC · {pendingUbSpend.source.replace("_", " ")}
                {pendingUbSpend.sourceWalletAddress
                  ? ` · source ${pendingUbSpend.sourceWalletAddress.slice(0, 6)}…${pendingUbSpend.sourceWalletAddress.slice(-4)}`
                  : ""}
                {pendingUbSpend.depositHash
                  ? ` · deposit ${pendingUbSpend.depositHash.slice(0, 10)}…`
                  : ""}
              </span>
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setMessage(null);
                    setTab("anychain");
                    try {
                      setMessage(await onCompleteUbSpend());
                    } catch (e) {
                      setMessage(e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Working…" : "Complete transfer from Unified Balance"}
                </Button>
                {onDismissUbSpend ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onDismissUbSpend();
                      setMessage(null);
                    }}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: theme.color.muted,
                      fontSize: 12,
                      cursor: "pointer",
                      textDecoration: "underline",
                      fontFamily: theme.font.sans
                    }}
                  >
                    Dismiss
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "anychain" ? (
            <>
              <p style={{ margin: "14px 0 0", fontSize: 12.5, color: theme.color.muted, lineHeight: 1.45 }}>
                Uses <strong>Circle App Kit</strong> (Unified Balance when available, else CCTP bridge) to move USDC
                onto Arc, then deposits into this vault. Requires a browser wallet on the source chain.
              </p>
              <label
                style={{ display: "block", fontSize: 12, color: theme.color.muted, margin: "14px 0 6px", fontWeight: 500 }}
              >
                Source chain
              </label>
              <select
                value={anySource}
                onChange={(e) => setAnySource(e.target.value as LpAnyChainSource)}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: `1px solid ${theme.color.border}`,
                  fontSize: 13,
                  fontFamily: theme.font.sans,
                  background: "#fff"
                }}
              >
                <option value="Base_Sepolia">Base Sepolia</option>
                <option value="Ethereum_Sepolia">Ethereum Sepolia</option>
              </select>
            </>
          ) : null}

          <label style={{ display: "block", fontSize: 12, color: theme.color.muted, margin: "18px 0 6px", fontWeight: 500 }}>
            Amount
          </label>
          <AmountInput
            value={amount}
            onChange={(v) => {
              setAmount(v);
              setMessage(null);
            }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 13 }}>
            <span style={{ color: theme.color.muted }}>Simulated APY</span>
            <span style={{ fontFamily: theme.font.mono, color: theme.color.ink }}>{apy}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 13 }}>
            <span style={{ color: theme.color.muted }}>Your LP share</span>
            <span style={{ fontFamily: theme.font.mono, color: theme.color.ink }}>{yourShare}</span>
          </div>
          {tab === "deposit" ? (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12 }}>
              <span style={{ color: theme.color.muted }}>Approved to vault</span>
              <span style={{ fontFamily: theme.font.mono, color: theme.color.ink }}>
                {allowanceUsdc.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC
              </span>
            </div>
          ) : null}
          {needsApproval ? (
            <p style={{ margin: "12px 0 0", fontSize: 12, color: theme.color.muted, lineHeight: 1.4 }}>
              First <strong>Approve USDC</strong>, then the button becomes <strong>Deposit USDC</strong>.
            </p>
          ) : null}
          <Button
            fullWidth
            disabled={busy || (tab === "anychain" && !onAnyChainDeposit)}
            style={{ marginTop: 16 }}
            onClick={async () => {
              setBusy(true);
              setMessage(null);
              try {
                if (tab === "anychain") {
                  if (!onAnyChainDeposit) {
                    setMessage("Multichain deposit is not wired.");
                    return;
                  }
                  setMessage(await onAnyChainDeposit(anySource, amountNum));
                  return;
                }
                const action: LpAction =
                  tab === "withdraw" ? "withdraw" : needsApproval ? "approve" : "deposit";
                setMessage(await onAction(action, amountNum));
              } finally {
                setBusy(false);
              }
            }}
          >
            {buttonLabel}
          </Button>
          {message && (
            <div
              style={{
                marginTop: 12,
                background: isError ? theme.color.noSoft : theme.color.yesSoft,
                color: isError ? theme.color.no : theme.color.yes,
                border: `1px solid ${isError ? theme.color.noBorder : theme.color.yesBorder}`,
                borderRadius: 10,
                padding: "10px 12px",
                fontSize: 12.5,
                whiteSpace: "pre-wrap"
              }}
            >
              {message}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
