"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FundUsdcPanel } from "@/components/FundUsdcPanel";
import { apiUrl } from "@/lib/api";
import { pickQuickTradeHref } from "@/lib/marketLinks";
import type { Market } from "@/lib/types";
import { formatUsdcBalance, shortHex, useWallet } from "@/lib/wallet";
import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import type { CctpStep, WalletState } from "../types";

const defaultCctpSteps: CctpStep[] = [
  { n: "1", label: "Approve USDC", desc: "Source chain", status: "idle" },
  { n: "2", label: "Burn (CCTP)", desc: "Base / Eth Sepolia", status: "idle" },
  { n: "3", label: "Attestation", desc: "Circle", status: "idle" },
  { n: "4", label: "Mint on Arc", desc: "Native USDC", status: "idle" }
];

/**
 * Layout chrome: theme Header + Footer wired to existing useWallet().
 * Fund/Bridge opens existing FundUsdcPanel (real CCTP + deposit flows).
 */
export function AppChrome({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const {
    address,
    usdcBalance,
    wrongNetwork,
    connecting,
    error: walletError,
    connect,
    requestEmailOtp,
    verifyEmailOtp,
    clearEmailOtp,
    disconnect,
    ensureArcChain
  } = useWallet();

  const [fundOpen, setFundOpen] = useState(false);
  const [fundTab, setFundTab] = useState<"direct" | "bridge" | "send">("direct");
  const [otpToken, setOtpToken] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState("");
  const [quickTradeHref, setQuickTradeHref] = useState("/markets");
  const [quickBusy, setQuickBusy] = useState(false);

  const wallet: WalletState = useMemo(
    () => ({
      connected: Boolean(address),
      address: address ? shortHex(address) : undefined,
      fullAddress: address ?? undefined,
      balance:
        usdcBalance === null ? "—" : formatUsdcBalance(usdcBalance).replace(/ USDC$/i, ""),
      wrongNetwork: Boolean(wrongNetwork)
    }),
    [address, usdcBalance, wrongNetwork]
  );

  const resolveQuickHref = useCallback(async (): Promise<string> => {
    const res = await fetch(apiUrl("/api/markets"), { cache: "no-store" });
    if (!res.ok) return quickTradeHref || "/markets";
    const markets = (await res.json()) as Market[];
    if (!Array.isArray(markets)) return "/markets";
    const href = pickQuickTradeHref(markets);
    setQuickTradeHref(href);
    // Prefetch so the next click/nav is instant
    try {
      router.prefetch(href);
    } catch {
      /* ignore */
    }
    return href;
  }, [quickTradeHref, router]);

  // Background cache — every 8s (not on critical path of click)
  useEffect(() => {
    void resolveQuickHref();
    const id = window.setInterval(() => void resolveQuickHref(), 8_000);
    return () => window.clearInterval(id);
  }, [resolveQuickHref]);

  const onQuickTrade = useCallback(async () => {
    setQuickBusy(true);
    try {
      // Prefer a fresh resolve so we never land on a finished round
      const href = await resolveQuickHref();
      router.push(href);
    } catch {
      router.push(quickTradeHref || "/markets");
    } finally {
      setQuickBusy(false);
    }
  }, [quickTradeHref, resolveQuickHref, router]);

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "#fff" }}>
      <Header
        wallet={wallet}
        cctpSteps={defaultCctpSteps}
        bridgeLabel="Bridge CCTP"
        quickTradeHref={quickTradeHref}
        onQuickTrade={onQuickTrade}
        quickTradeBusy={quickBusy}
        walletBusy={connecting}
        walletError={walletError}
        onConnectBrowser={() => {
          void connect();
        }}
        onSendCode={async (email) => {
          const normalized = email.trim().toLowerCase();
          setPendingEmail(normalized);
          setOtpToken(null);
          clearEmailOtp(normalized);
          const res = await requestEmailOtp(normalized);
          if (!res?.otpToken) {
            setOtpToken(null);
            return false;
          }
          setOtpToken(res.otpToken);
          return true;
        }}
        onVerifyCode={async (email, code) => {
          const normalized = (email || pendingEmail).trim().toLowerCase();
          const addr = await verifyEmailOtp(normalized, code, otpToken ?? undefined);
          if (addr) {
            setOtpToken(null);
            setPendingEmail("");
            return true;
          }
          return false;
        }}
        onClearOtp={(email) => {
          setOtpToken(null);
          if (email) setPendingEmail("");
          clearEmailOtp(email);
        }}
        onDisconnect={() => {
          setOtpToken(null);
          setPendingEmail("");
          disconnect();
        }}
        onFixNetwork={() => {
          void ensureArcChain();
        }}
        onDeposit={() => {
          setFundTab("direct");
          setFundOpen(true);
        }}
        onBridge={() => {
          setFundTab("bridge");
          setFundOpen(true);
        }}
        onSend={() => {
          setFundTab("send");
          setFundOpen(true);
        }}
        onStartBridge={() => {
          setFundTab("bridge");
          setFundOpen(true);
        }}
        fundModalOpen={fundOpen}
        onCloseFundModal={() => setFundOpen(false)}
      />
      <div style={{ flex: 1 }}>{children}</div>
      <Footer />
      <FundUsdcPanel open={fundOpen} initialTab={fundTab} onClose={() => setFundOpen(false)} />
    </div>
  );
}
