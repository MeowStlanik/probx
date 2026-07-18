'use client';
import { useState } from 'react';
import { theme } from '../theme';
import { CctpStep } from '../types';
import { Button } from './Button';
import { AmountInput } from './AmountInput';

interface Props {
  open: boolean;
  onClose: () => void;
  cctpSteps: CctpStep[];
  onDeposit: (amount: number) => void;
  onStartBridge: () => void;
  bridgeLabel: string;
}

// Fund modal: Deposit (direct on Arc) / Bridge (CCTP) tabs.
export function FundModal({ open, onClose, cctpSteps, onDeposit, onStartBridge, bridgeLabel }: Props) {
  const [tab, setTab] = useState<'deposit' | 'bridge'>('deposit');
  const [amount, setAmount] = useState('100');
  if (!open) return null;

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(11,22,34,.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 420, padding: 24, boxShadow: theme.shadow.modal }}>
        <div style={{ display: 'flex', gap: 6, background: theme.color.tint, borderRadius: 9, padding: 4, marginBottom: 18 }}>
          {(['deposit', 'bridge'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1, border: 'none', borderRadius: 7, padding: 9, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: theme.font.sans,
                background: tab === t ? '#fff' : 'transparent',
                color: tab === t ? theme.color.ink : theme.color.muted,
                boxShadow: tab === t ? '0 1px 2px rgba(16,32,64,.08)' : 'none',
              }}
            >
              {t === 'deposit' ? 'Deposit' : 'Bridge (CCTP)'}
            </button>
          ))}
        </div>

        {tab === 'deposit' ? (
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: theme.color.ink, margin: 0 }}>Deposit on Arc</h3>
            <p style={{ fontSize: 12.5, color: theme.color.muted, margin: '6px 0 16px' }}>USDC sent directly to your Arc wallet address.</p>
            <label style={{ display: 'block', fontSize: 12, color: theme.color.muted, marginBottom: 6, fontWeight: 500 }}>Amount</label>
            <AmountInput value={amount} onChange={setAmount} />
            <Button fullWidth style={{ marginTop: 16 }} onClick={() => onDeposit(Number(amount) || 0)}>Deposit USDC</Button>
          </div>
        ) : (
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, color: theme.color.ink, margin: 0 }}>Bridge USDC · CCTP</h3>
            <p style={{ fontSize: 12.5, color: theme.color.muted, margin: '6px 0 16px' }}>Base Sepolia → Arc, native USDC, no wrapped tokens.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {cctpSteps.map((s) => {
                const dotBg = s.status === 'confirmed' ? theme.color.yesSoft : s.status === 'pending' ? theme.color.blue : '#F0F3F7';
                const dotFg = s.status === 'confirmed' ? theme.color.yes : s.status === 'pending' ? '#fff' : '#9AA7B5';
                const rowBg = s.status === 'confirmed' ? '#F4FAF7' : '#fff';
                const statusColor = s.status === 'confirmed' ? theme.color.yes : s.status === 'pending' ? theme.color.blue : '#9AA7B5';
                return (
                  <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 12, border: `1px solid ${theme.color.border}`, borderRadius: 10, padding: '11px 13px', background: rowBg }}>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: theme.font.mono, fontSize: 12, fontWeight: 600, flexShrink: 0, background: dotBg, color: dotFg }}>
                      {s.n}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>{s.label}</div>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: statusColor }}>{s.status}</div>
                  </div>
                );
              })}
            </div>
            <Button fullWidth style={{ marginTop: 16, background: theme.color.purple }} onClick={onStartBridge}>{bridgeLabel}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
