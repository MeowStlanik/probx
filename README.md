<h1 align="center">ProbX Arc</h1>

<p align="center">
  <strong>USDC-native conditional settlement on Arc</strong><br/>
  LP-underwritten payouts · Circle Wallets · App Kits · CCTP
</p>

<p align="center">
  <strong><a href="https://probx-web.vercel.app">▶ Live demo</a></strong> ·
  <a href="#see-it-in-2-minutes">See it in 2 minutes</a> ·
  <a href="#circle-cctp--app-kits">Circle stack</a> ·
  <a href="#scope">Scope</a>
</p>

<p align="center">
  <img src="apps/web/public/assets/probx-arc-visuals.png" alt="ProbX Arc" width="820" />
</p>

<p align="center">
  <a href="https://testnet.arcscan.app"><img src="https://img.shields.io/badge/Network-Arc%20Testnet-7C5CFF?style=flat-square" alt="Arc Testnet" /></a>
  <a href="#arc-testnet"><img src="https://img.shields.io/badge/Gas-USDC%20native-2775CA?style=flat-square" alt="USDC gas" /></a>
  <a href="#circle-cctp--app-kits"><img src="https://img.shields.io/badge/Circle-Wallets%20%C2%B7%20App%20Kits%20%C2%B7%20CCTP-6B46C1?style=flat-square" alt="Circle" /></a>
  <img src="https://img.shields.io/badge/Tests-21%20passing-22C55E?style=flat-square" alt="21 tests" />
  <img src="https://img.shields.io/badge/License-MIT-64748B?style=flat-square" alt="MIT" />
</p>

---

## What this is

ProbX is a **conditional settlement engine**: capital is reserved up front against an
outcome, the outcome is resolved by an oracle, and USDC settles automatically — all in
one 60-second cycle, all denominated in USDC.

Three primitives make it work:

| Primitive | What it does |
|-----------|--------------|
| **Liquidity vault** | LPs deposit USDC and underwrite payouts; earn book margin + fees |
| **Reserve engine** | Reserves the max payout *before* accepting a position — no undercollateralised exposure |
| **Micro Boost** | Optional payout multiplier, gated by live LP capacity |

The first application built on top is **short-horizon prediction markets** (BTC direction,
London temperature). The same engine underwrites any binary condition that an oracle can
resolve — insurance triggers, parametric payouts, conditional escrow.

**Why Arc:** a 60-second settlement cycle is not viable when a user needs a second asset
for gas and confirmation takes twelve seconds. On Arc, gas is USDC and finality is
sub-second, so the entire flow — fund, position, resolve, claim — happens inside the
window and never touches ETH.

---

## See it in 2 minutes

