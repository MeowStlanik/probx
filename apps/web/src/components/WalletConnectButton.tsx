"use client";

import { AlertCircle, Check, Copy, ExternalLink, LogOut, RefreshCcw, Wallet } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FundUsdcPanel } from "@/components/FundUsdcPanel";
import { arcDeployment } from "@/lib/onchain";
import { formatUsdcBalance, shortHex, useWallet } from "@/lib/wallet";

export function WalletConnectButton() {
  const {
    address,
    usdcBalance,
    connecting,
    restoring,
    wrongNetwork,
    error,
    connect,
    requestEmailOtp,
    verifyEmailOtp,
    disconnect,
    refreshBalance,
    ensureArcChain
  } = useWallet();

  const [menuOpen, setMenuOpen] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  const [otpStep, setOtpStep] = useState<"email" | "code">("email");
  const [otpHint, setOtpHint] = useState<string | null>(null);
  const [otpToken, setOtpToken] = useState<string | null>(null);
  const [fundOpen, setFundOpen] = useState(false);
  const [fundTab, setFundTab] = useState<"direct" | "bridge">("direct");
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const balanceLabel =
    usdcBalance === null
      ? "—"
      : usdcBalance === 0n
        ? "0.00"
        : formatUsdcBalance(usdcBalance).replace(/ USDC$/i, "");

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const copyAddress = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  }, [address]);

  const openFund = (tab: "direct" | "bridge") => {
    setFundTab(tab);
    setFundOpen(true);
    setMenuOpen(false);
  };

  const sendCode = async () => {
    setOtpHint(null);
    const res = await requestEmailOtp(emailInput.trim());
    if (!res) {
      setOtpHint("Couldn't send code — check the address and try again.");
      return;
    }
    setOtpHint(res.message);
    setOtpToken(res.otpToken ?? null);
    setOtpStep("code");
  };

  const verifyCode = async () => {
    const addr = await verifyEmailOtp(emailInput.trim(), otpInput, otpToken ?? undefined);
    if (addr) {
      setMenuOpen(false);
      setOtpStep("email");
      setOtpInput("");
      setOtpToken(null);
    }
  };

  if (restoring) {
    return (
      <div className="walletCluster">
        <button className="walletPillBtn" disabled type="button">
          <span className="walletAvatar" aria-hidden />
          <span className="walletPillBalance">…</span>
          <span className="walletPillUnit">USDC</span>
        </button>
      </div>
    );
  }

  if (!address) {
    return (
      <div className="walletCluster walletClusterMenu" ref={wrapRef}>
        <button
          className="iconButton primary walletConnectCta"
          disabled={connecting}
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
          data-tour="connect-wallet"
          aria-expanded={menuOpen}
        >
          <Wallet size={16} aria-hidden />
          {connecting ? "Connecting…" : "Connect"}
        </button>

        {menuOpen ? (
          <div className="walletPopover" role="dialog" aria-label="Connect wallet">
            <div className="walletPopoverTitle">Connect</div>
            <button
              type="button"
              className="walletMenuItem"
              disabled={connecting}
              onClick={() => {
                setMenuOpen(false);
                void connect();
              }}
            >
              Browser wallet
            </button>

            <div className="walletDivider">
              <span />
              <em>or continue with email</em>
              <span />
            </div>

            {otpStep === "email" ? (
              <>
                <div className="walletMenuEmailRow">
                  <input
                    id="probx-email-login"
                    type="email"
                    autoComplete="email"
                    placeholder="you@email.com"
                    value={emailInput}
                    disabled={connecting}
                    onChange={(event) => setEmailInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && emailInput.trim()) {
                        void sendCode();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="iconButton primary walletMenuEmailGo"
                    disabled={connecting || !emailInput.trim()}
                    onClick={() => void sendCode()}
                  >
                    Code
                  </button>
                </div>
                {otpHint ? <p className="walletMenuHint errorHint">{otpHint}</p> : null}
              </>
            ) : (
              <>
                <p className="walletMenuHint">
                  Code sent to <strong>{emailInput.trim()}</strong>
                </p>
                <div className="walletMenuEmailRow">
                  <input
                    id="probx-email-otp"
                    className="walletOtpInput"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="• • • • • •"
                    maxLength={6}
                    value={otpInput}
                    disabled={connecting}
                    onChange={(event) => setOtpInput(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && otpInput.length === 6) {
                        void verifyCode();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="iconButton primary walletMenuEmailGo"
                    disabled={connecting || otpInput.length !== 6}
                    onClick={() => void verifyCode()}
                  >
                    Verify
                  </button>
                </div>
                <button
                  type="button"
                  className="walletMenuBack"
                  disabled={connecting}
                  onClick={() => {
                    setOtpStep("email");
                    setOtpInput("");
                    setOtpToken(null);
                    setOtpHint(null);
                  }}
                >
                  ← Change email
                </button>
              </>
            )}

            {error ? (
              <p className="walletMenuHint errorHint" role="alert">
                <AlertCircle size={14} aria-hidden /> {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="walletCluster walletClusterMenu" ref={wrapRef}>
      <button
        className="walletPillBtn"
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-expanded={menuOpen}
        aria-label="Wallet menu"
        data-tour={usdcBalance !== null && usdcBalance === 0n ? "fund-usdc" : undefined}
      >
        <span className="walletAvatar" aria-hidden />
        <span className="walletPillBalance">{balanceLabel}</span>
        <span className="walletPillUnit">USDC</span>
      </button>

      {menuOpen ? (
        <div className="walletPopover walletPopoverConnected" role="dialog" aria-label="Wallet">
          <div className="walletPopoverTop">
            <div className="walletPopoverIdentity">
              <span className="walletAvatar lg" aria-hidden />
              <span className="walletPopoverAddr" title={address}>
                {shortHex(address)}
              </span>
            </div>
            <div className="walletPopoverTools">
              <button
                type="button"
                className="walletToolBtn"
                title="Refresh balance"
                onClick={() => void refreshBalance()}
              >
                <RefreshCcw size={13} aria-hidden />
              </button>
              <button type="button" className="walletToolBtn" onClick={() => void copyAddress()}>
                {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
              <a
                className="walletToolBtn"
                href={`${arcDeployment.explorerUrl}/address/${address}`}
                target="_blank"
                rel="noreferrer"
                title="Open in explorer"
              >
                <ExternalLink size={13} aria-hidden />
              </a>
            </div>
          </div>

          {wrongNetwork ? (
            <button type="button" className="walletWrongNet" onClick={() => void ensureArcChain()}>
              <AlertCircle size={14} aria-hidden />
              Wrong network · switch to Arc
            </button>
          ) : null}

          <div className="walletBalanceBlock">
            <div className="walletBalanceLabel">Balance</div>
            <div className="walletBalanceValue">
              {balanceLabel} <span>USDC</span>
            </div>
          </div>

          <div className="walletFundRow">
            <button type="button" className="walletFundDirect" onClick={() => openFund("direct")}>
              Deposit on Arc
            </button>
            <button type="button" className="walletFundBridge" onClick={() => openFund("bridge")}>
              Bridge (CCTP)
            </button>
          </div>

          <button
            type="button"
            className="walletDisconnect"
            onClick={() => {
              disconnect();
              setMenuOpen(false);
            }}
          >
            <LogOut size={14} aria-hidden />
            Disconnect
          </button>

          {error ? (
            <p className="walletMenuHint errorHint" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      <FundUsdcPanel open={fundOpen} initialTab={fundTab} onClose={() => setFundOpen(false)} />
    </div>
  );
}
