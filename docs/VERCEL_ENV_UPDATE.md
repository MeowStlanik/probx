# Vercel — вставить после redeploy (2026-07-25 11:44 UTC)

**Production → Settings → Environment Variables → Save → Redeploy.**

Этот деплой: **free-capital LP** (reserve 0.85 больше не блокирует 100k), market registry, seed **100000 USDC**.

Старые адреса (`0xc91d…` / `0xE24ac…` / `0xd71e…`) **не использовать**.

---

## Обязательно обновить (copy-paste)

| Name | Value |
|------|--------|
| `NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS` | `0x1e70aD4528bb1c2C967D20A603eE4DC243713b39` |
| `NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS` | `0xA3FA6F33c9c0216082987D303b27799fBBE91373` |
| `NEXT_PUBLIC_MARKET_FACTORY_ADDRESS` | `0xff5Cc346a9703C0Db70b45c18CB3e821Dc63C47b` |
| `ARC_FROM_BLOCK` | `53581996` |

### Public (проверь)

| Name | Value |
|------|--------|
| `NEXT_PUBLIC_CHAIN_ID` | `5042002` |
| `NEXT_PUBLIC_USDC_ADDRESS` | `0x3600000000000000000000000000000000000000` |
| `NEXT_PUBLIC_ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| `NEXT_PUBLIC_ARC_RPC_URLS` | `https://rpc.testnet.arc.network,https://arc-testnet.drpc.org` |
| `NEXT_PUBLIC_API_BASE_URL` | **пусто / удали** (same-origin `/api`) |

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
- **`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`** (обязательно для oracle/CCTP/OTP)
- SMTP / email OTP
- `CCTP_SOURCE_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`
- `MARKET_CYCLE_ENABLED`, `MARKET_CYCLE_INTERVAL_MS`, `CRON_THROTTLE_MS`
- `RPC_BATCH=1`

Рекомендуется free tier:

| Name | Value |
|------|--------|
| `MARKET_CYCLE_ON_TRAFFIC` | `0` |

---

## Все контракты (Arc Testnet)

| Contract | Address | Explorer |
|----------|---------|----------|
| **MicroBoostEngine** | `0x1e70aD4528bb1c2C967D20A603eE4DC243713b39` | [scan](https://testnet.arcscan.app/address/0x1e70aD4528bb1c2C967D20A603eE4DC243713b39) |
| **LiquidityPool** | `0xA3FA6F33c9c0216082987D303b27799fBBE91373` | [scan](https://testnet.arcscan.app/address/0xA3FA6F33c9c0216082987D303b27799fBBE91373) |
| **MarketFactory** | `0xff5Cc346a9703C0Db70b45c18CB3e821Dc63C47b` | [scan](https://testnet.arcscan.app/address/0xff5Cc346a9703C0Db70b45c18CB3e821Dc63C47b) |
| PositionTicket | `0xB3Fe3e5EFbb25Cb449933C98968820C0802024b2` | [scan](https://testnet.arcscan.app/address/0xB3Fe3e5EFbb25Cb449933C98968820C0802024b2) |
| OracleAdapter | `0x28A4EF91890Ca2471aEfC3BB8080362A6B3AFd0B` | [scan](https://testnet.arcscan.app/address/0x28A4EF91890Ca2471aEfC3BB8080362A6B3AFd0B) |
| InsuranceFund | `0x3413beF6f2cDd98679a1a5FdC27a3F748492C8cE` | [scan](https://testnet.arcscan.app/address/0x3413beF6f2cDd98679a1a5FdC27a3F748492C8cE) |
| FeeRouter | `0xc31129765071651E6104129AB3108A4F03add718` | [scan](https://testnet.arcscan.app/address/0xc31129765071651E6104129AB3108A4F03add718) |
| Demo market | `0xad3599b5f3A0a88bcf61D56357ef9dADFFe03e67` | [scan](https://testnet.arcscan.app/address/0xad3599b5f3A0a88bcf61D56357ef9dADFFe03e67) |
| USDC | `0x3600000000000000000000000000000000000000` | native testnet |

| Meta | Value |
|------|--------|
| Deployer | `0x4604a582B66431481D5320fed67C785bdb4D7Fe0` |
| LP seed | **100000** USDC |
| fromBlock | **53581996** |
| deployedAt | `2026-07-25T11:44:32.308Z` |

JSON: [`DEPLOYMENT_ARC_TESTNET.json`](./DEPLOYMENT_ARC_TESTNET.json)

---

## После Save → Redeploy

1. `https://<your-app>.vercel.app/api/health` → `{"ok":true}`
2. `/api/lp/stats` → TVL ≈ **100000**
3. `/api/markets` → адреса с **нового** factory `0xff5Cc…`
4. Email login → Buy

Bundled addresses also in repo:
- `apps/web/src/lib/deployment.json`
- `apps/api/src/config/arc-deployment.json`
