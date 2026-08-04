# ProbX fullstack deployment on Railway

This archive deploys the Next.js UI, API routes, and persistent workers as one Railway service.

## GitHub

Repository: `meowstlanik/probx`

Recommended commit title:

```text
Deploy fullstack ProbX on Railway with Gmail API and RPC-efficient workers
```

Recommended GitHub repository description:

```text
Fullstack decentralized prediction-market demo on Arc Testnet with Next.js, Circle wallets, Gmail API OTP, Railway background workers, and RPC-efficient on-chain settlement.
```

From the extracted `probx-main` directory:

```bash
git init
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/meowstlanik/probx.git
git add .
git commit -m "Deploy fullstack ProbX on Railway with Gmail API and RPC-efficient workers"
git push -u origin main
```

If the remote repository already contains unrelated history and you intentionally want this archive to replace `main`:

```bash
git push -u origin main --force-with-lease
```

Use `--force-with-lease`, not plain `--force`.

## Railway

1. Create a Railway project.
2. Choose **Deploy from GitHub repo**.
3. Select `meowstlanik/probx` and branch `main`.
4. Keep the repository root as the service root directory.
5. Add the variables from `.env.railway.fullstack.example` in Railway Variables.
6. Generate or attach the public domain `https://probx.up.railway.app`.
7. Redeploy after changing any `NEXT_PUBLIC_*` variable because those values are embedded during the Next.js build.

`railway.json` builds and starts the full Next.js application:

```text
Build: pnpm --filter @probx/web build
Start: pnpm --filter @probx/web start
Health: /api/health
```

The Next.js instrumentation entry starts the API background workers in the same persistent process.

## Gmail OAuth

The Railway URL is not the OAuth helper callback. Create a Google OAuth **Desktop app** and run locally:

```bash
GMAIL_OAUTH_CLIENT_ID='...' \
GMAIL_OAUTH_CLIENT_SECRET='...' \
pnpm gmail:oauth
```

The helper listens on:

```text
http://127.0.0.1:53682/oauth2/callback
```

Copy the resulting refresh token into Railway as `GMAIL_OAUTH_REFRESH_TOKEN`.

## Verify

Open:

```text
https://probx.up.railway.app/api/health
```

Confirm the worker state reports enabled market-cycle and oracle-snapshot workers. New markets should normally follow the previous market within roughly one or two cycle intervals.

### Gmail OAuth: `state mismatch`

The helper ignores stale or parameterless callback requests and keeps waiting for the current Google authorization flow. Close old OAuth tabs, run `pnpm gmail:oauth` once, and open only the newest URL printed in that terminal.
