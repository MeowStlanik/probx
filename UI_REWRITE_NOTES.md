# ProbX Arc — full UI rewrite (theme layer)

## What changed
Presentational UI from design handoff lives under `apps/web/src/nextjs/`.
App Router pages are thin shells that pass real data/handlers into views.
Business logic (wallet, on-chain, API routes, contracts) is unchanged.

## Rename note
Mock files in the zip already matched their `export function` names — no shift rename needed.

## Screens

### Admin
- Files: `nextjs/views/AdminView.tsx`, `nextjs/shells/AdminShell.tsx`, `app/admin/page.tsx`
- Wired: `POST /api/markets/create-demo`, `POST /api/oracle/resolve` (same as `OnchainAdminPanel.postAdminAction`)

### LP
- Files: `nextjs/views/LPView.tsx`, `nextjs/shells/LpShell.tsx`, `app/lp/page.tsx`
- Wired: `poolAbi.deposit` / `withdraw`, `usdcAbi.approve`, on-chain vault reads, `fetchMarkets` + `deriveAllocations`, SSR `fetchLpStats`

### Markets list
- Files: `nextjs/views/MarketsListView.tsx`, `nextjs/shells/MarketsShell.tsx`, `app/markets/page.tsx`
- Wired: `fetchMarkets` / `api.server.fetchMarkets`

### Market detail
- Files: `nextjs/views/MarketDetailView.tsx`, `nextjs/shells/MarketDetailShell.tsx`, `app/markets/[marketId]/page.tsx`
- Wired: `fetchMarket`, `engineAbi.quoteTicket` + `buyTicket`, `usdcAbi.approve`, `savePosition`, activity from `loadActivity`

### Home
- Files: `nextjs/views/HomeView.tsx`, `nextjs/shells/HomeShell.tsx`, `app/page.tsx`
- Wired: SSR `fetchMarkets` + `fetchLpStats`, deployment addresses for flow nodes

### Portfolio
- Files: `nextjs/views/PortfolioView.tsx`, `nextjs/shells/PortfolioShell.tsx`, `app/portfolio/page.tsx`
- Wired: `fetchUserTickets`, `engineAbi.settleTicket`

### Header / Footer
- Files: `nextjs/components/Header.tsx`, `WalletPopover.tsx`, `Footer.tsx`, `nextjs/shells/AppChrome.tsx`, `app/layout.tsx`
- Wired: `useWallet()` → connect / requestEmailOtp / verifyEmailOtp / disconnect / ensureArcChain
- Deposit/Bridge → existing `FundUsdcPanel` (real CCTP + faucet flow)
- Quick trade href from `pickLiveMarketHref` + `/api/markets` poll

## Global
- `nextjs/breakpoint.css` — `@media (max-width:720px){ [data-breakpoint]{grid-template-columns:1fr!important} }`
- Logo: `/public/probx-logo.png`
- `globals.css` is imported again in `layout.tsx` so legacy class-based surfaces still work:
  - `FundUsdcPanel` (header Deposit / Bridge)
  - `loading.tsx` / `MarketsLoading` (`heroAurora`, `pageShell`, …)
  New theme screens stay on `theme.ts` inline styles; class names do not collide with nextjs views.

## TODO / manual check
1. Market detail chart is still a placeholder box — plug `MarketLiveChart` if desired.
2. Fund modal mock (`FundModal.tsx`) is not used; real funding uses `FundUsdcPanel` for correctness.
3. Admin secret still via sessionStorage key `probx.adminSecret` (no UI field in new AdminView) — if ADMIN_SECRET is set server-side, add a small secret input or inject from env for operators.
4. Admin "Created this session" is client-only (not persisted across reloads beyond session memory).
5. Portfolio "Realized P&L" is derived client-side from ticket results; verify against indexer edge cases.
6. Boost range in mock is 1–1.3×; on-chain max may be higher (`maxBoost` on market) — consider aligning slider max to market.maxBoost.
7. Live price history samples are synthetic until a real history API exists.
8. Do not deploy without smoke-testing: connect wallet, create market, buy ticket, LP deposit, claim.
