// Design tokens extracted from ProbX Arc.dc.html — single source of truth for the port.
export const theme = {
  color: {
    blue: '#2775CA',
    blueHover: '#1c5ea3',
    blueSoft: '#EAF2FB',
    purple: '#7C5CFF',
    purpleSoft: '#F0ECFF',
    purpleBorder: '#E0D8FF',
    yes: '#1F9D6B',
    yesSoft: '#E7F5EF',
    yesBorder: '#C9E5D8',
    no: '#D6544A',
    noSoft: '#FBEDEB',
    noBorder: '#EAD4D1',
    tint: '#F6F8FA',
    border: '#E4E9F0',
    borderStrong: '#D3DCE7',
    ink: '#0B1622',
    muted: '#5B6A7D',
  },
  font: {
    sans: "'Inter', sans-serif",
    display: "'Inter Tight', sans-serif",
    mono: "'IBM Plex Mono', monospace",
  },
  radius: { sm: 8, md: 10, lg: 12, xl: 14, xxl: 16, pill: 20 },
  shadow: {
    card: '0 1px 2px rgba(16,32,64,.05)',
    cardHover: '0 8px 24px rgba(16,32,64,.08)',
    popover: '0 12px 32px rgba(16,32,64,.14)',
    modal: '0 20px 60px rgba(16,32,64,.25)',
  },
  layout: {
    maxWidth: 1152,
    narrowMaxWidth: 1000, // onboarding
    portfolioMaxWidth: 900,
    pagePaddingX: 24,
    headerHeight: 64,
    pagePaddingY: '40px 72px',
    cardPadding: 20,
    cardGap: 18,
    breakpoint: 720, // single breakpoint: stack 2-col grids, bottom-sheet popover
  },
} as const;

export type MarketStage = 'OPEN' | 'LOCK' | 'PAUSE' | 'OBSERVE' | 'RESOLVE';
export type Side = 'YES' | 'NO';
