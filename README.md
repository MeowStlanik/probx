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

### 1. Price margin (overround), not free 100% books
Quoted **YES + NO ≈ 105–110%** (default **108%** overround).  
Fair mid `p` becomes `p × 1.08` and `(1−p) × 1.08`. Users always pay a haircut vs fair odds; that margin is the first layer of house edge.

- **On-chain:** `MicroMarket.OVERROUND_BPS = 10800` applies on create and after each `applyTradeImpact`.
- **API / demo seed:** `applyPriceMargin()` in `quoteEngine.ts` keeps off-chain quotes consistent.

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
- **Email OTP** — app-issued 6-digit code via Gmail SMTP (or dev-echo in local)  
- **CCTP** — bridge USDC from Base Sepolia / Eth Sepolia → Arc  
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
| `contracts` | Foundry sources + tests |
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
pnpm contracts:test
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

### Core contracts (redeployed 2026-07-18)

| Contract | Address |
|----------|---------|
| MicroBoostEngine | [`0x0FFF38afe02B2476c5066bFe787510856f1ec5eE`](https://testnet.arcscan.app/address/0x0FFF38afe02B2476c5066bFe787510856f1ec5eE) |
| LiquidityPool | [`0xa84b574075f411a066e150fB8dac9b7564DDc4Ad`](https://testnet.arcscan.app/address/0xa84b574075f411a066e150fB8dac9b7564DDc4Ad) |
| MarketFactory | [`0x2a3CCe3173f55A29A9787b40160fb3553C1c36aA`](https://testnet.arcscan.app/address/0x2a3CCe3173f55A29A9787b40160fb3553C1c36aA) |
| PositionTicket | [`0x270e85b98d1299704fcbe459a3b1fd5ecA662e92`](https://testnet.arcscan.app/address/0x270e85b98d1299704fcbe459a3b1fd5ecA662e92) |
| OracleAdapter | [`0x0667401772AE42Aa09216dCe7a239DbB51D86c4b`](https://testnet.arcscan.app/address/0x0667401772AE42Aa09216dCe7a239DbB51D86c4b) |

LP seed on deploy: **15 USDC**. Full JSON: [`docs/DEPLOYMENT_ARC_TESTNET.json`](docs/DEPLOYMENT_ARC_TESTNET.json) (mirrors `apps/web/src/lib/deployment.json`).

---

## Circle & CCTP

| Capability | Implementation |
|------------|----------------|
| Email login | Circle **Developer-Controlled** wallets on `ARC-TESTNET` |
| Fallback | Local encrypted session EOA if `CIRCLE_*` incomplete |
| OTP | App-issued 6-digit code (Gmail SMTP in prod; `EMAIL_OTP_DEV_ECHO=1` shows code in UI locally) |
| Bridge | CCTP v2 **Forwarding** Base/Eth Sepolia → Arc |
| Gas | User pays **USDC** on Arc (no Paymaster / Gas Station) |

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
    → Fund USDC (direct Arc or CCTP)
    → Optional: LP deposit
    → Buy YES/NO (+ boost if vault allows)
    → Wait lock + observation
    → Auto/manual resolve → settle / claim
```

**Admin:** `/admin` — create test markets (BTC / London weather). Protect with `ADMIN_SECRET`. Resolver tools under *Advanced*.

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
NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS=0x0FFF38afe02B2476c5066bFe787510856f1ec5eE
NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS=0xa84b574075f411a066e150fB8dac9b7564DDc4Ad
NEXT_PUBLIC_MARKET_FACTORY_ADDRESS=0x2a3CCe3173f55A29A9787b40160fb3553C1c36aA
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
```

---

## Docs

- Deployment addresses: [`docs/DEPLOYMENT_ARC_TESTNET.json`](docs/DEPLOYMENT_ARC_TESTNET.json)
- Env template: [`.env.example`](.env.example)

---

<p align="center">
  <sub>Built for Arc · Programmable money · USDC all the way down</sub>
</p>
