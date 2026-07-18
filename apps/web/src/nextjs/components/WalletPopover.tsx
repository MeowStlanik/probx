'use client';
import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme';
import { WalletState } from '../types';
import { Button } from './Button';

interface Props {
  wallet: WalletState;
  onConnectBrowser: () => void;
  onSendCode: (email: string) => void;
  onVerifyCode: (code: string) => void;
  onDisconnect: () => void;
  onFixNetwork: () => void;
  onDeposit: () => void;
  onBridge: () => void;
}

// Header account button + popover: disconnected / connected / wrong-network / email OTP step 1-2.
export function WalletPopover({ wallet, onConnectBrowser, onSendCode, onVerifyCode, onDisconnect, onFixNetwork, onDeposit, onBridge }: Props) {
  const [open, setOpen] = useState(false);
  const [loginStep, setLoginStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [copyLabel, setCopyLabel] = useState('Copy');
  const wrapRef = useRef<HTMLDivElement>(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < theme.layout.breakpoint;

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

  const popoverStyle = isMobile
    ? { position: 'fixed' as const, left: 0, right: 0, bottom: 0, background: '#fff', borderTop: `1px solid ${theme.color.border}`, borderRadius: '16px 16px 0 0', boxShadow: '0 -8px 30px rgba(16,32,64,.18)', padding: 20, zIndex: 200, maxHeight: '80vh', overflow: 'auto' }
    : { position: 'absolute' as const, top: 52, right: 0, width: 360, background: '#fff', border: `1px solid ${theme.color.border}`, borderRadius: 14, boxShadow: theme.shadow.popover, padding: 18, zIndex: 200 };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${theme.color.border}`, borderRadius: 20, padding: '5px 12px 5px 8px', background: '#fff', cursor: 'pointer', fontFamily: theme.font.sans }}
      >
        <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'linear-gradient(135deg,#2775CA,#7C5CFF)', display: 'inline-block' }} />
        <span style={{ fontFamily: theme.font.mono, fontSize: 12.5, fontWeight: 500, color: theme.color.ink, fontVariantNumeric: 'tabular-nums' }}>
          {wallet.balance ?? '0.00'}
        </span>
        <span style={{ fontSize: 11, color: theme.color.muted, fontWeight: 600 }}>USDC</span>
      </button>

      {open && (
        <div style={popoverStyle}>
          {wallet.connected ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'linear-gradient(135deg,#2775CA,#7C5CFF)', display: 'inline-block' }} />
                  <span style={{ fontFamily: theme.font.mono, fontSize: 13, color: theme.color.ink }}>{wallet.address}</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => {
                      if (wallet.address) navigator.clipboard.writeText(wallet.address);
                      setCopyLabel('Copied');
                      setTimeout(() => setCopyLabel('Copy'), 1500);
                    }}
                    style={{ border: `1px solid ${theme.color.border}`, background: '#fff', borderRadius: 7, padding: '5px 8px', fontSize: 11, color: theme.color.muted, cursor: 'pointer', fontFamily: theme.font.sans }}
                  >
                    {copyLabel}
                  </button>
                </div>
              </div>
              {wallet.wrongNetwork && (
                <button
                  onClick={onFixNetwork}
                  style={{ width: '100%', marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: theme.color.noSoft, color: theme.color.no, border: `1px solid ${theme.color.noBorder}`, borderRadius: 9, padding: 9, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: theme.font.sans }}
                >
                  ⚠ Wrong network · switch to Arc
                </button>
              )}
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, color: theme.color.muted }}>Balance</div>
                <div style={{ fontFamily: theme.font.mono, fontSize: 28, fontWeight: 600, color: theme.color.ink, marginTop: 2 }}>
                  {wallet.balance} <span style={{ fontSize: 13, color: theme.color.muted, fontWeight: 500 }}>USDC</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                <Button variant="primary" fullWidth onClick={onDeposit} style={{ fontSize: 12.5 }}>Deposit on Arc</Button>
                <Button variant="secondary" fullWidth onClick={onBridge} style={{ background: theme.color.purpleSoft, color: theme.color.purple, border: `1px solid ${theme.color.purpleBorder}`, fontSize: 12.5 }}>Bridge (CCTP)</Button>
              </div>
              <button onClick={onDisconnect} style={{ width: '100%', marginTop: 14, background: 'none', border: 'none', borderTop: `1px solid ${theme.color.border}`, paddingTop: 12, fontSize: 12, color: theme.color.muted, cursor: 'pointer', fontFamily: theme.font.sans }}>
                Disconnect
              </button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink, marginBottom: 12 }}>Connect</div>
              <Button variant="secondary" fullWidth onClick={onConnectBrowser} style={{ background: theme.color.ink, color: '#fff' }}>Browser wallet</Button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0' }}>
                <div style={{ flex: 1, height: 1, background: theme.color.border }} />
                <span style={{ fontSize: 11, color: theme.color.muted }}>or continue with email</span>
                <div style={{ flex: 1, height: 1, background: theme.color.border }} />
              </div>
              {loginStep === 1 ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com"
                    style={{ flex: 1, border: `1px solid ${theme.color.border}`, borderRadius: 9, padding: '10px 12px', fontSize: 13, outline: 'none', color: theme.color.ink }} />
                  <Button size="sm" onClick={() => { onSendCode(email); setLoginStep(2); }}>Code</Button>
                </div>
              ) : (
                <div>
                  <p style={{ fontSize: 11.5, color: theme.color.muted, margin: '0 0 8px' }}>
                    Code sent to <strong style={{ color: theme.color.ink }}>{email}</strong>
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="• • • • • •" maxLength={6}
                      style={{ flex: 1, border: `1px solid ${theme.color.border}`, borderRadius: 9, padding: '10px 12px', fontSize: 14, letterSpacing: '.25em', fontFamily: theme.font.mono, outline: 'none', color: theme.color.ink }} />
                    <Button size="sm" onClick={() => onVerifyCode(code)}>Verify</Button>
                  </div>
                  <button onClick={() => setLoginStep(1)} style={{ background: 'none', border: 'none', padding: 0, marginTop: 8, fontSize: 11.5, color: theme.color.muted, cursor: 'pointer', fontFamily: theme.font.sans }}>
                    ← Change email
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
