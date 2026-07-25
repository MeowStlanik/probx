# ProbX — local run, Vercel deploy, email OTP

Operational docs (not needed for judging). Live demo: **https://probx-web.vercel.app**

Contract addresses and vault seed: [`DEPLOYMENT_ARC_TESTNET.json`](./DEPLOYMENT_ARC_TESTNET.json).

---

## Quick start (local)

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

Env template: [`.env.example`](../.env.example)

---

## Deploy (Vercel — UI + API together)

API lives as Next.js route handlers under `apps/web/src/app/api/**`; no separate API host required.

| Setting | Value |
|---------|--------|
| Framework | Next.js |
| Root Directory | **`apps/web`** (uses `apps/web/vercel.json`) |
| Install | `npm install -g pnpm@9.12.3 && pnpm install` |
| Build | `pnpm --filter @probx/web build` |
| Output Directory | *(leave empty)* |

After a contract redeploy, update public addresses + `ARC_FROM_BLOCK`. Checklist: [`VERCEL_ENV_UPDATE.md`](./VERCEL_ENV_UPDATE.md).

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
ARC_FROM_BLOCK=53536935
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
APP_KIT_STRICT=0               # 1 = hard-fail instead of App Kit → viem/CCTP fallback
```

> **`SESSION_HMAC_SECRET` unset** → tokens are signed with a random per-instance key that
> does not survive cold starts, so users get logged out mid-session on Vercel. The server
> warns loudly rather than falling back to a key committed to this repo.

> **Without the KV vars** the email → wallet mapping and tx statuses fall back to
> per-instance `/tmp` files — fine locally, ephemeral on Vercel. Set Upstash (free) for
> production reliability.

> ⚠️ **`ADMIN_SECRET` is required on Vercel / production.** With it unset on a shared runtime, admin endpoints **fail closed** (403). Locally (no `VERCEL`, non-production) they stay open with a loud warning for convenience. Same rule: **`OTP_HMAC_SECRET` is required on Vercel** — the public dev fallback is rejected.

---

## Markets 24/7 (cron)

The market cycle (create → observe → resolve) needs a trigger about **once per minute**.
Vercel Hobby cron fires ~once a day, so:

1. **External pinger (recommended):** hit `GET /api/cron/market-cycle?secret=CRON_SECRET` every minute — free on cron-job.org. Guide: [`EXTERNAL_CRON.md`](./EXTERNAL_CRON.md).
   *Note:* `market-cycle` is intentionally callable **without** a secret (the browser heartbeat drives it); passing `CRON_SECRET` **bypasses the throttle** rather than granting access. `auto-resolve` does require the secret when one is configured.
2. **On-traffic fallback (built-in):** while anyone has the site open, the cycle self-runs in the background (throttled 50s across instances via KV). Prefer `MARKET_CYCLE_ON_TRAFFIC=0` on free tier if you have a reliable external pinger.
3. **GitHub Actions backup:** [`.github/workflows/cron-ping.yml`](../.github/workflows/cron-ping.yml) pings both endpoints. Set `PROBX_CRON_BASE_URL` + `PROBX_CRON_SECRET` as repo secrets. GitHub's scheduler floors at ~5 min and slips under load — treat it as a safety net, not the primary driver.

---

## Email OTP (Gmail SMTP)

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

## Circle env (server)

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

## Release zip (no secrets)

```bash
git add -A && git commit -m "…"
pnpm pack:release    # git archive only — never zip the working tree by hand
```

---

## Related

- Addresses: [`DEPLOYMENT_ARC_TESTNET.json`](./DEPLOYMENT_ARC_TESTNET.json)
- Vercel address bump: [`VERCEL_ENV_UPDATE.md`](./VERCEL_ENV_UPDATE.md)
- External cron: [`EXTERNAL_CRON.md`](./EXTERNAL_CRON.md)
