<h1 align="center">ProbX Arc</h1>

<p align="center">
  <strong>USDC-native short prediction markets on Arc</strong><br/>
  Locked YES/NO tickets · LP-backed Micro Boost · Circle Wallets · CCTP
</p>

<p align="center">
  <strong><a href="https://probx-web.vercel.app">▶ Live demo</a></strong> ·
  <a href="#see-it-in-2-minutes">See it in 2 minutes</a> ·
  <a href="#known-limitations">Known limitations</a>
</p>

<p align="center">
  <img src="apps/web/public/assets/probx-arc-visuals.png" alt="ProbX Arc" width="820" />
</p>

<p align="center">
  <a href="https://testnet.arcscan.app"><img src="https://img.shields.io/badge/Network-Arc%20Testnet-7C5CFF?style=flat-square" alt="Arc Testnet" /></a>
  <a href="#arc-testnet"><img src="https://img.shields.io/badge/Gas-USDC%20native-2775CA?style=flat-square" alt="USDC gas" /></a>
  <a href="#circle--cctp"><img src="https://img.shields.io/badge/Circle-Wallets%20%2B%20CCTP-6B46C1?style=flat-square" alt="Circle" /></a>
  <img src="https://img.shields.io/badge/License-MIT-22C55E?style=flat-square" alt="MIT" />
</p>

---

## See it in 2 minutes

