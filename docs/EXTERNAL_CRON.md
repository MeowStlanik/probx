# External cron pinger (production)

Vercel Hobby runs native crons infrequently (often ~once per day). For live BTC / London markets you need a **public URL hit about every minute**.

## Production URL only

| Use for jury / cron | Do **not** use |
|---------------------|----------------|
| **https://probx-rosy.vercel.app** | `probx-….vercel.app` deploy previews (`*-stlaniks-projects.vercel.app`) |

Vercel Cron and this pinger must target **production**. If the jury opens a preview while resolve runs on production (or vice versa), markets look stuck.

---

## Protect the endpoint

Set the **same** secret in Vercel (Production + Preview if you want, but pinger only needs Production):

```text
CRON_SECRET=<long random string>
```

When `CRON_SECRET` is set:

| Endpoint | Without secret | With `?secret=` or `Authorization: Bearer …` |
|----------|----------------|-----------------------------------------------|
| `/api/cron/auto-resolve` | **401** | runs resolve (+ market cycle if possible) |
| `/api/cron/market-cycle` | allowed but **throttled** (browser heartbeat) | runs immediately |

Local dev without `CRON_SECRET`: endpoints stay open but throttled (gas-spam guard).

---

## Option A — GitHub Actions (in this repo)

Workflow: [`.github/workflows/cron-ping.yml`](../.github/workflows/cron-ping.yml)

1. Repo → **Settings → Secrets and variables → Actions**
2. Add:
   - `PROBX_CRON_BASE_URL` = `https://probx-rosy.vercel.app`
   - `PROBX_CRON_SECRET` = same as Vercel `CRON_SECRET`
3. Enable Actions on the default branch (workflow runs on `schedule: * * * * *` + manual **Run workflow**).

GitHub may delay minute cron under load (often 1–5 min). Still far better than daily Vercel Hobby cron.

---

## Option B — cron-job.org (no code)

1. Open [https://cron-job.org](https://cron-job.org) → create free account  
2. **Create cronjob**  
3. URL (pick one style):

```text
https://probx-rosy.vercel.app/api/cron/auto-resolve?secret=YOUR_CRON_SECRET
```

Or URL without query + header:

```text
URL:    https://probx-rosy.vercel.app/api/cron/auto-resolve
Header: Authorization: Bearer YOUR_CRON_SECRET
```

4. Schedule: **every 1 minute**  
5. Optional second job for market create/rotate:

```text
https://probx-rosy.vercel.app/api/cron/market-cycle?secret=YOUR_CRON_SECRET
```

6. Enable notifications on non-2xx if available.

---

## Quick smoke test

```bash
# should be 401 if CRON_SECRET is set on prod
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://probx-rosy.vercel.app/api/cron/auto-resolve

# should be 200 with secret
curl -sS -H "Authorization: Bearer $CRON_SECRET" \
  https://probx-rosy.vercel.app/api/cron/auto-resolve | head -c 400
```

---

## Jury checklist

- [ ] Share **https://probx-rosy.vercel.app** (not a preview URL)  
- [ ] `CRON_SECRET` set on Vercel **Production**  
- [ ] External pinger (Actions or cron-job.org) hits **probx-rosy** every minute  
- [ ] `ORACLE_PRIVATE_KEY` / `PRIVATE_KEY` set so resolve can sign on Arc  
