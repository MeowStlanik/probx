import { theme } from '../theme';

interface Props {
  value: number | string;
  onChange: (v: string) => void;
  suffix?: string;
  placeholder?: string;
  mono?: boolean;
}

export function AmountInput({ value, onChange, suffix = 'USDC', placeholder, mono = true }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${theme.color.border}`, borderRadius: theme.radius.md, padding: '0 14px' }}>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1,
          border: 'none',
          outline: 'none',
          fontFamily: mono ? theme.font.mono : theme.font.sans,
          fontSize: 18,
          fontWeight: 600,
          color: theme.color.ink,
          padding: '12px 0',
          background: 'transparent',
        }}
      />
      <span style={{ fontSize: 12, color: theme.color.muted, fontWeight: 600 }}>{suffix}</span>
    </div>
  );
}
