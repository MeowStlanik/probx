"use client";

import { AlertCircle, LogOut, Mail, RefreshCcw, Wallet } from "lucide-react";
import { useState } from "react";
import { FundUsdcPanel } from "@/components/FundUsdcPanel";
import { formatUsdcBalance, shortHex, useWallet } from "@/lib/wallet";

export function WalletConnectButton() {
  const {
    address,
    usdcBalance,
    connecting,
    restoring,
    wrongNetwork,
    error,
    mode,
    email,
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

  if (restoring) {
    return (
      <div className="walletCluster">
        <button className="iconButton secondary" disabled type="button">
          <Wallet size={18} aria-hidden />
          Restoring…
        </button>
      </div>
    );
  }

  if (!address) {
    return (
      <div className="walletCluster walletClusterMenu">
        <button
          className="iconButton primary"
          disabled={connecting}
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
          data-tour="connect-wallet"
        >
          <Wallet size={18} aria-hidden />
          {connecting ? "Connecting…" : "Connect"}
        </button>
        {menuOpen ? (
          <div className="walletConnectMenu">
            <button
              type="button"
              className="walletMenuItem"
              disabled={connecting}
              onClick={() => {
                setMenuOpen(false);
                void connect();
              }}
            >
              <Wallet size={16} aria-hidden />
              Browser wallet
            </button>
            <div className="walletMenuEmail">
              <label htmlFor="probx-email-login">
                <Mail size={14} aria-hidden /> Email
              </label>
              {otpStep === "email" ? (
                <>
                  <div className="walletMenuEmailRow">
                    <input
                      id="probx-email-login"
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={emailInput}
                      disabled={connecting}
                      onChange={(event) => setEmailInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && emailInput.trim()) {
                          void (async () => {
                            setOtpHint(null);
                            const res = await requestEmailOtp(emailInput.trim());
                            if (!res) {
                              setOtpHint("Could not send code — check connection / Circle env.");
                              return;
                            }
                            setOtpHint(res.message);
                            setOtpToken(res.otpToken ?? null);
                            setOtpStep("code");
                          })();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="iconButton primary walletMenuEmailGo"
                      disabled={connecting || !emailInput.trim()}
                      onClick={() => {
                        void (async () => {
                          setOtpHint(null);
                          const res = await requestEmailOtp(emailInput.trim());
                          if (!res) {
                            setOtpHint("Could not send code — check connection / Circle env.");
                            return;
                          }
                          setOtpHint(res.message);
                          setOtpToken(res.otpToken ?? null);
                          setOtpStep("code");
                        })();
                      }}
                    >
                      Code
                    </button>
                  </div>
                  {otpHint && otpStep === "email" ? <p className="walletMenuHint">{otpHint}</p> : null}
                </>
              ) : (
                <>
                  {otpHint ? <p className="walletMenuHint">{otpHint}</p> : null}
                  <p className="walletMenuHint">
                    Enter the 6-digit code sent to <strong>{emailInput.trim()}</strong>
                  </p>
                  <div className="walletMenuEmailRow">
                    <input
                      id="probx-email-otp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="6-digit code"
                      maxLength={6}
                      value={otpInput}
                      disabled={connecting}
                      onChange={(event) => setOtpInput(event.target.value.replace(/\D/g, "").slice(0, 6))}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && otpInput.length === 6) {
                          void (async () => {
                            const addr = await verifyEmailOtp(
                              emailInput.trim(),
                              otpInput,
                              otpToken ?? undefined
                            );
                            if (addr) {
                              setMenuOpen(false);
                              setOtpStep("email");
                              setOtpInput("");
                              setOtpToken(null);
                            }
                          })();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="iconButton primary walletMenuEmailGo"
                      disabled={connecting || otpInput.length !== 6}
                      onClick={() => {
                        void (async () => {
                          const addr = await verifyEmailOtp(
                            emailInput.trim(),
                            otpInput,
                            otpToken ?? undefined
                          );
                          if (addr) {
                            setMenuOpen(false);
                            setOtpStep("email");
                            setOtpInput("");
                            setOtpToken(null);
                          }
                        })();
                      }}
                    >
                      Go
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
            </div>
          </div>
        ) : null}
        {error ? (
          <span className="walletError walletErrorFull" role="alert" title={error}>
            <AlertCircle size={16} aria-hidden />
            <span className="walletErrorText">{error}</span>
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="walletCluster">
      {/* Balance first — never data-tour here (tour must ring the fund CTA only) */}
      <button
        className="iconButton secondary walletBalanceBtn"
        onClick={() => void refreshBalance()}
        type="button"
        title="Refresh Arc USDC balance"
      >
        <RefreshCcw size={16} aria-hidden />
        {usdcBalance === null
          ? "USDC"
          : usdcBalance === 0n
            ? "0 USDC"
            : formatUsdcBalance(usdcBalance)}
      </button>
      <span className="walletAddress" title={address}>
        {shortHex(address)}
      </span>
      {/* Single fund target — data-tour only on this button */}
      <button
        className={
          usdcBalance !== null && usdcBalance === 0n
            ? "iconButton walletFundCta"
            : "iconButton secondary walletFundCta"
        }
        onClick={() => setFundOpen(true)}
        type="button"
        title="Add USDC to this Arc wallet"
        aria-label={usdcBalance === 0n ? "No USDC on wallet. Add funds." : "Add USDC to this Arc wallet"}
        data-tour="fund-usdc"
      >
        {usdcBalance !== null && usdcBalance === 0n ? (
          <>
            <AlertCircle size={16} aria-hidden />
            Get USDC
          </>
        ) : (
          "Add USDC"
        )}
      </button>
      <button className="iconOnly" onClick={disconnect} type="button" aria-label="Disconnect wallet">
        <LogOut size={16} aria-hidden />
      </button>
      {wrongNetwork ? (
        <button
          className="walletError asButton"
          onClick={() => void ensureArcChain()}
          type="button"
          title="Switch to Arc Testnet"
        >
          <AlertCircle size={16} aria-hidden />
          Wrong network
        </button>
      ) : null}
      {error ? (
        <span className="walletError" title={error}>
          <AlertCircle size={16} aria-hidden />
          Balance issue
        </span>
      ) : null}
      <FundUsdcPanel open={fundOpen} onClose={() => setFundOpen(false)} />
    </div>
  );
}
