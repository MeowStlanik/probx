'use client';

import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme';
import { WalletState } from '../types';
import { Button } from './Button';

interface Props {
  wallet: WalletState;
  /** True while request-otp / verify-otp is in flight. */
  busy?: boolean;
  /** Last wallet error (OTP / connect) to surface in the popover. */
  error?: string | null;
  onConnectBrowser: () => void | Promise<void>;
  /** Request OTP. Return true only on success so we advance to step 2. */
  onSendCode: (email: string) => Promise<boolean>;
  /** Verify OTP. Return true on success. */
  onVerifyCode: (email: string, code: string) => Promise<boolean>;
  onDisconnect: () => void;
  onFixNetwork: () => void;
  onDeposit: () => void;
  onBridge: () => void;
  /** Clear any server/client OTP challenge for an email (or last). */
  onClearOtp?: (email?: string) => void;
}

// Header account button + popover: disconnected Login CTA / connected pill / email OTP.
export function WalletPopover({
  wallet,
  busy = false,
  error = null,
  onConnectBrowser,
  onSendCode,
  onVerifyCode,
  onDisconnect,
  onFixNetwork,
  onDeposit,
  onBridge,
  onClearOtp
}: Props) {
  const [open, setOpen] = useState(false);
  const [loginStep, setLoginStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState('Copy');
  const wrapRef = useRef<HTMLDivElement>(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < theme.layout.breakpoint;

  // After a successful session, never leave the OTP form hanging.
  useEffect(() => {
    if (!wallet.connected) return;
    setLoginStep(1);
    setCode('');
    setLocalError(null);
  }, [wallet.connected]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (open && wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const resetLoginForm = (opts?: { keepEmail?: boolean }) => {
    setLoginStep(1);
    setCode('');
    setLocalError(null);
    if (!opts?.keepEmail) setEmail('');
    onClearOtp?.(email);
  };

  const handleOpenToggle = () => {
    setOpen((v) => {
      const next = !v;
      // Opening while logged out always starts clean at email entry.
      if (next && !wallet.connected) {
        setLoginStep(1);
        setCode('');
        setLocalError(null);
      }
      return next;
    });
  };

  const handleSendCode = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) {
      setLocalError('Enter a valid email.');
      return;
    }
    setLocalError(null);
    setCode(''); // never keep a previous code
    onClearOtp?.(trimmed);
    const ok = await onSendCode(trimmed);
    if (ok) {
      setEmail(trimmed);
      setLoginStep(2);
    } else {
      setLoginStep(1);
      setLocalError('Could not send code. Check the email and try again.');
    }
  };

  const handleVerify = async () => {
    const digits = code.replace(/\s/g, '').trim();
    if (digits.length < 4) {
      setLocalError('Enter the code from your email.');
      return;
    }
    setLocalError(null);
    const ok = await onVerifyCode(email.trim().toLowerCase(), digits);
    if (ok) {
      setCode('');
      setLoginStep(1);
      setLocalError(null);
      // Stay open on the connected profile — no OTP UI over it.
    } else {
      // Wrong code: clear input so the previous digits are not re-submitted.
      setCode('');
      setLocalError('Invalid or expired code. Request a new one if needed.');
    }
  };

  const handleChangeEmail = () => {
    setCode('');
    setLocalError(null);
    setLoginStep(1);
    onClearOtp?.(email);
  };

  const handleDisconnect = () => {
    resetLoginForm();
    onDisconnect();
    setOpen(false);
  };

  const displayError = localError || error;

  const popoverStyle = isMobile
    ? {
        position: 'fixed' as const,
        left: 0,
        right: 0,
        bottom: 0,
        background: '#fff',
        borderTop: `1px solid ${theme.color.border}`,
        borderRadius: '16px 16px 0 0',
        boxShadow: '0 -8px 30px rgba(16,32,64,.18)',
        padding: 20,
        zIndex: 200,
        maxHeight: '80vh',
        overflow: 'auto' as const
      }
    : {
        position: 'absolute' as const,
        top: 52,
        right: 0,
        width: 360,
        background: '#fff',
        border: `1px solid ${theme.color.border}`,
        borderRadius: 14,
        boxShadow: theme.shadow.popover,
        padding: 18,
        zIndex: 200
      };

  const copyAddress = async () => {
    const full = wallet.fullAddress || wallet.address;
    if (!full) return;
    try {
      await navigator.clipboard.writeText(full);
      setCopyLabel('Copied');
      setTimeout(() => setCopyLabel('Copy'), 1500);
    } catch {
      setCopyLabel('Copy');
    }
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
      {wallet.connected ? (
        <>
          {/* Always-visible copy — main screen, next to balance pill */}
          <button
            type="button"
            onClick={() => void copyAddress()}
            title={wallet.fullAddress || wallet.address || 'Copy address'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: `1px solid ${theme.color.border}`,
              borderRadius: 20,
              padding: '6px 10px',
              background: '#fff',
              cursor: 'pointer',
              fontFamily: theme.font.mono,
              fontSize: 12,
              fontWeight: 500,
              color: theme.color.ink
            }}
          >
            <span style={{ color: theme.color.muted, fontSize: 11, fontWeight: 600, fontFamily: theme.font.sans }}>
              {copyLabel === 'Copied' ? 'Copied' : 'Addr'}
            </span>
            <span>{wallet.address}</span>
            <span aria-hidden style={{ fontSize: 12, color: theme.color.blue }}>
              ⎘
            </span>
          </button>
          <button
            type="button"
            onClick={handleOpenToggle}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: `1px solid ${theme.color.border}`,
              borderRadius: 20,
              padding: '5px 12px 5px 8px',
              background: '#fff',
              cursor: 'pointer',
              fontFamily: theme.font.sans
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: 'linear-gradient(135deg,#2775CA,#7C5CFF)',
                display: 'inline-block'
              }}
            />
            <span
              style={{
                fontFamily: theme.font.mono,
                fontSize: 12.5,
                fontWeight: 500,
                color: theme.color.ink,
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {wallet.balance ?? '0.00'}
            </span>
            <span style={{ fontSize: 11, color: theme.color.muted, fontWeight: 600 }}>USDC</span>
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={handleOpenToggle}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            border: 'none',
            borderRadius: 20,
            padding: '8px 16px',
            background: theme.color.blue,
            color: '#fff',
            cursor: 'pointer',
            fontFamily: theme.font.sans,
            fontSize: 13,
            fontWeight: 600,
            boxShadow: '0 1px 2px rgba(39,117,202,.25)'
          }}
        >
          Login
        </button>
      )}

      {open && (
        <div style={popoverStyle}>
          {wallet.connected ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: '50%',
                      background: 'linear-gradient(135deg,#2775CA,#7C5CFF)',
                      display: 'inline-block'
                    }}
                  />
                  <span style={{ fontFamily: theme.font.mono, fontSize: 13, color: theme.color.ink }}>
                    {wallet.address}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => void copyAddress()}
                    style={{
                      border: `1px solid ${theme.color.border}`,
                      background: '#fff',
                      borderRadius: 7,
                      padding: '5px 8px',
                      fontSize: 11,
                      color: theme.color.muted,
                      cursor: 'pointer',
                      fontFamily: theme.font.sans
                    }}
                  >
                    {copyLabel}
                  </button>
                </div>
              </div>
              {wallet.wrongNetwork && (
                <button
                  type="button"
                  onClick={onFixNetwork}
                  style={{
                    width: '100%',
                    marginTop: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    background: theme.color.noSoft,
                    color: theme.color.no,
                    border: `1px solid ${theme.color.noBorder}`,
                    borderRadius: 9,
                    padding: 9,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: theme.font.sans
                  }}
                >
                  ⚠ Wrong network · switch to Arc
                </button>
              )}
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, color: theme.color.muted }}>Balance</div>
                <div
                  style={{
                    fontFamily: theme.font.mono,
                    fontSize: 28,
                    fontWeight: 600,
                    color: theme.color.ink,
                    marginTop: 2
                  }}
                >
                  {wallet.balance}{' '}
                  <span style={{ fontSize: 13, color: theme.color.muted, fontWeight: 500 }}>USDC</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <Button variant="primary" fullWidth onClick={onDeposit} style={{ fontSize: 12.5 }}>
                  Deposit on Arc
                </Button>
                <Button
                  variant="secondary"
                  fullWidth
                  onClick={onBridge}
                  style={{
                    background: theme.color.purpleSoft,
                    color: theme.color.purple,
                    border: `1px solid ${theme.color.purpleBorder}`,
                    fontSize: 12.5
                  }}
                >
                  Bridge (CCTP)
                </Button>
              </div>
              <button
                type="button"
                onClick={handleDisconnect}
                style={{
                  width: '100%',
                  marginTop: 14,
                  background: 'none',
                  border: 'none',
                  borderTop: `1px solid ${theme.color.border}`,
                  paddingTop: 12,
                  fontSize: 12,
                  color: theme.color.muted,
                  cursor: 'pointer',
                  fontFamily: theme.font.sans
                }}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink, marginBottom: 12 }}>
                Login
              </div>
              <Button
                variant="secondary"
                fullWidth
                disabled={busy}
                onClick={() => void onConnectBrowser()}
                style={{ background: theme.color.ink, color: '#fff', opacity: busy ? 0.7 : 1 }}
              >
                Browser wallet
              </Button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0' }}>
                <div style={{ flex: 1, height: 1, background: theme.color.border }} />
                <span style={{ fontSize: 11, color: theme.color.muted }}>or continue with email</span>
                <div style={{ flex: 1, height: 1, background: theme.color.border }} />
              </div>
              {loginStep === 1 ? (
                <div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setLocalError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSendCode();
                      }}
                      placeholder="you@email.com"
                      autoComplete="email"
                      disabled={busy}
                      style={{
                        flex: 1,
                        border: `1px solid ${theme.color.border}`,
                        borderRadius: 9,
                        padding: '10px 12px',
                        fontSize: 13,
                        outline: 'none',
                        color: theme.color.ink
                      }}
                    />
                    <Button size="sm" disabled={busy} onClick={() => void handleSendCode()}>
                      {busy ? '…' : 'Code'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <p style={{ fontSize: 11.5, color: theme.color.muted, margin: '0 0 8px' }}>
                    Code sent to <strong style={{ color: theme.color.ink }}>{email}</strong>
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6));
                        setLocalError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleVerify();
                      }}
                      placeholder="••••••"
                      maxLength={6}
                      disabled={busy}
                      style={{
                        flex: 1,
                        border: `1px solid ${theme.color.border}`,
                        borderRadius: 9,
                        padding: '10px 12px',
                        fontSize: 14,
                        letterSpacing: '.25em',
                        fontFamily: theme.font.mono,
                        outline: 'none',
                        color: theme.color.ink
                      }}
                    />
                    <Button size="sm" disabled={busy || code.length < 4} onClick={() => void handleVerify()}>
                      {busy ? '…' : 'Verify'}
                    </Button>
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={handleChangeEmail}
                      disabled={busy}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        fontSize: 11.5,
                        color: theme.color.muted,
                        cursor: 'pointer',
                        fontFamily: theme.font.sans
                      }}
                    >
                      ← Change email
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSendCode()}
                      disabled={busy}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        fontSize: 11.5,
                        color: theme.color.blue,
                        cursor: 'pointer',
                        fontFamily: theme.font.sans,
                        fontWeight: 600
                      }}
                    >
                      Resend code
                    </button>
                  </div>
                </div>
              )}
              {displayError ? (
                <p
                  style={{
                    margin: '10px 0 0',
                    fontSize: 12,
                    color: theme.color.no,
                    lineHeight: 1.35
                  }}
                >
                  {displayError}
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
