# Vercel — что поменять после push (2026-07-25)

Redeploy: **Production** (и Preview, если пользуешься).

---

## Обязательно обновить

Новые контракты после self-audit redeploy. Старые адреса **сломают** buy / LP / cycle.

| Name | Value |
|------|--------|
| `NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS` | `0x94Bd455DB31ddA0AFA13C8dF0E25D5ef4b787581` |
| `NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS` | `0x647cCdDB471A22651e5e764f000f6a0cf232cacd` |
| `NEXT_PUBLIC_MARKET_FACTORY_ADDRESS` | `0x5FE8988706f7E1654968D77c920C19c48C1Ec2f8` |
| `ARC_FROM_BLOCK` | `53536935` |

### Public (проверь, что так)

| Name | Value |
|------|--------|
| `NEXT_PUBLIC_CHAIN_ID` | `5042002` |
| `NEXT_PUBLIC_USDC_ADDRESS` | `0x3600000000000000000000000000000000000000` |
| `NEXT_PUBLIC_ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| `NEXT_PUBLIC_ARC_RPC_URLS` | `https://rpc.testnet.arc.network,https://arc-testnet.drpc.org` |
| `NEXT_PUBLIC_API_BASE_URL` | **не создавай** или удали (same-origin `/api`) |

### Server RPC

| Name | Value |
|------|--------|
| `ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| `ARC_RPC_URLS` | `https://rpc.testnet.arc.network,https://arc-testnet.drpc.org` |

---

## Не трогай (если уже работают)

- `PRIVATE_KEY` / `ORACLE_PRIVATE_KEY` / `DEPLOYER_PRIVATE_KEY` / `OWNER_PRIVATE_KEY`
- `CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET` / `CIRCLE_WALLET_SET_ID`
- `SESSION_HMAC_SECRET` / `ADMIN_SECRET` / `CRON_SECRET` / `OTP_HMAC_SECRET` / `SESSION_WALLET_SECRET`
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
- SMTP / email OTP (`SMTP_*`, `EMAIL_OTP_*`)
- `CCTP_SOURCE_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`, `SEPOLIA_RPC_URL`
- `MARKET_CYCLE_ENABLED`, `MARKET_CYCLE_INTERVAL_MS`, `CRON_THROTTLE_MS`
- `RPC_BATCH=1`

Рекомендуется для free tier (меньше CPU):

| Name | Value |
|------|--------|
| `MARKET_CYCLE_ON_TRAFFIC` | `0` |

---

## Опционально (новое, не обязательно)

| Name | Когда |
|------|--------|
| `CIRCLE_KIT_KEY` | есть kit key из Circle Console |
| `NEXT_PUBLIC_CIRCLE_KIT_KEY` | то же для браузера |
| `APP_KIT_STRICT` / `NEXT_PUBLIC_APP_KIT_STRICT` | `1` = без silent fallback на viem/CCTP |

---

## После сохранения

1. **Deployments → Redeploy** (Production)  
2. Hard refresh сайта  
3. Smoke:
   - `https://<твой-домен>/api/health` → `{"ok":true}`
   - `https://<твой-домен>/api/lp/stats` → есть `tvl`, `totalVolume`, …
   - `https://<твой-домен>/api/markets` → адреса `0x…`

Полный JSON деплоя: [`DEPLOYMENT_ARC_TESTNET.json`](./DEPLOYMENT_ARC_TESTNET.json).
