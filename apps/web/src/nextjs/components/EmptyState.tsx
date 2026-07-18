import { ReactNode } from 'react';
import { theme } from '../theme';

// Reusable panel for empty / error states across Markets, Market detail, Portfolio.
export function EmptyState({
  title,
  description,
  tone = 'muted',
  action,
}: {
  title: string;
  description?: string;
  tone?: 'muted' | 'error';
  action?: ReactNode;
}) {
  const isError = tone === 'error';
  return (
    <div
      style={{
        background: isError ? theme.color.noSoft : theme.color.tint,
        border: `1px solid ${isError ? theme.color.noBorder : theme.color.border}`,
        borderRadius: theme.radius.lg,
        padding: '32px 20px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: isError ? theme.color.no : theme.color.ink }}>{title}</div>
      {description && <p style={{ fontSize: 12.5, color: theme.color.muted, margin: '6px 0 0' }}>{description}</p>}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div style={{ background: '#fff', border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.xl, boxShadow: theme.shadow.card, padding: 20 }}>
      <div style={{ height: 18, width: 70, borderRadius: 5, background: theme.color.tint }} />
      <div style={{ height: 16, width: '90%', borderRadius: 5, background: theme.color.tint, marginTop: 16 }} />
      <div style={{ height: 16, width: '60%', borderRadius: 5, background: theme.color.tint, marginTop: 8 }} />
      <div style={{ display: 'flex', gap: 9, marginTop: 18 }}>
        <div style={{ flex: 1, height: 52, borderRadius: 10, background: theme.color.tint }} />
        <div style={{ flex: 1, height: 52, borderRadius: 10, background: theme.color.tint }} />
      </div>
    </div>
  );
}

export function SkeletonRow() {
  return <div style={{ height: 64, borderRadius: 12, background: theme.color.tint }} />;
}
