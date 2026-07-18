"use client";

import { useMemo, useState } from "react";
import { theme } from "../theme";
import type { AllocationRow } from "../types";
import { AllocationTable } from "../components/Tables";
import { AmountInput } from "../components/AmountInput";
import { Button } from "../components/Button";

export type LpAction = "approve" | "deposit" | "withdraw";

interface Props {
  tvl: string;
  reserved: string;
  available: string;
  utilization: string;
  allocations: AllocationRow[];
  apy: string;
  yourShare: string;
  /** Current USDC allowance to the vault (human units). */
  allowanceUsdc: number;
  onAction: (action: LpAction, amount: number) => Promise<string>;
}

// /lp — vault stats, allocations table, deposit/withdraw panel.
export function LPView({
  tvl,
  reserved,
  available,
  utilization,
  allocations,
  apy,
  yourShare,
  allowanceUsdc,
  onAction
}: Props) {
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("1");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const amountNum = Number(amount) || 0;
  const needsApproval = tab === "deposit" && amountNum > 0 && amountNum > allowanceUsdc + 1e-9;

  const buttonLabel = useMemo(() => {
    if (busy) return "Working…";
    if (tab === "withdraw") return "Withdraw USDC";
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
    /fail|error|not enough|exceed|unavailable|reject|wrong network|switch/i.test(message);

  return (
    <main style={{ maxWidth: theme.layout.maxWidth, margin: "0 auto", padding: "40px 24px 72px", flex: 1 }}>
      <h1 style={{ fontSize: 26, fontWeight: 600, color: theme.color.ink }}>LP vault</h1>
      <p style={{ fontSize: 13.5, color: theme.color.muted, margin: "6px 0 28px" }}>
        Liquidity backing every ticket&apos;s payout on Arc.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 16 }}>
        {stat("TVL", tvl)}
        {stat("Reserved", reserved, theme.color.blue)}
        {stat("Available", available, theme.color.yes)}
        {stat("Utilization", utilization)}
      </div>

      <div
        style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 20, alignItems: "start" }}
        data-breakpoint="720:1fr"
      >
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
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Recent reserve allocations</span>
          <AllocationTable rows={allocations} />
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
          <div style={{ display: "flex", gap: 6, background: theme.color.tint, borderRadius: 9, padding: 4 }}>
            {(["deposit", "withdraw"] as const).map((t) => (
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
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: theme.font.sans,
                  background: tab === t ? "#fff" : "transparent",
                  color: tab === t ? theme.color.ink : theme.color.muted,
                  boxShadow: tab === t ? "0 1px 2px rgba(16,32,64,.08)" : "none"
                }}
              >
                {t === "deposit" ? "Deposit" : "Withdraw"}
              </button>
            ))}
          </div>
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
            disabled={busy}
            style={{ marginTop: 16 }}
            onClick={async () => {
              setBusy(true);
              setMessage(null);
              try {
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
                fontSize: 12.5
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