1. Open the [live demo](https://probx-web.vercel.app) → **Markets**. A BTC and a London-temp market are always running on a ~75s entry / 60s observation cycle.
2. Sign in with email (Circle Developer-Controlled wallet on Arc) or MetaMask.
3. Fund with testnet USDC — direct on Arc, or bridge from Base Sepolia via CCTP.
4. Buy a YES/NO ticket, optionally with Micro Boost. Watch the live chart against the start line, then claim after auto-resolve.

Gas is paid in USDC — there is no ETH step anywhere in that flow.

> Markets are driven by an **external** minute pinger (see [Markets 24/7](#markets-247)). If the list looks empty, the pinger is down, not the app — any page load also kicks the cycle in the background.

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

### 3. Timing: hard entry cutoff + lock pause
Entry never runs up to the observation window:

```text
open ──► lock ──► pause (10s) ──► observation ──► resolve
```

- **Hard cutoff (on-chain):** `MicroMarket.canBuy()` requires `block.timestamp < lockTime`, so buys stop at `lockTime` whether or not anyone has called `lock()` yet.
- **Lock pause — the guard that actually matters:** `observationStart = lockTime + pause`, default **10s** (`MARKET_LOCK_PAUSE_SECONDS`). No trade can land within 10s of the observation window opening, so nobody enters against a print they already know.
- **Sniper buffer:** `MARKET_SNIPER_BUFFER_SECONDS` (default **5s**) trims the entry window, but `MARKET_CREATE_TX_SLACK_SECONDS` (default **18s**) pads it to absorb create+open tx latency. Net for a nominal 75s window: `lockTime ≈ open + 88s`, and since a new market only appears in the UI ~10–20s after creation, the *visible* entry window is ~60–75s.

### 4. Seed odds from the feed, not flat 50/50
New BTC / weather markets estimate a **fair mid** from live structure before applying overround:

- **BTC (1-minute up/down):** near 50% with a small tilt from recent return (random-walk prior).
- **London temp ≥ now:** modest YES edge (temperature is sticky over 60s).

That cuts the free lunch for anyone who would otherwise only buy mispriced 50/50 tickets.

> These guards address **informed flow**, not **quote manipulation** — the current bytecode lets a quote be moved cheaply before entry. See [Known limitations](#known-limitations).

> **Deploy note:** overround + higher boost fee live in **contract bytecode**. Redeploy after changing those constants. Current Arc Testnet deployment: **2026-07-19** (see addresses below).

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
pnpm contracts:test      # 19 forge tests → contracts/test/
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

### Core contracts (redeployed 2026-07-25 — self-audit fixes)

| Contract | Address |
|----------|---------|
| MicroBoostEngine | [`0x94Bd455DB31ddA0AFA13C8dF0E25D5ef4b787581`](https://testnet.arcscan.app/address/0x94Bd455DB31ddA0AFA13C8dF0E25D5ef4b787581) |
| LiquidityPool | [`0x647cCdDB471A22651e5e764f000f6a0cf232cacd`](https://testnet.arcscan.app/address/0x647cCdDB471A22651e5e764f000f6a0cf232cacd) |
| MarketFactory | [`0x5FE8988706f7E1654968D77c920C19c48C1Ec2f8`](https://testnet.arcscan.app/address/0x5FE8988706f7E1654968D77c920C19c48C1Ec2f8) |
| PositionTicket | [`0x676a25D09c1BB7421AB3a837c554D447f7dA4894`](https://testnet.arcscan.app/address/0x676a25D09c1BB7421AB3a837c554D447f7dA4894) |
| OracleAdapter | [`0x24CC0e29B4cc678aDe4f866a9808F582BD4f6A17`](https://testnet.arcscan.app/address/0x24CC0e29B4cc678aDe4f866a9808F582BD4f6A17) |
| InsuranceFund | [`0x93D0f707730D85bf584E4C8DF2bA22aE90A24E68`](https://testnet.arcscan.app/address/0x93D0f707730D85bf584E4C8DF2bA22aE90A24E68) |
| FeeRouter | [`0x57121e3f572708b6B6ea7D149019e99974ce2b72`](https://testnet.arcscan.app/address/0x57121e3f572708b6B6ea7D149019e99974ce2b72) |

LP seed on deploy: **400 USDC**. Full JSON: [`docs/DEPLOYMENT_ARC_TESTNET.json`](docs/DEPLOYMENT_ARC_TESTNET.json).


LP seed on deploy: **400 USDC**.


---

## Circle, CCTP & App Kits

| Capability | Implementation |
|------------|----------------|
| Email login | Circle **Developer-Controlled** wallets on `ARC-TESTNET` |
| Fallback | Local encrypted session EOA if `CIRCLE_*` incomplete |
| OTP | App-issued 6-digit code (Gmail SMTP in prod; `EMAIL_OTP_DEV_ECHO=1` shows code in UI locally) |
| **Send** | Circle **App Kit** `kit.send` on Arc (session EOA); Circle DCW transfer via `tokenId`; raw viem fallback |
| **Bridge** | **App Kit** `kit.bridge` primary (Fund modal); manual CCTP v2 Forwarding fallback |
| **LP liquidity** | On-Arc vault deposit + **Any chain** tab (Unified Balance when available, else App Kit bridge → deposit) |
| Gas | User pays **USDC** on Arc |

Optional: `CIRCLE_KIT_KEY` / `NEXT_PUBLIC_CIRCLE_KIT_KEY` from Circle Console for authenticated kit features.

**Judge visibility:** successful App Kit flows message as `⚡ via Circle App Kit`. If App Kit fails, the UI/API **names the fallback** (`viem-fallback` / “manual CCTP”) — never silent. Set `APP_KIT_STRICT=1` / `NEXT_PUBLIC_APP_KIT_STRICT=1` to hard-fail instead of falling back.

**Release zip (no secrets):**
```bash
git add -A && git commit -m "…"   # local commit of what you want packed
pnpm pack:release                 # git archive → ../probx-release-*.zip
```
Never zip the working directory by hand — `.secrets/` and `.env` must not leave the machine.

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

**Admin:** `/admin` — create test markets (BTC / London weather). No UI entry point (header/footer links removed) — open the URL directly. Resolver tools under *Advanced*.

> ⚠️ **`ADMIN_SECRET` is not optional in a shared deploy.** With it unset, the admin endpoints (create / hide / reset / settle / resolve / cancel / simulate) stay **open** to anyone — that is deliberate local-dev convenience, logged with a loud warning at startup. Set it (or `CRON_SECRET`, used as fallback) on Vercel.

---

## Deploy (Vercel — UI + API together)

API lives as Next.js route handlers under `apps/web/src/app/api/**` (no separate API host required).

| Setting | Value |
|---------|--------|
| Framework | Next.js |
| Root Directory | **`apps/web`** (uses `apps/web/vercel.json`) |
| Install | `npm install -g pnpm@9.12.3 && pnpm install` |
| Build | `pnpm --filter @probx/web build` |

### Environment variables on Vercel

**Public**

```text
NEXT_PUBLIC_API_BASE_URL=
NEXT_PUBLIC_CHAIN_ID=5042002
NEXT_PUBLIC_ARC_RPC_URL=https://rpc.testnet.arc.network
NEXT_PUBLIC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS=0x94Bd455DB31ddA0AFA13C8dF0E25D5ef4b787581
NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS=0x647cCdDB471A22651e5e764f000f6a0cf232cacd
NEXT_PUBLIC_MARKET_FACTORY_ADDRESS=0x5FE8988706f7E1654968D77c920C19c48C1Ec2f8
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
SESSION_HMAC_SECRET=           # REQUIRED on any shared deploy — signs session tokens
CRON_THROTTLE_MS=30000         # min gap between anonymous cron/cycle runs (min 5000)
CORS_ORIGINS=                  # standalone API only; default *
CCTP_DEMO_MAX_PER_CALL=10      # demo treasury cap, USDC per call
CCTP_DEMO_DAILY_PER_ADDRESS=25 # demo treasury cap, USDC per address per day
UPSTASH_REDIS_REST_URL=        # durable wallet map + tx statuses (free tier ok)
UPSTASH_REDIS_REST_TOKEN=      # KV_REST_API_URL / KV_REST_API_TOKEN also accepted
```

> **`SESSION_HMAC_SECRET` unset** → tokens are signed with a random per-instance key
> that does not survive cold starts, so users get logged out mid-session on Vercel.
> The server warns loudly rather than falling back to a key committed to this repo.

> **Without the KV vars** the email → wallet mapping and tx statuses fall back
> to per-instance `/tmp` files — fine locally, ephemeral on Vercel. Set Upstash
> (free) for production reliability.

### Markets 24/7

The BTC / weather cycle (create → observe → resolve) needs a trigger about
**once per minute**. Vercel Hobby cron fires ~once a day, so:

1. **External pinger (recommended):** hit `GET /api/cron/market-cycle?secret=CRON_SECRET` every minute — free on cron-job.org. Full guide: [`docs/EXTERNAL_CRON.md`](docs/EXTERNAL_CRON.md).
   *Note:* `market-cycle` is intentionally callable **without** a secret (the browser heartbeat below drives it); passing `CRON_SECRET` **bypasses the throttle** rather than granting access. `auto-resolve` does require the secret when one is configured.
2. **On-traffic fallback (built-in):** while anyone has the site open, the cycle self-runs in the background (throttled 50s across instances via KV). Zero traffic → falls back to the daily cron only.
3. **GitHub Actions backup:** [`.github/workflows/cron-ping.yml`](.github/workflows/cron-ping.yml) pings both endpoints. Set `PROBX_CRON_BASE_URL` + `PROBX_CRON_SECRET` as repo secrets. GitHub's scheduler floors at ~5 min and slips under load, so treat this as a safety net, not the primary driver.

---

## Known limitations

Testnet demo built for a hackathon. Two categories — deliberate scope choices, and real bugs found during a self-audit that need a redeploy to land.

### By design

- **Custodial.** Email login means the server holds the signing key (Circle Developer-Controlled wallet, or a locally encrypted session EOA in fallback). That is the Circle integration, not self-custody.
- **Testnet only**, with a 15 USDC seeded vault and deliberately loose exposure caps (`MAX_LP_RESERVE_PER_USER_BPS = 8000` — one address can reserve 80% of TVL). Sized for a demo, not for underwriting.

### Self-audit: found and fixed

These issues were found in a self-audit, fixed on-chain, and covered by regression tests (`pnpm contracts:test` — **21** green).

| Bug | Fix | Test |
|-----|-----|------|
| **Dust quote manipulation** — `MIN_IMPACT` floor moved price for any non-zero stake | `MIN_USER_RISK_PER_TICKET = 0.25 USDC` (`MIN_RISK`); impact is proportional (no floor) | [`DustManipulation.t.sol`](./contracts/test/DustManipulation.t.sol) `test_19` |
| **`resolve()` before observation end** | `require(block.timestamp >= observationEnd)` | [`ObservationResolve.t.sol`](./contracts/test/ObservationResolve.t.sol) `test_20` |
| **LP donation / ERC-4626 share inflation** | `internalAssets` ledger; share price ignores raw balance | [`DonationAttack.t.sol`](./contracts/test/DonationAttack.t.sol) `test_21` |

---

## Docs

- Deployment addresses: [`docs/DEPLOYMENT_ARC_TESTNET.json`](docs/DEPLOYMENT_ARC_TESTNET.json)
- Env template: [`.env.example`](.env.example)
- External cron pinger (markets 24/7): [`docs/EXTERNAL_CRON.md`](docs/EXTERNAL_CRON.md)
- Contract tests: [`contracts/test/`](./contracts/test/) — 21 tests, `pnpm contracts:test`
- License: [`LICENSE`](./LICENSE) (MIT)

---

<p align="center">
  <sub>Built for Arc · Programmable money · USDC all the way down</sub>
</p>