1. Open the [live demo](https://probx-web.vercel.app) → **Markets**. A BTC and a London-temp market run continuously on a ~75s entry / 60s observation cycle.
2. Sign in with email (Circle Developer-Controlled wallet on Arc) or MetaMask.
3. Fund with testnet USDC — directly on Arc, or from Base Sepolia via **App Kit bridge**.
4. Take a YES/NO position, optionally with Micro Boost. Watch the live chart against the start line, then claim after auto-resolve.

Gas is paid in USDC. There is no ETH step anywhere in that flow.

> Markets are driven by an **external** minute pinger (see [Markets 24/7](#markets-247)). If the list looks empty, the pinger is down, not the app — any page load also kicks the cycle in the background.

---

## Micro Boost

Short-horizon exposure can't use classic margin: liquidations and mark prices don't fit a
60-second window. Micro Boost solves it differently — the vault reserves the maximum
payout before the position is accepted, so user downside is bounded by the stake and LP
downside is bounded by the reserve.

| | Classic leverage | Micro Boost |
|--|------------------|-------------|
| Max user loss | Can cascade | **Fixed** = stake |
| Extra exposure | Borrow / liquidation | **LP reserves** max payout first |
| Position | Transferable | **Locked**, non-transferable |
| Settlement | Continuous | **Resolve → settle** |

```text
payout ≈ (stake / odds) × boost
reserve  = payout − stake
accept only if LP available ≥ reserve
```

Everything settles in USDC. On Arc, gas is USDC too.

---

## Book economics

Short-horizon books die if the price is a pure 50/50 mid with free leverage. Three guards
keep informed flow from draining the vault:

### 1. Price margin (overround) — enforced on-chain
Quoted YES+NO sums to **≈108%** of fair scale (`OVERROUND_BPS = 10800`). That margin is
the first layer of house edge and funds modest boost.

- **UI:** odds display as normalised shares summing to 100%, so users never see a "108% market".
- **Pricing:** raw on-chain prices (with overround) drive payout math.
- **API:** `applyPriceMargin()` in `quoteEngine.ts` mirrors contract quoting.

### 2. Boost is paid for
Boost multiplies payout, so without a fee it is pure LP risk.

| Boost level | Funding |
|-------------|---------|
| **≤ ~1.08×** (`1 + margin`) | Covered by book overround in expectation |
| **Above economic cap** | Boost fee (`BOOST_FEE_BPS = 400` ≈ 4% per unit of boost above 1×) |

`maxBoost()` respects live LP capacity and treats **≈1.08×** as the self-funded band.

### 3. Timing: hard entry cutoff + lock pause

```text
open ──► lock ──► pause (10s) ──► observation ──► resolve
```

- **Hard cutoff (on-chain):** `MicroMarket.canBuy()` requires `block.timestamp < lockTime`, so entry stops at `lockTime` whether or not `lock()` has been called.
- **Lock pause:** `observationStart = lockTime + pause`, default **10s** (`MARKET_LOCK_PAUSE_SECONDS`). No position can land within 10s of the observation window opening, so nobody enters against a print they already know.
- **Sniper buffer:** `MARKET_SNIPER_BUFFER_SECONDS` (default 5s) trims the entry window; `MARKET_CREATE_TX_SLACK_SECONDS` (default 18s) pads it to absorb create+open latency. Net for a nominal 75s window: `lockTime ≈ open + 88s`, visible entry window ~60–75s.

### 4. Seed odds from the feed
New markets estimate a fair mid from live structure before applying overround — BTC from
recent return (random-walk prior), London temp with a modest YES tilt (temperature is
sticky over 60s). No free lunch on mispriced flat 50/50 tickets.

> **Deploy note:** overround and boost fee live in **contract bytecode**. Redeploy after changing those constants.

---

## Security

The reserve engine holds user funds, so the invariants are covered by tests rather than
assumed. `pnpm contracts:test` → **21 passing**.

| Area | Guarantee | Test |
|------|-----------|------|
| **Quote integrity** | Price impact is strictly proportional to stake; `MIN_USER_RISK_PER_TICKET` (0.25 USDC) blocks dust trades from moving the book | [`DustManipulation.t.sol`](./contracts/test/DustManipulation.t.sol) |
| **Resolution timing** | `resolve()` reverts until the full observation window has elapsed (`observationEnd`), independent of resolver-key discipline | [`ObservationResolve.t.sol`](./contracts/test/ObservationResolve.t.sol) |
| **Share pricing** | Vault prices shares off an internal ledger (`internalAssets`), not token balance — direct transfers cannot inflate share value | [`DonationAttack.t.sol`](./contracts/test/DonationAttack.t.sol) |
| **Reserve accounting** | Every payout, loss and refund reconciles reserved + locked balances | [`ReserveAccounting.t.sol`](./contracts/test/ReserveAccounting.t.sol) |
| **Settlement** | Win / loss / cancel / batch paths, plus fee routing | [`Settlement.t.sol`](./contracts/test/Settlement.t.sol) |
| **Exposure caps** | Per-market, per-outcome and per-user reserve caps; market-level solvency check before accepting | [`Fixes.t.sol`](./contracts/test/Fixes.t.sol) |

Batch settlement isolates failures: `settleBatch()` settles each ticket through an external
self-call so one bad ticket cannot revert the batch.

---

## Features

- **On-chain engine** — factory, reserve engine, LP vault, position tickets on Arc Testnet
- **Micro Boost** — payout multiplier gated by live LP capacity
- **LP vault** — deposit / withdraw underwriting liquidity, on Arc or **from any chain**
- **Live feeds** — BTC (Coinbase) & London temp (Open-Meteo), auto-resolve
- **Circle Wallets** — email → Developer-Controlled EOA on Arc (fallback: local session EOA)
- **App Kits** — Send, Bridge and Unified Balance via `@circle-fin/app-kit`
- **CCTP** — USDC from Base Sepolia / Eth Sepolia → Arc
- **Durable wallet mapping** — email → walletId in Redis KV; recovery via Circle `listWallets(refId)`, no duplicate wallets after logout
- **Email OTP** — app-issued 6-digit code via SMTP (dev-echo locally)
- **Tx tracking** — position / claim / deposit / send tracked `pending → confirmed / failed`, reconciled server-side
- **Dual path** — email session or MetaMask throughout

---

## Architecture

```text
┌─────────────┐     ┌──────────────────────┐     ┌─────────────────────────┐
│  Next.js UI │────▶│  Next API routes     │────▶│  Arc Testnet            │
│  (Vercel)   │     │  apps/web/src/app/api│     │  Engine · Vault · Mkts  │
└──────┬──────┘     │  (+ optional apps/api│     └───────────┬─────────────┘
       │            │   standalone :3001)  │                 │
       │            └──────┬───────────────┘                 │ USDC
       │                   │                                 │
       │            ┌──────▼───────┐                 ┌───────▼───────┐
       └───────────▶│ Circle API   │                 │ App Kit       │
         email EOA  │ Wallets      │                 │ Send · Bridge │
                    └──────────────┘                 │ Unified Bal.  │
                                                     └───────────────┘
```

| Package | Role |
|---------|------|
| `apps/web` | Markets, portfolio, LP, admin, fund UI + **API route handlers** |
| `apps/api` | Shared services (quotes, Circle, App Kit, CCTP, workers); optional standalone server on `:3001` |
| `contracts` | Foundry sources + [tests](./contracts/test/) |
| `scripts/` | `deploy-arc`, smoke, demo markets, RPC preflight |

---

## Quick start

```bash
pnpm install
cp .env.example .env   # fill keys — never commit .env

# Recommended (UI + API in one Next process, port 3000):
pnpm dev:web

# Optional: standalone API on :3001 (set NEXT_PUBLIC_API_BASE_URL=http://localhost:3001)
pnpm dev:api
```

Leave `NEXT_PUBLIC_API_BASE_URL` empty to call same-origin `/api/*` (default for Vercel and local Next).

```bash
pnpm contracts:build
pnpm contracts:test      # 21 forge tests → contracts/test/
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

### Core contracts

| Contract | Address |
|----------|---------|
| MicroBoostEngine | [`0x94Bd455DB31ddA0AFA13C8dF0E25D5ef4b787581`](https://testnet.arcscan.app/address/0x94Bd455DB31ddA0AFA13C8dF0E25D5ef4b787581) |
| LiquidityPool | [`0x647cCdDB471A22651e5e764f000f6a0cf232cacd`](https://testnet.arcscan.app/address/0x647cCdDB471A22651e5e764f000f6a0cf232cacd) |
| MarketFactory | [`0x5FE8988706f7E1654968D77c920C19c48C1Ec2f8`](https://testnet.arcscan.app/address/0x5FE8988706f7E1654968D77c920C19c48C1Ec2f8) |
| PositionTicket | [`0x676a25D09c1BB7421AB3a837c554D447f7dA4894`](https://testnet.arcscan.app/address/0x676a25D09c1BB7421AB3a837c554D447f7dA4894) |
| OracleAdapter | [`0x24CC0e29B4cc678aDe4f866a9808F582BD4f6A17`](https://testnet.arcscan.app/address/0x24CC0e29B4cc678aDe4f866a9808F582BD4f6A17) |
| InsuranceFund | [`0x93D0f707730D85bf584E4C8DF2bA22aE90A24E68`](https://testnet.arcscan.app/address/0x93D0f707730D85bf584E4C8DF2bA22aE90A24E68) |
| FeeRouter | [`0x57121e3f572708b6B6ea7D149019e99974ce2b72`](https://testnet.arcscan.app/address/0x57121e3f572708b6B6ea7D149019e99974ce2b72) |

Deployed **2026-07-25**. LP seed: **400 USDC**. Full JSON: [`docs/DEPLOYMENT_ARC_TESTNET.json`](docs/DEPLOYMENT_ARC_TESTNET.json) (mirrors `apps/web/src/lib/deployment.json`).

---

## Circle, CCTP & App Kits

| Capability | Implementation |
|------------|----------------|
| Email login | Circle **Developer-Controlled** wallets on `ARC-TESTNET` |
| Fallback | Local encrypted session EOA if `CIRCLE_*` incomplete |
| OTP | App-issued 6-digit code (SMTP in prod; `EMAIL_OTP_DEV_ECHO=1` shows code in UI locally) |
| **Send** | App Kit `kit.send` on Arc; Circle DCW transfer via `tokenId`; raw viem fallback |
| **Bridge** | App Kit `kit.bridge` (CCTP v2 underneath); manual CCTP Forwarding fallback |
| **LP liquidity** | On-Arc vault deposit, plus **Any chain** tab — Unified Balance where available, else App Kit bridge → deposit |
| Gas | User pays **USDC** on Arc |

Packages: `@circle-fin/app-kit`, `@circle-fin/adapter-viem-v2`.

MetaMask can burn on the source chain while the mint lands on the email session — separate
connect, no session hijack.

**Server-only env:**

```text
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=          # 64-char hex; save recovery_file_*.dat when registering
CIRCLE_WALLET_SET_ID=
CIRCLE_KIT_KEY=                # Circle Console → kit key (optional for basic send)
CCTP_SOURCE_PRIVATE_KEY=       # optional server fund treasury
```

Entity secret is per **Circle account** (not per API key). Without `recovery_file_*.dat`
you cannot reset a lost secret.

---

## Email OTP (SMTP)

Production mail is sent from the app (not Circle). With Gmail, prefer an **App Password**:

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
    → Fund USDC (direct on Arc, App Kit bridge, or receive a Send)
    → Optional: LP deposit (on Arc, or from any chain)
    → Take YES/NO position (+ boost if vault allows)   [tx: pending → confirmed]
    → Wait lock + observation (live chart vs start line)
    → Auto/manual resolve → settle / claim
    → Send USDC out to any Arc address anytime
```

**Admin:** `/admin` — create test markets (BTC / London weather). No UI entry point; open
the URL directly. Resolver tools under *Advanced*.

> ⚠️ **`ADMIN_SECRET` is not optional in a shared deploy.** With it unset, the admin endpoints (create / hide / reset / settle / resolve / cancel / simulate) stay **open** — deliberate local-dev convenience, logged with a loud warning at startup. Set it (or `CRON_SECRET`, used as fallback) on Vercel.

---

## Deploy (Vercel — UI + API together)

API lives as Next.js route handlers under `apps/web/src/app/api/**`; no separate API host required.

| Setting | Value |
|---------|--------|
| Framework | Next.js |
| Root Directory | **`apps/web`** (uses `apps/web/vercel.json`) |
| Install | `npm install -g pnpm@9.12.3 && pnpm install` |
| Build | `pnpm --filter @probx/web build` |

### Environment variables

**Public**

```text
NEXT_PUBLIC_API_BASE_URL=
NEXT_PUBLIC_CHAIN_ID=5042002
NEXT_PUBLIC_ARC_RPC_URL=https://rpc.testnet.arc.network
NEXT_PUBLIC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS=0x94Bd455DB31ddA0AFA13C8dF0E25D5ef4b787581
NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS=0x647cCdDB471A22651e5e764f000f6a0cf232cacd
NEXT_PUBLIC_MARKET_FACTORY_ADDRESS=0x5FE8988706f7E1654968D77c920C19c48C1Ec2f8
NEXT_PUBLIC_CIRCLE_KIT_KEY=
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
CIRCLE_KIT_KEY=
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
SESSION_HMAC_SECRET=           # REQUIRED on any shared deploy — signs session tokens
MARKET_CYCLE_ENABLED=1
MARKET_CYCLE_ON_TRAFFIC=1      # background cycle on site traffic (0 = off)
RPC_BATCH=1                    # JSON-RPC batching (0 = plain per-call requests)
CRON_THROTTLE_MS=30000         # min gap between anonymous cron/cycle runs (min 5000)
CORS_ORIGINS=                  # standalone API only; default *
CCTP_DEMO_MAX_PER_CALL=10      # demo treasury cap, USDC per call
CCTP_DEMO_DAILY_PER_ADDRESS=25 # demo treasury cap, USDC per address per day
UPSTASH_REDIS_REST_URL=        # durable wallet map + tx statuses (free tier ok)
UPSTASH_REDIS_REST_TOKEN=      # KV_REST_API_URL / KV_REST_API_TOKEN also accepted
```

> **`SESSION_HMAC_SECRET` unset** → tokens are signed with a random per-instance key that
> does not survive cold starts, so users get logged out mid-session on Vercel. The server
> warns loudly rather than falling back to a key committed to this repo.

> **Without the KV vars** the email → wallet mapping and tx statuses fall back to
> per-instance `/tmp` files — fine locally, ephemeral on Vercel. Set Upstash (free) for
> production reliability.

### Markets 24/7

The market cycle (create → observe → resolve) needs a trigger about **once per minute**.
Vercel Hobby cron fires ~once a day, so:

1. **External pinger (recommended):** hit `GET /api/cron/market-cycle?secret=CRON_SECRET` every minute — free on cron-job.org. Guide: [`docs/EXTERNAL_CRON.md`](docs/EXTERNAL_CRON.md).
   *Note:* `market-cycle` is intentionally callable **without** a secret (the browser heartbeat drives it); passing `CRON_SECRET` **bypasses the throttle** rather than granting access. `auto-resolve` does require the secret when one is configured.
2. **On-traffic fallback (built-in):** while anyone has the site open, the cycle self-runs in the background (throttled 50s across instances via KV).
3. **GitHub Actions backup:** [`.github/workflows/cron-ping.yml`](.github/workflows/cron-ping.yml) pings both endpoints. Set `PROBX_CRON_BASE_URL` + `PROBX_CRON_SECRET` as repo secrets. GitHub's scheduler floors at ~5 min and slips under load — treat it as a safety net, not the primary driver.

---

## Scope

Testnet deployment built for a hackathon. Deliberate scope choices:

- **Custodial by design.** Email login means the server holds the signing key (Circle Developer-Controlled wallet, or a locally encrypted session EOA in fallback). That is the Circle Wallets integration, not self-custody. MetaMask users hold their own keys throughout.
- **Demo-sized risk parameters.** 400 USDC seeded vault with deliberately loose exposure caps (`MAX_LP_RESERVE_PER_USER_BPS = 8000` — one address can reserve 80% of TVL). Sized so a single demo session can exercise the full boost range, not for production underwriting.
- **Two oracle sources.** Coinbase spot and Open-Meteo, both with fallback hosts. Production would want redundant independent feeds with attestation.

---

## Docs

- Deployment addresses: [`docs/DEPLOYMENT_ARC_TESTNET.json`](docs/DEPLOYMENT_ARC_TESTNET.json)
- Env template: [`.env.example`](.env.example)
- External cron pinger: [`docs/EXTERNAL_CRON.md`](docs/EXTERNAL_CRON.md)
- Contract tests: [`contracts/test/`](./contracts/test/) — 21 tests, `pnpm contracts:test`
- License: [`LICENSE`](./LICENSE) (MIT)

---

<p align="center">
  <sub>Built for Arc · Programmable money · USDC all the way down</sub>
</p>
