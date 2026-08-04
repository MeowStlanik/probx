# ProbX — Vercel UI + Railway API

Production is split into two deployments:

- **Vercel:** `apps/web` UI only. All browser and SSR API calls use the Railway origin.
- **Railway:** lightweight `apps/api` Node server plus persistent market workers.
- **Gmail API:** email OTP over HTTPS; SMTP ports are not used.

`railway.json` intentionally builds and starts only `@probx/api`. Do not replace its start command with the root `pnpm start`, because that starts the full Next server and uses more memory.

## Vercel variables

```dotenv
NEXT_PUBLIC_API_BASE_URL=https://your-api.up.railway.app
NEXT_PUBLIC_SITE_URL=https://your-ui.vercel.app
# Browser reads use the public Arc RPC instead of consuming the private dRPC project.
NEXT_PUBLIC_ARC_RPC_URL=https://rpc.testnet.arc.network
NEXT_PUBLIC_ARC_RPC_URLS=
BACKGROUND_WORKERS_ENABLED=0
```

Redeploy Vercel after changing `NEXT_PUBLIC_*`; those values are embedded at build time.

## Railway variables

```dotenv
NODE_ENV=production
HOST=0.0.0.0
SITE_URL=https://your-ui.vercel.app
CORS_ORIGINS=https://your-ui.vercel.app
BACKGROUND_WORKERS_ENABLED=1

ARC_RPC_URL=https://your-private-or-drpc-endpoint
ARC_RPC_URLS=
RPC_ENABLE_PUBLIC_FALLBACK=0
ARC_FROM_BLOCK=53938140
ORACLE_PRIVATE_KEY=

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

ADMIN_SECRET=
CRON_SECRET=
OTP_HMAC_SECRET=
SESSION_HMAC_SECRET=
SESSION_WALLET_SECRET=
```

Add the Circle and Gmail values from `.env.example` when those flows are enabled.

## Low-cost worker configuration

```dotenv
MARKET_CYCLE_ENABLED=1
MARKET_CYCLE_INTERVAL_MS=30000

ORACLE_SNAPSHOT_ENABLED=1
ORACLE_SNAPSHOT_INTERVAL_MS=7000

# The market cycle already resolves and settles. A second resolver loop only duplicates RPC.
AUTO_RESOLVE_ENABLED=0

# Shared dRPC cache and bounded log scans.
RPC_MARKET_CACHE_MS=300000
RPC_PUBLIC_MARKET_CACHE_MS=60000
RPC_TICKET_CACHE_MS=60000
ARC_MARKET_LIST_LIMIT=18
ARC_MARKET_STATS_SCAN_BLOCKS=8000
AGGREGATE_STATS_FRESH_MS=600000
RPC_BATCH=1
RPC_BATCH_SIZE=3
```

The 7-second snapshot timer does not reread all contracts. It uses the shared five-minute schedule cache and fetches BTC/weather only near an active market's start or end boundary. The 30-second market cycle creates the next round, resolves finished rounds and settles tickets.

Keep **one Railway replica**, disable sleeping/serverless mode, and do not configure an external cron as the primary scheduler. The protected endpoints remain available for emergency recovery:

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

4. Add to Railway:

```dotenv
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_OAUTH_REFRESH_TOKEN=
GMAIL_SENDER_EMAIL=you@gmail.com
GMAIL_SENDER_NAME=ProbX Arc
EMAIL_OTP_DEV_ECHO=0
EMAIL_OTP_REQUIRED=1
```

## Verification

After deployment:

```bash
curl https://your-api.up.railway.app/api/health
```

Expected worker state:

```json
{
  "ok": true,
  "workers": {
    "enabled": true,
    "marketCycle": { "started": true, "intervalMs": 30000 },
    "oracleSnapshot": { "started": true, "intervalMs": 7000 },
    "autoResolve": { "started": false }
  }
}
```

Railway logs should include:

```text
ProbX Arc API listening on http://0.0.0.0:<PORT>
[workers] starting persistent Railway workers
[oracle-snapshot] worker started (every 7000ms)
[market-cycle] background timer every 30000ms
```

See `docs/RPC_BUDGET.md` for the request budget and Railway cost controls.
