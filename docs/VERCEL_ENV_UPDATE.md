# Vercel — что поменять после push (2026-07-25 full redeploy)

Redeploy: **Production** (и Preview, если пользуешься).

Security redeploy: market registry + 100000 USDC LP seed. Старые адреса **сломают** buy / LP / cycle.

---

## Обязательно обновить

| Name | Value |
|------|--------|
| `NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS` | `0xc91d548A7E3a1ddB8f4eac302cB8F5b79a7cc062` |
| `NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS` | `0xE24acA031A4cd9B6a8e4E1fF806A2cae7a206572` |
| `NEXT_PUBLIC_MARKET_FACTORY_ADDRESS` | `0xd71eBd51Ed53C764b38E78EAe451D86BFa47d19A` |
| `ARC_FROM_BLOCK` | `53550453` |

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

## Опционально

| Name | Когда |
|------|--------|
| `CIRCLE_KIT_KEY` | kit key из Circle Console |
| `NEXT_PUBLIC_CIRCLE_KIT_KEY` | то же для браузера |
| `APP_KIT_STRICT` / `NEXT_PUBLIC_APP_KIT_STRICT` | `1` = без silent fallback |

---

## После сохранения

1. **Deployments → Redeploy** (Production)  
2. Hard refresh сайта  
3. Smoke:
   - `https://probx-web.vercel.app/api/health` → `{"ok":true}`
   - `https://probx-web.vercel.app/api/lp/stats` → TVL ≈ **100000** USDC
   - `https://probx-web.vercel.app/api/markets` → адреса `0x…` с нового factory
4. Email login → Buy **без** MetaMask

Полный JSON: [`DEPLOYMENT_ARC_TESTNET.json`](./DEPLOYMENT_ARC_TESTNET.json).

### Core contracts (2026-07-25)

| Contract | Address |
|----------|---------|
| MicroBoostEngine | [`0xc91d548A7E3a1ddB8f4eac302cB8F5b79a7cc062`](https://testnet.arcscan.app/address/0xc91d548A7E3a1ddB8f4eac302cB8F5b79a7cc062) |
| LiquidityPool | [`0xE24acA031A4cd9B6a8e4E1fF806A2cae7a206572`](https://testnet.arcscan.app/address/0xE24acA031A4cd9B6a8e4E1fF806A2cae7a206572) |
| MarketFactory | [`0xd71eBd51Ed53C764b38E78EAe451D86BFa47d19A`](https://testnet.arcscan.app/address/0xd71eBd51Ed53C764b38E78EAe451D86BFa47d19A) |
| PositionTicket | [`0x6632d31b7A44755D032A714A99dB9C0B923E5b8A`](https://testnet.arcscan.app/address/0x6632d31b7A44755D032A714A99dB9C0B923E5b8A) |
| OracleAdapter | [`0x57eEc368F233c2c904c8E22F1bf74303797367b6`](https://testnet.arcscan.app/address/0x57eEc368F233c2c904c8E22F1bf74303797367b6) |
| InsuranceFund | [`0xDb336c5c7bCaF8e6E789078BEe611Aa14eB0809B`](https://testnet.arcscan.app/address/0xDb336c5c7bCaF8e6E789078BEe611Aa14eB0809B) |
| FeeRouter | [`0x4CaAB026fF36Eb210Bbd7ae52Ed1Eab2C04a7181`](https://testnet.arcscan.app/address/0x4CaAB026fF36Eb210Bbd7ae52Ed1Eab2C04a7181) |
