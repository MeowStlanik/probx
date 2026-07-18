"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { theme } from "../theme";
import type { CctpStep, WalletState } from "../types";
import { WalletPopover } from "./WalletPopover";

interface Props {
  wallet: WalletState;
  cctpSteps: CctpStep[];
  bridgeLabel: string;
  /** Cached live market href (updated by poll). */
  quickTradeHref?: string;
  /** Fresh resolve on click — prefer over stale href. */
  onQuickTrade?: () => void | Promise<void>;
  quickTradeBusy?: boolean;
  onConnectBrowser: () => void;
  onSendCode: (email: string) => Promise<boolean>;
  onVerifyCode: (email: string, code: string) => Promise<boolean>;
  onClearOtp?: (email?: string) => void;
  walletBusy?: boolean;
  walletError?: string | null;
  onDisconnect: () => void;
  onFixNetwork: () => void;
  onDeposit: (amount: number) => void;
  onBridge: () => void;
  onStartBridge: () => void;
  fundModalOpen: boolean;
  onCloseFundModal: () => void;
}

export function Header(props: Props) {
  const pathname = usePathname();
  const quickHref = props.quickTradeHref ?? "/markets";

  const navLinkStyle = (active: boolean) => ({
    fontSize: 14,
    fontWeight: active ? 600 : 500,
    color: active ? theme.color.blue : theme.color.muted,
    padding: "8px 12px 10px",
    borderBottom: `2px solid ${active ? theme.color.blue : "transparent"}`,
    whiteSpace: "nowrap" as const,
    textDecoration: "none",
    background: "none",
    borderTop: "none",
    borderLeft: "none",
    borderRight: "none",
    cursor: "pointer",
    fontFamily: "inherit"
  });

  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "#fff",
        borderBottom: `1px solid ${theme.color.border}`
      }}
    >
      <div
        style={{
          maxWidth: theme.layout.maxWidth,
          margin: "0 auto",
          padding: `0 ${theme.layout.pagePaddingX}px`,
          height: theme.layout.headerHeight,
          display: "flex",
          alignItems: "center",
          gap: 28
        }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none" }}>
          <Image src="/probx-logo.png" alt="ProbX Arc" width={36} height={36} style={{ borderRadius: 8, display: "block" }} />
          <span
            style={{
              fontFamily: theme.font.display,
              fontWeight: 700,
              fontSize: 23,
              letterSpacing: "-0.02em",
              color: theme.color.ink
            }}
          >
            ProbX<span style={{ color: theme.color.muted, fontWeight: 500 }}> Arc</span>
          </span>
        </Link>
        <nav style={{ display: "flex", gap: 4, overflowX: "auto", alignItems: "center" }}>
          <Link
            href="/markets"
            style={navLinkStyle(pathname === "/markets")}
          >
            Markets
          </Link>
          {props.onQuickTrade ? (
            <button
              type="button"
              disabled={props.quickTradeBusy}
              onClick={() => void props.onQuickTrade?.()}
              style={{
                ...navLinkStyle(Boolean(pathname?.startsWith("/markets/"))),
                opacity: props.quickTradeBusy ? 0.6 : 1
              }}
            >
              {props.quickTradeBusy ? "Finding…" : "Quick trade"}
            </button>
          ) : (
            <Link href={quickHref} style={navLinkStyle(Boolean(pathname?.startsWith("/markets/")))}>
              Quick trade
            </Link>
          )}
          <Link href="/lp" style={navLinkStyle(Boolean(pathname?.startsWith("/lp")))}>
            LP
          </Link>
          <Link href="/portfolio" style={navLinkStyle(Boolean(pathname?.startsWith("/portfolio")))}>
            Portfolio
          </Link>
        </nav>
        <div style={{ flex: 1 }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
            flexWrap: "wrap",
            justifyContent: "flex-end"
          }}
        >
          <a
            href="https://testnet.arcscan.app"
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              background: theme.color.purpleSoft,
              color: theme.color.purple,
              border: `1px solid ${theme.color.purpleBorder}`,
              borderRadius: 20,
              padding: "6px 12px",
              fontSize: 12.5,
              fontWeight: 600,
              whiteSpace: "nowrap"
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: theme.color.purple,
                display: "inline-block"
              }}
            />
            Arc Testnet
          </a>
          <Link
            href="/admin"
            title="Admin"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              border: `1px solid ${theme.color.border}`,
              background: "#fff",
              color: theme.color.muted,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              textDecoration: "none"
            }}
          >
            ⚙
          </Link>
          <WalletPopover
            wallet={props.wallet}
            busy={props.walletBusy}
            error={props.walletError}
            onConnectBrowser={props.onConnectBrowser}
            onSendCode={props.onSendCode}
            onVerifyCode={props.onVerifyCode}
            onClearOtp={props.onClearOtp}
            onDisconnect={props.onDisconnect}
            onFixNetwork={props.onFixNetwork}
            onDeposit={() => props.onDeposit(0)}
            onBridge={props.onBridge}
          />
        </div>
      </div>
    </header>
  );
}
