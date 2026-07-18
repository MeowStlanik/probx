import { theme } from '../theme';

type Tone = 'yes' | 'no' | 'blue' | 'purple' | 'muted';

const toneMap: Record<Tone, { bg: string; fg: string }> = {
  yes: { bg: theme.color.yesSoft, fg: theme.color.yes },
  no: { bg: theme.color.noSoft, fg: theme.color.no },
  blue: { bg: theme.color.blueSoft, fg: theme.color.blue },
  purple: { bg: theme.color.purpleSoft, fg: theme.color.purple },
  muted: { bg: theme.color.tint, fg: theme.color.muted },
};

export function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  const c = toneMap[tone];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: c.fg,
        background: c.bg,
        borderRadius: 6,
        padding: '3px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

// Convenience for YES/NO chips used in tables/cards.
export function SideChip({ side }: { side: 'YES' | 'NO' }) {
  return <StatusPill label={side} tone={side === 'YES' ? 'yes' : 'no'} />;
}
