# ProbX — сводка изменений

Документ описывает, что сделано в этой итерации и что ещё нужно доделать.
Все правки внесены с сохранением текущего дизайна.

---

## 1. Перевод USDC на другой кошелёк внутри Arc

Пользователь теперь может отправить USDC на любой Arc-адрес прямо из приложения.

**Бэкенд**
- `apps/api/src/services/circleWalletService.ts` — `transferUsdcViaCircle()`:
  перевод USDC через Circle `createTransaction` (для email/Circle-кошельков).
- `apps/api/src/services/sessionWalletService.ts` — `transferUsdcForSession()`:
  единая точка входа. Circle-путь для embedded-кошельков, локальный ERC-20
  `transfer` для injected (MetaMask). USDC считается в 6 decimals.
- `apps/api/src/routes/wallet.ts` — маршрут `POST /api/wallet/transfer`.

**Фронтенд**
- `apps/web/src/lib/onchain.ts` — в `usdcAbi` добавлены `transfer` и `decimals`.
- `apps/web/src/lib/wallet.tsx` — в контекст добавлен `sendUsdc(to, amount)`:
  embedded → сервер подписывает и трекает статус; injected → прямой
  `transfer` + регистрация хэша для трекинга.
- `apps/web/src/nextjs/components/WalletPopover.tsx` — кнопка **Send USDC**
  рядом с Deposit / Bridge.
- `apps/web/src/components/FundUsdcPanel.tsx` — новая вкладка **↗ Send** с
  полями «адрес получателя» и «сумма», проверкой баланса, валидацией и живым
  статусом `pending → confirmed / failed` со ссылкой на explorer. Использованы
  существующие CSS-классы (`fundField`, `fundFooterBtn primary`, `spinIcon`).
- `apps/web/src/nextjs/shells/AppChrome.tsx`,
  `apps/web/src/nextjs/components/Header.tsx` — проброс `onSend`.

---

## 2. Убрана кнопка админ-панели

- `apps/web/src/nextjs/components/Header.tsx` — удалена иконка-шестерёнка ⚙
  (та самая «в виде солнца») в правом верхнем углу.
- `apps/web/src/nextjs/components/Footer.tsx` — удалена ссылка **Admin** из
  списка ссылок в футере.

> Примечание: сам маршрут `/admin` физически остаётся в коде, но из UI больше
> нет видимых точек входа. Если нужно удалить и роут — скажите, уберу страницу
> `apps/web/src/app/admin/`.

---

## 3. Надёжность кошельков (продакшен)

**Проблема:** соответствие email → walletId/address хранилось в `/tmp`, который
на Vercel эфемерный и per-instance. После logout / истечения сессии / нового
инстанса для того же email мог создаться новый кошелёк.

**Решение**
- `apps/api/src/services/persistentStore.ts` — новый durable KV-слой
  (`NamespaceStore`). В проде пишет в Redis по REST (Upstash / Vercel KV),
  локально — в JSON-файл. Без новых npm-зависимостей (через `fetch`).
- `apps/api/src/services/circleWalletService.ts` переписан:
  - соответствие email → walletId/address теперь в durable-store, не в `/tmp`;
  - **восстановление через `Circle.listWallets({ walletSetId, refId })`** по
    детерминированному `refId` (хэш от email). Если локальная запись потеряна,
    кошелёк восстанавливается, а не создаётся заново — сценарий «после logout
    новый кошелёк» исключён.

### Настройка KV (бесплатно — Upstash Redis)

1. Зарегистрируйся на upstash.com, создай **Redis** базу (free tier: ~500k
   команд/мес, 256 МБ).
2. Скопируй из вкладки **REST API**:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. Добавь их в переменные окружения Vercel (Project → Settings → Environment
   Variables) и передеплой.

Код читает **обе** пары имён, поэтому подойдёт и Vercel KV:
`KV_REST_API_URL` + `KV_REST_API_TOKEN`. Если переменные не заданы — тихий
fallback на файловое хранилище (удобно локально).

---

## 4. Статусы транзакций

**Проблема:** полагались на ожидание хэша без дальнейшего отслеживания —
возможны «зависшие» состояния.

