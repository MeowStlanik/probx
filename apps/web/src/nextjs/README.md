# ProbX Arc — Next.js handoff

Direct port of `ProbX Arc.dc.html`. All components are typed, data comes in via props (no mock fetching baked in) — wire your existing `services/*` and hooks where each view's props say to.

## Structure
- `theme.ts` — every color/font/spacing/radius/shadow token used in the design. Import this, don't re-derive values.
- `types.ts` — prop shapes for every domain object (MarketSummary, MarketDetail, Position, CctpStep, WalletState, ...).
- `components/` — reusable pieces used across screens: `Button`, `StatusPill`/`SideChip`, `MarketCard` (+ `LifecycleBar`/`VolumeBar`), `Tables` (Activity/Allocation rows), `AmountInput`, `EmptyState`/`SkeletonCard`/`SkeletonRow`, `Header` (nav + wallet), `WalletPopover`, `FundModal`, `Footer`.
- `views/` — one component per screen, taking all screen data as props: `HomeView`, `MarketsListView`, `MarketDetailView`, `LPView`, `PortfolioView`, `AdminView`.

## Wiring into App Router
Each view is presentational + owns only its own local UI state (input values, open/closed tabs). Fetch data in a Server Component or a hook and pass down:

```tsx
// app/markets/page.tsx
import { MarketsListView } from '@/nextjs/views/MarketsListView';
import { getMarkets } from '@/services/markets'; // your existing service

export default async function Page() {
  const markets = await getMarkets();
  return <MarketsListView state="live" markets={markets} onSelectMarket={...} onRetry={...} />;
}
```

`Header`/`Footer` belong in `app/layout.tsx`, wrapping `{children}`. `Header` needs wallet state and handlers lifted to a client provider (your existing wallet context) — plug into `onConnectBrowser`, `onSendCode`, `onVerifyCode`, `onDisconnect`, `onFixNetwork`, `onDeposit`, `onBridge`.

## Notes carried over from the design spec
- Breakpoint: 720px. Two-column grids (`Market detail`, `LP`, `Admin`) marked `data-breakpoint="720:1fr"` — add the media query in your global stylesheet (`@media (max-width:720px){ [data-breakpoint] { grid-template-columns: 1fr !important } }`) or convert to a CSS module.
- Loading/empty/error states are explicit props (`state: 'live' | 'loading' | 'empty' | 'error'`) on `MarketsListView`, `MarketDetailView`, `PortfolioView` — wire to your query's status.
- Logo: use one file, `/public/probx-logo.png` (copied from `assets/probx-logo.png` in the design project), referenced via `next/image` in `Header`/`Footer` and reused for favicon at build time.
- `MarketDetailView`'s chart is a placeholder box — swap in your existing `MarketLiveChart` with `market.priceHistory`.
