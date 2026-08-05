# ProbX — full-stack Railway deployment

The checked-in `railway.json` deploys **one persistent Railway service** containing:

- the Next.js UI from `apps/web`;
- same-origin `/api/*` route handlers backed by `apps/api`;
- persistent market-cycle and oracle-snapshot workers started by Next.js instrumentation;
- Gmail API OTP, Circle, CCTP and Valkey integrations.

This is the canonical deployment shape for this archive. A split Vercel UI / standalone
Railway API is possible, but it requires a different Railway build/start configuration and
is not what the checked-in `railway.json` does.

## Local run

```bash
corepack enable
pnpm install
cp .env.example .env.local
pnpm dev
```

The local Next.js process serves the UI and same-origin API. Background workers remain
opt-in through `BACKGROUND_WORKERS_ENABLED`.

## Railway

1. Create a Railway project and deploy this repository from its root.
2. Add the variables from `.env.railway.fullstack.example`.
3. Generate a public domain for the service.
4. Set both `NEXT_PUBLIC_SITE_URL` and `SITE_URL` to that domain.
5. Keep `NEXT_PUBLIC_API_BASE_URL` empty so browser calls remain same-origin.
6. Redeploy after changing a `NEXT_PUBLIC_*` value because Next.js embeds it at build time.

The checked-in configuration is:

```text
Build:  pnpm --filter @probx/web build
Start:  pnpm --filter @probx/web start
Health: /api/health
```

## Core Railway variables

```dotenv
NODE_ENV=production
HOST=0.0.0.0

NEXT_PUBLIC_SITE_URL=https://your-app.up.railway.app
SITE_URL=https://your-app.up.railway.app
NEXT_PUBLIC_API_BASE_URL=
CORS_ORIGINS=https://your-app.up.railway.app

BACKGROUND_WORKERS_ENABLED=1

ARC_RPC_URL=https://your-private-or-drpc-endpoint
ARC_RPC_URLS=
RPC_ENABLE_PUBLIC_FALLBACK=0
ARC_FROM_BLOCK=53938140
ORACLE_PRIVATE_KEY=

# TLS URI from the Valkey provider.
AIVEN_VALKEY_URL=rediss://...

ADMIN_SECRET=
CRON_SECRET=
OTP_HMAC_SECRET=
SESSION_HMAC_SECRET=
SESSION_WALLET_SECRET=
```

Add the Circle, Gmail and CCTP values from `.env.railway.fullstack.example` when those
flows are enabled.

## Worker configuration

```dotenv
MARKET_CYCLE_ENABLED=1
MARKET_CYCLE_INTERVAL_MS=30000

ORACLE_SNAPSHOT_ENABLED=1
ORACLE_SNAPSHOT_INTERVAL_MS=7000

# Market-cycle already resolves and settles. Do not run a duplicate resolver in the
# same process unless you are deliberately testing recovery behaviour.
AUTO_RESOLVE_ENABLED=0

RPC_MARKET_CACHE_MS=300000
RPC_PUBLIC_MARKET_CACHE_MS=60000
RPC_TICKET_CACHE_MS=60000
ARC_MARKET_LIST_LIMIT=18
ARC_MARKET_STATS_SCAN_BLOCKS=8000
AGGREGATE_STATS_FRESH_MS=600000
RPC_BATCH=1
RPC_BATCH_SIZE=3
```

The snapshot timer uses cached market schedules and fetches feeds only near active start
or end boundaries. BTC reference markets observe for 60 seconds. London weather markets
observe for 30 minutes because Open-Meteo publishes on a 15-minute grid and the resolver
needs distinct start and end prints.

Keep **one Railway replica**, disable sleeping/serverless mode, and do not use an external
cron as the primary scheduler. Protected endpoints remain available for recovery:

```text
GET /api/cron/market-cycle?secret=CRON_SECRET
GET /api/cron/auto-resolve?secret=CRON_SECRET
GET /api/cron/market-cycle/status
```

## Gmail API OAuth

1. Enable Gmail API in Google Cloud.
2. Configure the OAuth consent screen and create a **Desktop app** OAuth client.
3. Generate a refresh token locally:

```bash
GMAIL_OAUTH_CLIENT_ID='...' \
GMAIL_OAUTH_CLIENT_SECRET='...' \
pnpm gmail:oauth
```

4. Add the values to Railway:

```dotenv
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REFRESH_TOKEN=
GMAIL_SENDER_EMAIL=you@gmail.com
GMAIL_SENDER_NAME=ProbX Arc
EMAIL_OTP_DEV_ECHO=0
EMAIL_OTP_REQUIRED=1
```

`EMAIL_OTP_DEV_ECHO=1` is a local-development aid. The API refuses to return the code when
`NODE_ENV=production`, even if the flag is accidentally enabled.

## Verification

After deployment:

```bash
curl https://your-app.up.railway.app/api/health
```

Expected worker state:

```json
{
  "ok": true,
  "workers": {
    "enabled": true,
    "marketCycle": { "started": true },
    "oracleSnapshot": { "started": true },
    "autoResolve": { "started": false }
  }
}
```

Railway logs should include Next.js startup plus:

```text
[workers] starting persistent Railway workers
[oracle-snapshot] worker started
[market-cycle] background timer
```

See `docs/AIVEN_VALKEY_MIGRATION.md` for the Valkey cutover/rollback runbook and
`docs/RPC_BUDGET.md` for request-budget guidance.
