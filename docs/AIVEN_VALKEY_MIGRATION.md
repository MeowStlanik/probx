# Upstash Redis → Aiven for Valkey migration

This runbook moves ProbX durable state from Upstash to Aiven for Valkey with a staged cutover and a short rollback window. The application now prefers `AIVEN_VALKEY_URL`; the existing Upstash REST variables remain a temporary fallback only.

## What the application needs

The API uses ordinary Redis/Valkey commands: strings, hashes, sorted sets, expirations, `SET NX PX`, counters, and Lua `EVAL`. Aiven restricts administrative commands such as `CONFIG`, `SAVE`, `MIGRATE`, and `ACL`, but not these application commands.

The application connects with `ioredis` using the TLS service URI from the Aiven service Overview page:

```dotenv
AIVEN_VALKEY_URL=rediss://USER:PASSWORD@HOST:PORT
```

Do not put the URI in browser/Vercel `NEXT_PUBLIC_*` variables. Configure it only on the server-side Railway service.

## 1. Prepare and validate

1. Create the target **Aiven for Valkey** service in the required cloud and region. Size it above the current Upstash dataset plus operational headroom.
2. In Aiven **Backups**, enable `valkey_persistence=rdb`. Do not use `off` for this production state store.
3. Record the source **standard Redis** connection details from Upstash: endpoint, port, username if present, and token/password. The REST URL is not the source address for Aiven's migration wizard.
4. Confirm that the source Redis version is no newer than Redis 7.2 and no newer than the target Aiven Valkey version. If it is newer, stop and use a tested export/import path instead of the console wizard.
5. Confirm the Upstash endpoint is publicly reachable over TLS from Aiven and that any allowlist/firewall permits the migration.
6. Create a dedicated Aiven application user. During migration validation, grant the command categories and key patterns required by the application. A broad temporary ACL can be tightened after the smoke test. A least-privilege baseline must cover `PING`, `INFO`, `CLIENT`, `GET`, `SET`, `DEL`, `EXPIRE`, `PEXPIRE`, `INCR`, `HGET`, `HSET`, `HDEL`, `HGETALL`, `HLEN`, `ZADD`, `ZRANGEBYSCORE`, `ZCARD`, `ZREMRANGEBYSCORE`, and `EVAL`, plus the application's key patterns.

Never commit either provider's credentials to the repository.

## 2. Start live migration

In the target Aiven service:

1. Open **Service settings**.
2. Under **Service management → Actions**, select **Import database** (Redis source) or the equivalent migration action shown in the current console.
3. Enter the Upstash standard Redis hostname, port, username, and password/token.
4. Enable SSL/TLS and run the connection check.
5. Start migration and keep live replication running while validation is performed.

Do not change the source database configuration, network rules, or topology while replication is active.

If the console migration cannot establish replication from Upstash, use Aiven's CLI migration. The CLI first attempts replication and automatically falls back to a `SCAN` copy. A scan migration is a point-in-time copy rather than continuous synchronization, so stop application writes before the final run and keep them stopped until cutover validation is complete. Upstash can also export an RDB snapshot for an offline backup, but do not assume Aiven accepts a direct RDB upload unless Aiven support confirms the procedure for the selected service.

## 3. Validate the target before cutover

Configure `AIVEN_VALKEY_URL` in a non-production environment and run:

```bash
pnpm install --frozen-lockfile
AIVEN_VALKEY_URL='rediss://...' pnpm kv:smoke
```

The smoke test verifies `PING`, `SET NX PX`, Lua `EVAL`/`PEXPIRE`, hashes, and sorted sets, then removes its temporary keys.

Also compare source and target before switching traffic:

- total key count and memory usage;
- representative ProbX namespaces and values;
- TTLs on OTP, lock, session, quota, and transaction keys;
- application flows for OTP login, wallet mapping, session revocation, transaction tracking, market/oracle state, and distributed locks.

Use read-only inspection where possible. Do not run `FLUSHDB`, `FLUSHALL`, or bulk deletion commands.

## 4. Cut over

1. Schedule a short maintenance/read-only window if the product can support it.
2. Wait until Aiven reports migration caught up and no replication errors.
3. Add the production Railway variable:

   ```dotenv
   AIVEN_VALKEY_URL=rediss://...
   ```

4. Keep `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` unchanged only for the agreed rollback window. The code always prefers Aiven when `AIVEN_VALKEY_URL` is present.
5. Redeploy the API and immediately run the production smoke check from a trusted shell.
6. Verify health, logs, OTP login, wallet/session operations, transaction updates, worker locks, and market/oracle processing.
7. After the application is stable on Aiven, stop source-to-target replication in the Aiven migration tool.

## 5. Roll back safely

To route the application back to Upstash, remove `AIVEN_VALKEY_URL` and redeploy. The legacy Upstash REST configuration then becomes active again.

**Important:** this is connection fallback, not dual-write. Writes made after cutover exist only in Aiven. Rolling back after accepting production writes can therefore restore stale Upstash state. Keep the rollback decision window short, prefer a read-only cutover window, and copy/reconcile post-cutover changes before any late rollback.

## 6. Finish

After the agreed verification window:

1. Confirm Aiven backups and persistence are healthy.
2. Tighten the application user's ACL to the required commands/categories and key patterns.
3. Remove the legacy Upstash variables from Railway.
4. Rotate or revoke the Upstash token and decommission the old database only after final data verification.
5. In a later cleanup change, remove the legacy REST fallback from `persistentStore.ts` once rollback is no longer required.

## Reference documentation

- Aiven: Connect to Aiven for Valkey with NodeJS
- Aiven: Migrate from Redis to Aiven for Valkey using Aiven Console
- Aiven: Restricted commands in Aiven for Valkey
- Aiven: Configure ACL permissions in Aiven for Valkey
- Aiven: Service backups and `valkey_persistence`
- Upstash: Connect your Redis client over TLS
