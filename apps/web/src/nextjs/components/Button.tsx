import { CSSProperties, ButtonHTMLAttributes } from 'react';
import { theme } from '../theme';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'md' | 'sm';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
}

const base: CSSProperties = {
  fontFamily: theme.font.sans,
  fontWeight: 600,
  cursor: 'pointer',
  border: 'none',
  borderRadius: theme.radius.md,
};

export function Button({ variant = 'primary', size = 'md', fullWidth, style, disabled, ...rest }: Props) {
  const sizing: CSSProperties = size === 'sm'
    ? { padding: '7px 12px', fontSize: 11.5 }
    : { padding: '13px', fontSize: 13.5 };

  const variants: Record<Variant, CSSProperties> = {
    primary: { background: theme.color.blue, color: '#fff' },
    secondary: { background: '#fff', color: theme.color.ink, border: `1px solid ${theme.color.border}` },
    danger: { background: theme.color.no, color: '#fff' },
    ghost: { background: 'none', color: theme.color.muted, padding: 0 },
  };

  return (
    <button
      disabled={disabled}
      style={{
        ...base,
        ...sizing,
        ...variants[variant],
        width: fullWidth ? '100%' : undefined,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
      {...rest}
    />
  );
}