**Решение**
- `apps/api/src/services/txTrackerService.ts` — трекинг каждой операции
  (`buy` / `claim` / `deposit` / `transfer` / `approve`) как записи со статусом
  `pending → confirmed / failed`. Статус сверяется по on-chain receipt,
  персистится в durable KV, доступен с любого инстанса.
  - `recordTx()` — запись при получении хэша.
  - `reconcileTx()` — сверка одной записи по receipt (с grace-window 10 мин,
    после чего «дропнутая» tx помечается failed).
  - `reconcilePending()` — пакетная сверка, вызывается на cron-heartbeat.
- `apps/api/src/routes/wallet.ts`:
  - `GET /api/wallet/tx?hash=0x…` — статус одной tx.
  - `GET /api/wallet/tx?owner=…` — история операций пользователя.
  - `POST /api/wallet/tx/record` — регистрация хэша (injected-путь).
  - запись статуса встроена в `write-contract` и `transfer`.
- `apps/api/src/dispatch.ts` — `reconcilePending()` подключён к
  `/api/cron/market-cycle` (серверная авто-сверка на каждом heartbeat).

**Фронтенд**
- `apps/web/src/lib/wallet.tsx` — `pollTxStatus(hash)` и `trackTx({...})`.
- Подключено к реальным кнопкам:
  - buy + approve — `MarketDetailShell.tsx`;
  - claim — `PortfolioShell.tsx`;
  - LP approve / deposit / withdraw — `LpShell.tsx`;
  - send — в `FundUsdcPanel.tsx` (вкладка Send) с polling до
    confirmed / failed.
- CCTP-депозит (bridge) не дублируется в этом трекере — у него собственный
  step-machine со статусами attestation (это межчейн-операция на source-сети).

---

## Проверки

- `apps/api` — `tsc --noEmit` проходит без ошибок.
- Изменённые файлы `apps/web` (`wallet.tsx`, `onchain.ts`, `FundUsdcPanel.tsx`,
  затронутые shells и компоненты) — проверены точечным `tsc` (ошибок нет;
  остаётся только ожидаемый шум по неустановленным в песочнице пакетам
  `next/*`, `wagmi`, которые есть в реальном репозитории).

---

## Что ещё желательно доделать

1. **Полный прогон проверок в CI.** Здесь `tsc` для web гонялся точечно, т.к.
   в песочнице не установлены `next`, `wagmi`, `driver.js`. На машине с
   `pnpm install` нужно прогнать `pnpm -r lint` / `pnpm -r build` целиком.
2. **UI-история транзакций.** Инфраструктура `GET /api/wallet/tx?owner=`
   готова, но отдельного экрана «История» пока нет — статусы сейчас видны в
   момент операции (buy/claim/send). Можно добавить список последних tx в
   Portfolio.
3. **Webhooks Circle.** Реализован надёжный polling + серверная сверка на
   cron. Для мгновенных обновлений можно дополнительно принять Circle webhook
   (эндпоинт `POST /api/wallet/tx/webhook`) — сейчас не сделано, polling
   покрывает задачу.
4. **Удаление роута `/admin`** (если нужно), а не только точек входа из UI.
5. **Тесты** на `persistentStore` / `txTrackerService` (сейчас нет).
6. **README env.** Добавить `UPSTASH_REDIS_REST_URL/TOKEN` в основной README /
   `.env.example`, если он есть.

---

## Новые / изменённые файлы

**Новые**
- `apps/api/src/services/persistentStore.ts`
- `apps/api/src/services/txTrackerService.ts`
- `CHANGES.md`

**Изменённые (backend)**
- `apps/api/src/services/circleWalletService.ts`
- `apps/api/src/services/sessionWalletService.ts`
- `apps/api/src/routes/wallet.ts`
- `apps/api/src/dispatch.ts`

**Изменённые (frontend)**
- `apps/web/src/lib/wallet.tsx`
- `apps/web/src/lib/onchain.ts`
- `apps/web/src/components/FundUsdcPanel.tsx`
- `apps/web/src/components/MarketLiveChart.tsx` (из прошлой итерации — графики)
- `apps/web/src/nextjs/components/Header.tsx`
- `apps/web/src/nextjs/components/Footer.tsx`
- `apps/web/src/nextjs/components/WalletPopover.tsx`
- `apps/web/src/nextjs/shells/AppChrome.tsx`
- `apps/web/src/nextjs/shells/MarketDetailShell.tsx`
- `apps/web/src/nextjs/shells/PortfolioShell.tsx`
- `apps/web/src/nextjs/shells/LpShell.tsx`
