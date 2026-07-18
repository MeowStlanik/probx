import { theme } from '../theme';
import { ActivityRow, AllocationRow } from '../types';
import { SideChip } from './StatusPill';

const cellStyle = { padding: 8, fontSize: 12.5 } as const;
const headStyle = { padding: '6px 8px', fontWeight: 500, fontSize: 11, color: theme.color.muted, textTransform: 'uppercase' as const, letterSpacing: '.02em' };

export function ActivityTable({ rows }: { rows: ActivityRow[] }) {
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 12, minWidth: 520 }}>
      <thead>
        <tr style={{ textAlign: 'left' }}>
          <th style={headStyle}>Time</th>
          <th style={headStyle}>Side</th>
          <th style={{ ...headStyle, textAlign: 'right' }}>Stake</th>
          <th style={{ ...headStyle, textAlign: 'right' }}>Boost</th>
          <th style={{ ...headStyle, textAlign: 'right' }}>Payout</th>
          <th style={{ ...headStyle, textAlign: 'right' }}>Tx</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t, i) => (
          <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : theme.color.tint }}>
            <td style={{ ...cellStyle, fontFamily: theme.font.mono, color: theme.color.muted }}>{t.time}</td>
            <td style={cellStyle}><SideChip side={t.side} /></td>
            <td style={{ ...cellStyle, fontFamily: theme.font.mono, color: theme.color.ink, textAlign: 'right' }}>{t.stake}</td>
            <td style={{ ...cellStyle, fontFamily: theme.font.mono, color: theme.color.ink, textAlign: 'right' }}>{t.boost}</td>
            <td style={{ ...cellStyle, fontFamily: theme.font.mono, color: theme.color.ink, textAlign: 'right' }}>{t.payout}</td>
            <td style={{ ...cellStyle, textAlign: 'right' }}>
              <a href={t.txHref} target="_blank" rel="noreferrer" style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.purple }}>{t.tx} ↗</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AllocationTable({ rows }: { rows: AllocationRow[] }) {
  if (!rows.length) {
    return (
      <p style={{ margin: '16px 0 0', fontSize: 13, color: theme.color.muted, textAlign: 'center', padding: '24px 12px' }}>
        No live reserve rows yet. When tickets lock capital, activity shows here.
      </p>
    );
  }
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: 12, minWidth: 480 }}>
      <thead>
        <tr style={{ textAlign: 'left' }}>
          <th style={headStyle}>Time</th>
          <th style={headStyle}>Market</th>
          <th style={headStyle}>Side</th>
          <th style={{ ...headStyle, textAlign: 'right' }}>Amount</th>
          <th style={{ ...headStyle, textAlign: 'right' }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a, i) => (
          <tr key={a.id || i} style={{ background: i % 2 === 0 ? '#fff' : theme.color.tint }}>
            <td style={{ ...cellStyle, fontFamily: theme.font.mono, color: theme.color.muted }}>{a.time}</td>
            <td style={{ ...cellStyle, color: theme.color.ink }}>{a.market}</td>
            <td style={cellStyle}><SideChip side={a.side} /></td>
            <td style={{ ...cellStyle, fontFamily: theme.font.mono, color: theme.color.ink, textAlign: 'right' }}>{a.amount}</td>
            <td style={{ ...cellStyle, textAlign: 'right', fontSize: 11.5, fontWeight: 600, color: a.status === 'Active' ? theme.color.yes : theme.color.muted }}>{a.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
