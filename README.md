<h1 align="center">ProbX Arc</h1>

<p align="center">
  <strong>USDC-native short prediction markets on Arc</strong><br/>
  Locked YES/NO tickets · LP-backed Micro Boost · Circle Wallets · CCTP
</p>

<p align="center">
  <a href="https://testnet.arcscan.app"><img src="https://img.shields.io/badge/Network-Arc%20Testnet-7C5CFF?style=flat-square" alt="Arc Testnet" /></a>
  <a href="#arc-testnet"><img src="https://img.shields.io/badge/Gas-USDC%20native-2775CA?style=flat-square" alt="USDC gas" /></a>
  <a href="#circle--cctp"><img src="https://img.shields.io/badge/Circle-Wallets%20%2B%20CCTP-6B46C1?style=flat-square" alt="Circle" /></a>
  <img src="https://img.shields.io/badge/License-MIT-22C55E?style=flat-square" alt="MIT" />
</p>

---

## Why ProbX

Short markets can resolve in minutes. Classic margin leverage needs liquidations and mark prices — that does not fit a 60-second window.

**Micro Boost** is different:

| | Classic leverage | Micro Boost |
|--|------------------|-------------|
| Max user loss | Can cascade | **Fixed** = ticket stake |
| Extra exposure | Borrow / liquidation | **LP reserves** max payout first |
| Ticket | Transferable position | **Locked**, non-transferable |
| Settlement | Continuous | **Resolve → settle** |

```text
payout ≈ (stake / odds) × boost
reserve  = payout − stake
accept only if LP available ≥ reserve
```

Everything settles in **USDC**. On Arc, **gas is USDC too** — no ETH side-quest.

---

## Why the book can work (economics)

Short-horizon markets die if the book is a pure 50/50 mid with free leverage. ProbX stacks three simple guards so informed flow does not drain LP on every cycle:

### 1. Price margin (overround) — on-chain only
The book keeps a sportsbook-style margin: **on-chain quoted YES+NO ≈ 108%** of fair scale (`OVERROUND_BPS = 10800`). That is the first layer of house edge and funds modest boost.

- **UI:** odds are shown as **normalized shares that sum to 100%** (relative YES/NO), so users never see a “108% market”.
- **Pricing / tickets:** still use raw on-chain prices (with overround) for payout math.
- **API seed:** `applyPriceMargin()` in `quoteEngine.ts` matches contract quoting.

### 2. Boost is paid for — not free LP marketing by default
Micro Boost multiplies payout, so without a fee it is pure LP risk. Design:

| Boost level | Funding |
|-------------|---------|
| **≤ ~1.08×** (`1 + margin`) | Covered by book overround in expectation |
| **Above economic cap** | Intentional LP spend **or** higher boost fee |

- Boost fee raised an order of magnitude (`BOOST_FEE_BPS = 400` ≈ **4% per unit of boost above 1×**, was 0.4%).
- API `maxBoost()` still respects LP capacity but treats **economic max ≈ 1.08×** as the self-funded band.

### 3. Timing: sniper buffer + lock pause
Entry is not “open until observation starts”:

```text
open ──► lock (entry − ~12s) ──► pause (~10s) ──► observation ──► resolve
```

- **Sniper buffer:** lock fires **~10–15s before** the nominal end of the entry window so last-millisecond flow cannot reprice against a known print.
- **Lock pause:** `observationStart = lockTime + pause` so observation does not begin the same second as lock.

### 4. Seed odds from the feed, not flat 50/50
New BTC / weather markets estimate a **fair mid** from live structure before applying overround:

- **BTC (1-minute up/down):** near 50% with a small tilt from recent return (random-walk prior).
- **London temp ≥ now:** modest YES edge (temperature is sticky over 60s).

That cuts the free lunch for anyone who would otherwise only buy mispriced 50/50 tickets.

> **Deploy note:** overround + higher boost fee live in **contract bytecode**. Redeploy after changing those constants. Current Arc Testnet deployment: **2026-07-18** (see addresses below).

---

## Features

- **On-chain markets** — factory, engine, LP vault, tickets on Arc Testnet  
- **Micro Boost** — optional payout multiplier gated by LP capacity  
- **LP vault** — deposit / withdraw underwriting liquidity  
- **Live feeds** — BTC (Coinbase) & London temp (Open-Meteo), auto-resolve  
- **Circle Wallets** — email → Developer-Controlled EOA on Arc (fallback: local session EOA if Circle not configured)  
- **Durable wallet mapping** — email → walletId persisted in Redis KV (Upstash / Vercel KV); recovery via Circle `listWallets(refId)` — no duplicate wallets after logout  
- **Email OTP** — app-issued 6-digit code via Gmail SMTP (or dev-echo in local)  
- **CCTP** — bridge USDC from Base Sepolia / Eth Sepolia → Arc  
- **Send USDC** — transfer to any Arc address from the wallet popover (Circle or MetaMask path)  
- **Tx status tracking** — buy / claim / deposit / send tracked `pending → confirmed / failed`, reconciled server-side  
- **Dual path** — email session or MetaMask for trade & claim  

