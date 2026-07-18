'use client';
import { useState } from 'react';
import { theme } from '../theme';
import { Button } from '../components/Button';

interface CreatedMarket { question: string; meta: string }

interface Props {
  onCreateMarket: (input: { category: string; question: string; duration: string; source: string }) => Promise<{ txHash: string }>;
  createdMarkets: CreatedMarket[];
  onForceResolve: (marketAddress: string, outcome: 'YES' | 'NO') => Promise<void>;
  adminSecret?: string;
  onAdminSecretChange?: (value: string) => void;
  error?: string | null;
}

// /admin — operator-only: create test market, manual resolver override, network info.
export function AdminView({
  onCreateMarket,
  createdMarkets,
  onForceResolve,
  adminSecret = '',
  onAdminSecretChange,
  error = null,
}: Props) {
  const [category, setCategory] = useState('crypto');
  const [question, setQuestion] = useState('');
  const [duration, setDuration] = useState('60');
  const [source, setSource] = useState('Coinbase BTC/USD');
  const [created, setCreated] = useState<{ txHash: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [resolverOpen, setResolverOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [outcome, setOutcome] = useState<'YES' | 'NO'>('YES');
  const [resolved, setResolved] = useState(false);

  const catBtn = (active: boolean) => ({
    borderRadius: 8, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: theme.font.sans,
    border: active ? `1.5px solid ${theme.color.blue}` : `1px solid ${theme.color.border}`,
    background: active ? theme.color.blueSoft : '#fff', color: active ? theme.color.blue : theme.color.muted,
  });

  return (
    <main style={{ maxWidth: theme.layout.maxWidth, margin: '0 auto', padding: '40px 24px 72px', flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 6 }}>
        <h1 style={{ fontSize: 26, fontWeight: 600, color: theme.color.ink }}>Admin</h1>
        <span style={{ fontSize: 11, fontWeight: 600, color: theme.color.purple, background: theme.color.purpleSoft, border: `1px solid ${theme.color.purpleBorder}`, borderRadius: 6, padding: '4px 10px' }}>Operator only</span>
      </div>
      <p style={{ fontSize: 13.5, color: theme.color.muted, margin: '6px 0 28px' }}>Create test markets and manage resolution on Arc. Gate this route server-side by wallet/role — do not rely on client-side hiding.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 20, alignItems: 'start' }} data-breakpoint="720:1fr">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ background: '#fff', border: `1px solid ${theme.color.border}`, borderRadius: 12, boxShadow: theme.shadow.card, padding: 20 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Create test market</span>
            <label style={{ display: 'block', fontSize: 12, color: theme.color.muted, margin: '14px 0 6px', fontWeight: 500 }}>
              Admin secret {onAdminSecretChange ? '(required when ADMIN_SECRET is set on server)' : ''}
            </label>
            <input
              type="password"
              autoComplete="off"
              value={adminSecret}
              onChange={(e) => onAdminSecretChange?.(e.target.value)}
              placeholder="Leave empty only if server has no ADMIN_SECRET"
              style={{ width: '100%', border: `1px solid ${theme.color.border}`, borderRadius: 10, padding: '11px 14px', fontSize: 13.5, outline: 'none', color: theme.color.ink, fontFamily: theme.font.mono }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {['crypto', 'weather', 'network'].map((c) => (
                <button key={c} onClick={() => setCategory(c)} style={catBtn(category === c)}>{c[0].toUpperCase() + c.slice(1)}</button>
              ))}
            </div>
            <label style={{ display: 'block', fontSize: 12, color: theme.color.muted, margin: '16px 0 6px', fontWeight: 500 }}>Question</label>
            <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="BTC/USD above $X in the next window?"
              style={{ width: '100%', border: `1px solid ${theme.color.border}`, borderRadius: 10, padding: '11px 14px', fontSize: 13.5, outline: 'none', color: theme.color.ink }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: theme.color.muted, marginBottom: 6, fontWeight: 500 }}>Duration</label>
                <select value={duration} onChange={(e) => setDuration(e.target.value)} style={{ width: '100%', border: `1px solid ${theme.color.border}`, borderRadius: 10, padding: '11px 12px', fontSize: 13.5, color: theme.color.ink, background: '#fff' }}>
                  <option value="60">60 seconds</option>
                  <option value="300">5 minutes</option>
                  <option value="3600">1 hour</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, color: theme.color.muted, marginBottom: 6, fontWeight: 500 }}>Resolution source</label>
                <input value={source} onChange={(e) => setSource(e.target.value)} style={{ width: '100%', border: `1px solid ${theme.color.border}`, borderRadius: 10, padding: '11px 12px', fontSize: 13.5, outline: 'none', color: theme.color.ink }} />
              </div>
            </div>
            <Button
              fullWidth
              disabled={busy}
              style={{ marginTop: 16 }}
              onClick={async () => {
                setBusy(true);
                setCreated(null);
                try {
                  setCreated(await onCreateMarket({ category, question, duration, source }));
                } catch {
                  /* error surfaced via props.error */
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Creating…' : 'Create market on Arc'}
            </Button>
            {error && (
              <div style={{ marginTop: 12, background: theme.color.noSoft, color: theme.color.no, border: `1px solid ${theme.color.noBorder}`, borderRadius: 10, padding: '10px 12px', fontSize: 12.5 }}>
                {error}
              </div>
            )}
            {created && (
              <div style={{ marginTop: 12, background: theme.color.yesSoft, color: theme.color.yes, border: `1px solid ${theme.color.yesBorder}`, borderRadius: 10, padding: '10px 12px', fontSize: 12.5 }}>
                Market created · <a href={`https://testnet.arcscan.app/tx/${created.txHash}`} target="_blank" rel="noreferrer" style={{ color: theme.color.yes, fontFamily: theme.font.mono, textDecoration: 'underline' }}>tx {created.txHash} ↗</a>
              </div>
            )}
          </div>

          <div style={{ background: '#fff', border: `1px solid ${theme.color.border}`, borderRadius: 12, boxShadow: theme.shadow.card, padding: 20 }}>
            <button onClick={() => setResolverOpen((v) => !v)} style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: theme.font.sans }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Resolver tools (manual override)</span>
              <span style={{ color: theme.color.muted, fontSize: 12 }}>{resolverOpen ? 'Hide ▲' : 'Show ▼'}</span>
            </button>
            {resolverOpen && (
              <div style={{ marginTop: 16 }}>
                <label style={{ display: 'block', fontSize: 12, color: theme.color.muted, marginBottom: 6, fontWeight: 500 }}>Market address</label>
                <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x6644…e900"
                  style={{ width: '100%', border: `1px solid ${theme.color.border}`, borderRadius: 10, padding: '11px 14px', fontSize: 13, fontFamily: theme.font.mono, outline: 'none', color: theme.color.ink }} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
                  {(['YES', 'NO'] as const).map((o) => (
                    <button key={o} onClick={() => setOutcome(o)} style={{
                      flex: 1, borderRadius: 9, padding: 11, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: theme.font.sans,
                      border: outcome === o ? `1.5px solid ${o === 'YES' ? theme.color.yes : theme.color.no}` : `1px solid ${theme.color.border}`,
                      background: outcome === o ? (o === 'YES' ? theme.color.yesSoft : theme.color.noSoft) : '#fff',
                      color: outcome === o ? (o === 'YES' ? theme.color.yes : theme.color.no) : theme.color.muted,
                    }}>
                      Force {o}
                    </button>
                  ))}
                </div>
                <Button
                  variant="danger"
                  fullWidth
                  disabled={busy}
                  style={{ marginTop: 14 }}
                  onClick={async () => {
                    setBusy(true);
                    setResolved(false);
                    try {
                      await onForceResolve(address, outcome);
                      setResolved(true);
                    } catch {
                      /* error via props */
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Resolving…' : 'Force resolve'}
                </Button>
                {resolved && <div style={{ marginTop: 12, background: theme.color.tint, color: theme.color.muted, border: `1px solid ${theme.color.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 12.5 }}>Resolved {outcome} for {address}</div>}
              </div>
            )}
          </div>
        </div>

        <div style={{ background: '#fff', border: `1px solid ${theme.color.border}`, borderRadius: 12, boxShadow: theme.shadow.card, padding: 20 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Created this session</span>
          {createdMarkets.length === 0 ? (
            <p style={{ fontSize: 12.5, color: theme.color.muted, marginTop: 10 }}>No markets created yet this session.</p>
          ) : (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {createdMarkets.map((cm, i) => (
                <div key={i} style={{ border: `1px solid ${theme.color.border}`, borderRadius: 9, padding: '10px 12px', fontSize: 12.5, color: theme.color.ink }}>
                  {cm.question}
                  <div style={{ color: theme.color.muted, fontSize: 11, marginTop: 2 }}>{cm.meta}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
