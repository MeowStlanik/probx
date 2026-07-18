# ProbX Arc — smart contract tests (Foundry)

**14 tests · 4 suites · all in-repo under `contracts/test/`**

They never left — only lived next to the Solidity sources, not in the Next.js app.

```bash
# from monorepo root
pnpm contracts:test

# or
cd contracts && forge test -vv
```

## Suites

| # | Suite file | Focus |
|---|------------|--------|
| 1–4 | `MicroMarket.t.sol` | Market lifecycle + odds after YES/NO buys |
| 5–8 | `ReserveAccounting.t.sol` | LP reserve lock / release / payout / insufficient |
| 9–12 | `Settlement.t.sol` | Win/loss settle, cancel refund, batch + fees |
| 13–14 | `LiquidityPool.t.sol` | Deposit/withdraw + withdraw blocked by reserve |

## All 14 tests (clear names)

### MicroMarket (4)
1. `test_01_Lifecycle_OpenLockResolveArchive` — open → lock → resolve → archive  
2. `test_02_Buy_RevertsWhenMarketNotOpen` — cannot buy before open window  
3. `test_03_BuyYes_RaisesYesPriceLowersNoPrice` — YES buy moves on-chain odds  
4. `test_04_BuyNo_RaisesNoPriceLowersYesPrice` — NO buy moves opposite  

### Reserve accounting (4)
5. `test_05_Reserve_IncreasesOnTicketBuy` — reserve + user risk locked  
6. `test_06_Reserve_ReleasesOnLosingTicket` — loss keeps risk in pool  
7. `test_07_Reserve_PaysWinningTicket` — winner gets full payout  
8. `test_08_Buy_RevertsWhenReserveInsufficient` — no LP → cannot buy  

### Settlement (4)
9. `test_09_Settlement_YesWinsPayout` — YES resolve pays ticket  
10. `test_10_Settlement_NoWinsPoolKeepsRisk` — NO resolve keeps stake  
11. `test_11_Settlement_CancelRefundsRisk` — cancel refunds risk  
12. `test_12_Settlement_BatchAndFeeRouting` — settleBatch + LP/insurance fees  

### Liquidity pool (2)
13. `test_13_Lp_DepositMintsSharesAndWithdraw` — deposit shares + partial withdraw  
14. `test_14_Lp_WithdrawBlockedByReservedAssets` — cannot withdraw reserved capital  

## Helpers

- `MiniTest.sol` — tiny assert helpers + `vm` cheatcodes  
- `TestHarness.sol` — deploys full stack (USDC, pool, engine, factory, user)