---

## Architecture

```text
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────────────┐
│  Next.js UI │────▶│  Next API routes     │────▶│  Arc Testnet            │
│  (Vercel)   │     │  apps/web/src/app/api│     │  MicroBoost · LP · Mkts │
└──────┬──────┘     │  (+ optional apps/api│     └───────────┬─────────────┘
       │            │   standalone :3001)  │                 │
       │            └──────┬───────────────┘                 │ USDC
       │                   │                                 │
       │            ┌──────▼───────┐                 ┌───────▼───────┐
       └───────────▶│ Circle API   │                 │ CCTP Iris     │
         email EOA  │ Wallets      │                 │ Base → Arc    │
                    └──────────────┘                 └───────────────┘
```

| Package | Role |
|---------|------|
| `apps/web` | Markets, portfolio, LP, admin, fund UI + **API route handlers** |
| `apps/api` | Shared services (quotes, Circle, CCTP, workers); optional standalone server on `:3001` |
| `contracts` | Foundry sources + [tests](./contracts/test/) |
| `scripts/` | `deploy-arc`, smoke, demo markets, RPC preflight |

---

## Quick start

```bash
pnpm install
cp .env.example .env   # fill keys — never commit .env

# Recommended (UI + API in one Next process, port 3000):
pnpm dev:web
# or: pnpm --filter @probx/web exec next dev -H 0.0.0.0 -p 3000

# Optional: standalone API on :3001 (set NEXT_PUBLIC_API_BASE_URL=http://localhost:3001)
pnpm dev:api
```

Leave `NEXT_PUBLIC_API_BASE_URL` empty to call same-origin `/api/*` (default for Vercel and local Next).

```bash
pnpm contracts:build
pnpm contracts:test      # 14 forge tests → contracts/test/
pnpm deploy:arc          # needs PRIVATE_KEY + USDC on Arc Testnet
```

---

## Arc Testnet

