# Vercel — apply after redeploy (2026-07-27 14:46 UTC)

**Production → Settings → Environment Variables → Save → Redeploy.**

This deployment: **manipulation-resistant book** (virtual depth sized from pool capital
+ a hard drift band on fair mid), free-capital LP, market registry, seed **100000 USDC**.

**Do not use the older addresses** — neither the pre-July set (`0xc91d…` / `0xE24ac…` /
`0xd71e…`) nor the July 25 deployment (`0x1e70aD…` / `0xA3FA6F…` / `0xff5Cc3…`): the book
is exploitable in both. The July 25 pool has also been drained to seed this one, so
pointing at it shows an empty vault.

---

## Must update (copy-paste)

| Name | Value |
|------|--------|
| `NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS` | `0x469592aEff57eE56e910A75eA69a6538E8B59A67` |
| `NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS` | `0xdB25f054D2D88c38FB06f74ADaD1b06e87a06De8` |
| `NEXT_PUBLIC_MARKET_FACTORY_ADDRESS` | `0xf659eDf16E55307095a08fd29727316513acdF19` |
| `ARC_FROM_BLOCK` | `53938140` |

### Public (verify)

| Name | Value |
|------|--------|
| `NEXT_PUBLIC_CHAIN_ID` | `5042002` |
| `NEXT_PUBLIC_USDC_ADDRESS` | `0x3600000000000000000000000000000000000000` |
| `NEXT_PUBLIC_ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| `NEXT_PUBLIC_ARC_RPC_URLS` | `https://rpc.testnet.arc.network,https://arc-testnet.drpc.org` |
| `NEXT_PUBLIC_API_BASE_URL` | **leave empty / delete** (same-origin `/api`) |

### Server RPC

| Name | Value |
|------|--------|
| `ARC_RPC_URL` | `https://rpc.testnet.arc.network` |
| `ARC_RPC_URLS` | `https://rpc.testnet.arc.network,https://arc-testnet.drpc.org` |

---

## Leave alone (if already working)

- `PRIVATE_KEY` / `ORACLE_PRIVATE_KEY` / `DEPLOYER_PRIVATE_KEY` / `OWNER_PRIVATE_KEY`
- `CIRCLE_API_KEY` / `CIRCLE_ENTITY_SECRET` / `CIRCLE_WALLET_SET_ID`
- `SESSION_HMAC_SECRET` / `ADMIN_SECRET` / `CRON_SECRET` / `OTP_HMAC_SECRET` / `SESSION_WALLET_SECRET`
- **`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`** (required for oracle / CCTP / OTP)
- SMTP / email OTP
- `CCTP_SOURCE_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`
- `MARKET_CYCLE_ENABLED`, `MARKET_CYCLE_INTERVAL_MS`, `CRON_THROTTLE_MS`
- `RPC_BATCH=1`

Recommended on the free tier:

| Name | Value |
|------|--------|
| `MARKET_CYCLE_ON_TRAFFIC` | `0` |

---

## All contracts (Arc Testnet)

| Contract | Address | Explorer |
|----------|---------|----------|
| **MicroBoostEngine** | `0x469592aEff57eE56e910A75eA69a6538E8B59A67` | [scan](https://testnet.arcscan.app/address/0x469592aEff57eE56e910A75eA69a6538E8B59A67) |
| **LiquidityPool** | `0xdB25f054D2D88c38FB06f74ADaD1b06e87a06De8` | [scan](https://testnet.arcscan.app/address/0xdB25f054D2D88c38FB06f74ADaD1b06e87a06De8) |
| **MarketFactory** | `0xf659eDf16E55307095a08fd29727316513acdF19` | [scan](https://testnet.arcscan.app/address/0xf659eDf16E55307095a08fd29727316513acdF19) |
| PositionTicket | `0x48500Ce7Bc323814f9092c31bFE6957DCEeA152C` | [scan](https://testnet.arcscan.app/address/0x48500Ce7Bc323814f9092c31bFE6957DCEeA152C) |
| OracleAdapter | `0x6ACfEA3A4713bC723abcFE17Ee6E31FdFB9d3F16` | [scan](https://testnet.arcscan.app/address/0x6ACfEA3A4713bC723abcFE17Ee6E31FdFB9d3F16) |
| InsuranceFund | `0xd35766360FAC570d67cB88D0C5b94EFD0aEeb781` | [scan](https://testnet.arcscan.app/address/0xd35766360FAC570d67cB88D0C5b94EFD0aEeb781) |
| FeeRouter | `0xc6ABDD0D4dB15f347E0690F471098694E284AC63` | [scan](https://testnet.arcscan.app/address/0xc6ABDD0D4dB15f347E0690F471098694E284AC63) |
| Demo market | `0x6b765D51e3f3A90dd1e1e15A86d887F8ec5b0967` | [scan](https://testnet.arcscan.app/address/0x6b765D51e3f3A90dd1e1e15A86d887F8ec5b0967) |
| USDC | `0x3600000000000000000000000000000000000000` | native testnet |

| Meta | Value |
|------|--------|
| Deployer | `0x4604a582B66431481D5320fed67C785bdb4D7Fe0` |
| LP seed | **100000** USDC |
| fromBlock | **53938140** |
| deployedAt | `2026-07-27T14:46:14.564Z` |

JSON: [`DEPLOYMENT_ARC_TESTNET.json`](./DEPLOYMENT_ARC_TESTNET.json)

---

## After Save → Redeploy

1. `https://<your-app>.vercel.app/api/health` → `{"ok":true}`
2. `/api/lp/stats` → TVL ≈ **100000**
3. `/api/markets` → addresses from the **new** factory `0xf659eD…`
4. Email login → Buy

Bundled addresses also in repo:
- `apps/web/src/lib/deployment.json`
- `apps/api/src/config/arc-deployment.json`
