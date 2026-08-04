# RPC and Railway budget

## What was removed

The previous runtime could repeatedly:

- scan every market from both `auto-resolve` and `market-cycle`;
- scan approximately 250,000 blocks of `TicketBought` logs every 20 seconds for aggregate stats;
- reread every cached ticket and its market on every Portfolio poll;
- send full chart histories to each browser every one to three seconds;
- run a full Next server on Railway even though the UI was hosted by Vercel.

The optimized runtime now:

- has one resolver (`market-cycle`), with `AUTO_RESOLVE_ENABLED=0`;
- shares a five-minute market metadata cache across routes and workers, and rereads only four mutable fields on known active contracts;
- refreshes only the two public active contracts once per minute while the UI is being used;
- fetches oracle feeds only near observation boundaries;
- refreshes Portfolio at most once per minute and skips active/settled tickets that cannot change;
- runs aggregate log scans at most once per ten minutes;
- stores each new market's creation block and begins strict settlement scans there;
- sends one full chart payload, then lightweight current-value payloads;
- pauses browser polling in hidden tabs;
- starts only `apps/api` on Railway;
- caps JSON-RPC batches at three methods so dRPC does not reject a large batch and force the same calls to be retried individually.

## Approximate dRPC usage

With the defaults in `.env.example`, 18 markets in the factory tail and continuous public traffic, the background target is approximately:

| Source | Approximate RPC methods / 30 days |
|---|---:|
| Factory reconciliation every 5 min; immutable/final fields reused | about 0.1–0.2M |
| Two active cards refreshed every 60s (four mutable fields + bounded logs) | about 0.6M |
| Aggregate logs every 10 min | 0.3M |
| Market create/resolve/receipt/settlement overhead | about 0.7–1.5M |
| **Expected base range** | **about 2–3M** |

This is an estimate, not a hard guarantee. Wallet balances, quotes, buys, claims, first-time Portfolio log scans, RPC retries and additional browser users add to it. Keep only the private dRPC endpoint in Railway `ARC_RPC_URL`, leave `ARC_RPC_URLS` empty and keep `RPC_ENABLE_PUBLIC_FALLBACK=0`; this prevents hidden retry traffic to other gateways. On Vercel use Arc public RPC for `NEXT_PUBLIC_ARC_RPC_URL` so ordinary browser reads do not consume the private dRPC project. Keep `RPC_BATCH_SIZE=3` for dRPC free-tier compatibility.

## Railway $5 target

Use these deployment choices:

- one `@probx/api` service and one replica;
- no Next frontend process on Railway;
- no separate cron service;
- no separate auto-resolver service;
- sleeping/serverless disabled because the oracle workers must remain alive;
- Vercel serves all static/UI traffic;
- set a Railway usage alert before $5 and a hard limit only if automatic shutdown is acceptable.

Memory is usually the largest always-on cost. Check Railway Metrics after a full day. If the API consistently uses too much memory for the $5 credit, the next step is reducing optional Circle SDK initialization or moving noncritical wallet features to a separate on-demand service; do not solve it by sleeping the oracle process.