| | |
|--|--|
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | [testnet.arcscan.app](https://testnet.arcscan.app) |
| USDC | `0x3600000000000000000000000000000000000000` |
| Deployer | `0x4604a582B66431481D5320fed67C785bdb4D7Fe0` |

### Core contracts (redeployed 2026-07-19 — audit fixes)

| Contract | Address |
|----------|---------|
| MicroBoostEngine | [`0x9458631dc97C8320db6b2224BD8E22bC627E2211`](https://testnet.arcscan.app/address/0x9458631dc97C8320db6b2224BD8E22bC627E2211) |
| LiquidityPool | [`0xedc959c24c8EbC26b7E5cC994b37a47727E50a2E`](https://testnet.arcscan.app/address/0xedc959c24c8EbC26b7E5cC994b37a47727E50a2E) |
| MarketFactory | [`0xf0ac9759DCFf5565C4adD7Ae5B15DdBeF8f6B1Cc`](https://testnet.arcscan.app/address/0xf0ac9759DCFf5565C4adD7Ae5B15DdBeF8f6B1Cc) |
| PositionTicket | [`0x2a8C4a06945071383E00F6187f4B4E925408837D`](https://testnet.arcscan.app/address/0x2a8C4a06945071383E00F6187f4B4E925408837D) |
| OracleAdapter | [`0x53e06a44DE09f238fb682348D0F9cF733bD1B99A`](https://testnet.arcscan.app/address/0x53e06a44DE09f238fb682348D0F9cF733bD1B99A) |
| InsuranceFund | [`0xe2AE3c0bcFc03Bb4bb10B66e6b21f1288957dd6C`](https://testnet.arcscan.app/address/0xe2AE3c0bcFc03Bb4bb10B66e6b21f1288957dd6C) |

LP seed on deploy: **15 USDC**. Full JSON: [`docs/DEPLOYMENT_ARC_TESTNET.json`](docs/DEPLOYMENT_ARC_TESTNET.json) (mirrors `apps/web/src/lib/deployment.json`).

---

## Circle & CCTP

| Capability | Implementation |
|------------|----------------|
| Email login | Circle **Developer-Controlled** wallets on `ARC-TESTNET` |
| Fallback | Local encrypted session EOA if `CIRCLE_*` incomplete |
| OTP | App-issued 6-digit code (Gmail SMTP in prod; `EMAIL_OTP_DEV_ECHO=1` shows code in UI locally) |
| Bridge | CCTP v2 **Forwarding** Base/Eth Sepolia → Arc |
| Gas | User pays **USDC** on Arc |

MetaMask can burn on the source chain while **mint lands on the email session** — separate CCTP connect, no session hijack.

**Server-only env:**

```text
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=          # 64-char hex; save recovery_file_*.dat when registering
CIRCLE_WALLET_SET_ID=
CCTP_SOURCE_PRIVATE_KEY=       # optional server fund treasury
```

Entity secret is per **Circle account** (not per API key). Without `recovery_file_*.dat` you cannot reset a lost secret.

---

## Email OTP (Gmail SMTP)

Production mail is sent from the app (not Circle). Prefer **Gmail App Password**:

1. [2-Step Verification](https://myaccount.google.com/signinoptions/two-step-verification)  
2. [App passwords](https://myaccount.google.com/apppasswords) → Mail  

```text
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=                    # 16-char app password — keep only on Vercel if preferred
BREVO_FROM_EMAIL=you@gmail.com
BREVO_FROM_NAME=ProbX
EMAIL_OTP_DEV_ECHO=0          # 1 = show code in UI (local/dev)
EMAIL_OTP_REQUIRED=1
```

---

## User flow

```text
Connect (email or MetaMask)
    → Fund USDC (direct Arc, CCTP, or receive a Send from another wallet)
    → Optional: LP deposit
    → Buy YES/NO (+ boost if vault allows)   [tx: pending → confirmed]
    → Wait lock + observation (live chart vs start line)
    → Auto/manual resolve → settle / claim
    → Send USDC out to any Arc address anytime
```

**Admin:** `/admin` — create test markets (BTC / London weather). No UI entry point (header/footer links removed) — open the URL directly. Protect with `ADMIN_SECRET`. Resolver tools under *Advanced*.

---

## Deploy (Vercel — UI + API together)

API lives as Next.js route handlers under `apps/web/src/app/api/**` (no separate API host required).

| Setting | Value |
|---------|--------|
| Framework | Next.js |
| Root Directory | **repository root** (root `vercel.json`) **or** `apps/web` (see `apps/web/vercel.json`) |
| Install | `npm install -g pnpm@9.12.3 && pnpm install` |
| Build | `pnpm --filter @probx/web build` |

### Environment variables on Vercel

**Public**

```text
NEXT_PUBLIC_API_BASE_URL=
NEXT_PUBLIC_CHAIN_ID=5042002
NEXT_PUBLIC_ARC_RPC_URL=https://rpc.testnet.arc.network
NEXT_PUBLIC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS=0x9458631dc97C8320db6b2224BD8E22bC627E2211
NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS=0xedc959c24c8EbC26b7E5cC994b37a47727E50a2E
NEXT_PUBLIC_MARKET_FACTORY_ADDRESS=0xf0ac9759DCFf5565C4adD7Ae5B15DdBeF8f6B1Cc
```

**Server-only** (Sensitive; no `NEXT_PUBLIC_` prefix)

```text
ARC_RPC_URL=https://rpc.testnet.arc.network
PRIVATE_KEY=
ORACLE_PRIVATE_KEY=
ADMIN_SECRET=
CRON_SECRET=
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=
CIRCLE_WALLET_SET_ID=
CCTP_SOURCE_PRIVATE_KEY=
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
BREVO_FROM_EMAIL=
BREVO_FROM_NAME=ProbX
EMAIL_OTP_DEV_ECHO=0
EMAIL_OTP_REQUIRED=1
OTP_HMAC_SECRET=
SESSION_WALLET_SECRET=
MARKET_CYCLE_ENABLED=1
MARKET_CYCLE_ON_TRAFFIC=1      # background cycle on site traffic (0 = off)
RPC_BATCH=1                    # JSON-RPC batching (0 = plain per-call requests)
UPSTASH_REDIS_REST_URL=        # durable wallet map + tx statuses (free tier ok)
UPSTASH_REDIS_REST_TOKEN=      # KV_REST_API_URL / KV_REST_API_TOKEN also accepted
```

> **Without the KV vars** the email → wallet mapping and tx statuses fall back
> to per-instance `/tmp` files — fine locally, ephemeral on Vercel. Set Upstash
> (free) for production reliability.

### Markets 24/7

The BTC / weather cycle (create → observe → resolve) needs a trigger about
**once per minute**. Vercel Hobby cron fires ~once a day, so:

1. **External pinger (recommended):** hit `GET /api/cron/market-cycle?secret=CRON_SECRET` every minute — free on cron-job.org. Full guide: [`docs/EXTERNAL_CRON.md`](docs/EXTERNAL_CRON.md).
2. **On-traffic fallback (built-in):** while anyone has the site open, the cycle self-runs in the background (throttled 50s across instances via KV). Zero traffic → falls back to the daily cron only.

---

## Docs

- Deployment addresses: [`docs/DEPLOYMENT_ARC_TESTNET.json`](docs/DEPLOYMENT_ARC_TESTNET.json)
- Env template: [`.env.example`](.env.example)
- External cron pinger (markets 24/7): [`docs/EXTERNAL_CRON.md`](docs/EXTERNAL_CRON.md)

---

<p align="center">
  <sub>Built for Arc · Programmable money · USDC all the way down</sub>
</p>
