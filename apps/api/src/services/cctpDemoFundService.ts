/**
 * Server-side CCTP demo fund: burn from CCTP_SOURCE_PRIVATE_KEY on Base Sepolia → mint on Arc.
 *
 * Lifecycle (fail-closed on shared runtime):
 *   created → approving → signed → broadcast → confirmed | failed
 * The op record is written before any on-chain action, and the burn is signed and its
 * hash persisted *before* it is broadcast — so no crash point leaves a burn on the
 * network that we have no record of. Recovery re-sends the stored raw transaction.
 *
 * Quota: durable reservation via Redis Lua (dual counters + reservation id in one call),
 * sized to totalBurn (amount + CCTP fee) because that is what the treasury actually pays.
 * The op lock is a renewed lease, not a fixed TTL held across RPC waits.
 */
import {
  createHash,
  randomBytes
} from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseUnits,
  recoverMessageAddress
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { CCTP, quoteForwardingBurn } from "./cctpService.js";
import {
  NamespaceStore,
  acquireLock,
  renewLock,
  atomicDecrQuota,
  atomicIncrQuota,
  kvEval,
  persistenceMode,
  releaseLock,
  requireDurableKv,
  setIfAbsent
} from "./persistentStore.js";
import { isTransactionRevertedError, waitSuccessfulReceipt } from "./txReceipt.js";

const FORWARDING_HOOK =
  "0x636374702d666f72776172640000000000000000000000000000000000000000" as const;

const DEMO_FUND_CHAIN_ID = 5042002;
const DEMO_FUND_DOMAIN = "probx";

/**
 * Global lock for any write from the shared treasury account. Per-operation locks do not
 * serialise these: different users produce different op keys but spend the same nonce
 * sequence and the same ERC-20 allowance.
 */
const TREASURY_WRITE_LOCK = "cctp-treasury-writes";

const erc20AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

/**
 * `signed` sits between approving and broadcast: the burn is signed and its hash is
 * already durable, but it may not have reached the network yet. Recovery re-sends the
 * stored raw transaction rather than signing a new one — same nonce and signature mean
 * the same hash, so a re-send is a no-op if it already landed.
 */
type OpStatus = "created" | "approving" | "signed" | "broadcast" | "confirmed" | "failed";

type DemoFundOp = {
  clientKey: string;
  serverKey: string;
  principal: string;
  mintTo: string;
  requestedAmount: string;
  networkFee?: string;
  maxFee?: string;
  totalBurn?: string;
  chainId: number;
  status: OpStatus;
  burnTxHash?: string;
  /** Raw signed burn tx, persisted before broadcast so recovery re-sends it verbatim. */
  signedBurnTx?: string;
  /** Nonce the burn was signed with — a re-sign at a different nonce would double-burn. */
  burnNonce?: number;
  approveTxHash?: string;
  reservationId?: string;
  at: string;
  updatedAt: string;
  error?: string;
};

const opStore = new NamespaceStore<DemoFundOp>("cctp-demo-ops-v2");
const reservationStore = new NamespaceStore<{
  id: string;
  addrKey: string;
  day: string;
  amount: string;
  status: "held" | "finalized" | "released";
  at: string;
}>("cctp-quota-reservations");

function dailyCapUsdc(): bigint {
  return parseUnits((process.env.CCTP_DEMO_DAILY_PER_ADDRESS || "25").trim() || "25", 6);
}

function globalDailyCapUsdc(): bigint {
  return parseUnits((process.env.CCTP_DEMO_DAILY_GLOBAL || "500").trim() || "500", 6);
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Normalize principal for idempotency binding.
 * Email sessions use `email:user@host` (not an address — addresses are free to create).
 * Injected wallets use a 0x address.
 */
export function normalizePrincipal(principal: string): string {
  const p = principal.trim();
  if (p.toLowerCase().startsWith("email:")) {
    return p.toLowerCase();
  }
  if (p.includes("@")) {
    return `email:${p.toLowerCase()}`;
  }
  return getAddress(p).toLowerCase();
}

/** Server key binds client UUID to principal + mintTo + amount + chainId. */
export function computeServerIdempotencyKey(params: {
  clientKey: string;
  principal: string;
  mintTo: string;
  requestedAmount: string;
  chainId?: number;
}): string {
  const payload = [
    params.clientKey.trim(),
    normalizePrincipal(params.principal),
    getAddress(params.mintTo).toLowerCase(),
    params.requestedAmount,
    String(params.chainId ?? DEMO_FUND_CHAIN_ID)
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Give back a reservation left behind by an operation that died before burning.
 *
 * A crash in `created`/`approving` leaves counters incremented with no transaction to
 * show for it. The retry then reserves again, so one funding consumes the daily cap
 * twice and the treasury budget drifts down with every interrupted attempt. Keyed on
 * the reservation's own status so repeated calls are harmless.
 */
async function releaseStaleReservation(reservationId: string): Promise<void> {
  const row = await reservationStore.get(reservationId).catch(() => null);
  if (!row || row.status !== "held") return;
  await atomicDecrQuota({ addrKey: row.addrKey, day: row.day, amount: row.amount });
  await reservationStore
    .set(reservationId, { ...row, status: "released", at: new Date().toISOString() })
    .catch(() => undefined);
}

/**
 * Atomic quota reservation. On KV: single Lua checks both caps, increments both,
 * stores reservation id. On file fallback: short dual lock then write.
 * Does NOT hold the lock after return — reservation record is the durable hold.
 */
async function reserveQuota(
  address: string,
  amount: bigint
): Promise<{ reservationId: string; release: () => Promise<void>; finalize: () => Promise<void> }> {
  const addrKey = address.toLowerCase();
  const day = dayKey();
  const amountStr = amount.toString();
  const reservationId = randomBytes(12).toString("hex");

  if (persistenceMode() === "kv") {
    // Counters and the reservation record move together — see atomicIncrQuota.
    const result = await atomicIncrQuota({
      addrKey,
      day,
      amount: amountStr,
      perCap: dailyCapUsdc().toString(),
      globCap: globalDailyCapUsdc().toString(),
      reservationId,
      reservationJson: JSON.stringify({
        id: reservationId,
        addrKey,
        day,
        amount: amountStr,
        status: "held",
        at: new Date().toISOString()
      })
    });
    if (!result.ok) {
      if (result.reason === "per-cap") {
        throw new Error(
          `Daily demo fund limit reached for this address (${formatUnits(dailyCapUsdc(), 6)} USDC/day).`
        );
      }
      if (result.reason === "glob-cap") {
        throw new Error(
          `Demo treasury daily global cap reached (${formatUnits(globalDailyCapUsdc(), 6)} USDC).`
        );
      }
      throw new Error(`Demo fund quota unavailable (${result.reason || "unknown"}).`);
    }
    // Reservation record was written inside the same Lua transaction as the counters.
    let terminal = false;
    return {
      reservationId,
      release: async () => {
        if (terminal) return;
        terminal = true;
        await atomicDecrQuota({ addrKey, day, amount: amountStr });
        await reservationStore.set(reservationId, {
          id: reservationId,
          addrKey,
          day,
          amount: amountStr,
          status: "released",
          at: new Date().toISOString()
        });
      },
      finalize: async () => {
        if (terminal) return;
        terminal = true;
        await reservationStore.set(reservationId, {
          id: reservationId,
          addrKey,
          day,
          amount: amountStr,
          status: "finalized",
          at: new Date().toISOString()
        });
      }
    };
  }

  // Local-dev file fallback under short locks (not held across chain ops).
  const lockAddr = `cctp-quota-addr:${addrKey}`;
  const lockGlob = "cctp-quota-global";
  const tokenA = randomBytes(8).toString("hex");
  const tokenG = randomBytes(8).toString("hex");
  if (!(await acquireLock(lockAddr, 15_000, tokenA))) {
    throw new Error("Demo fund busy for this address — retry in a moment.");
  }
  if (!(await acquireLock(lockGlob, 15_000, tokenG))) {
    await releaseLock(lockAddr, tokenA);
    throw new Error("Demo treasury busy — retry in a moment.");
  }
  try {
    const dailyStore = new NamespaceStore<{ day: string; used: string }>("cctp-demo-fund-daily");
    const globalStore = new NamespaceStore<{ day: string; used: string }>("cctp-demo-fund-global");
    const readUsed = async (
      store: NamespaceStore<{ day: string; used: string }>,
      key: string
    ): Promise<bigint> => {
      const row = await store.get(key);
      if (!row || row.day !== day) return 0n;
      try {
        return BigInt(row.used || "0");
      } catch {
        return 0n;
      }
    };
    const perUsed = await readUsed(dailyStore, addrKey);
    const perCap = dailyCapUsdc();
    if (perUsed + amount > perCap) {
      throw new Error(
        `Daily demo fund limit reached for this address (${formatUnits(perCap, 6)} USDC/day).`
      );
    }
    const globUsed = await readUsed(globalStore, "treasury");
    const globCap = globalDailyCapUsdc();
    if (globUsed + amount > globCap) {
      throw new Error(
        `Demo treasury daily global cap reached (${formatUnits(globCap, 6)} USDC).`
      );
    }
    await dailyStore.set(addrKey, { day, used: (perUsed + amount).toString() });
    await globalStore.set("treasury", { day, used: (globUsed + amount).toString() });
    await reservationStore.set(reservationId, {
      id: reservationId,
      addrKey,
      day,
      amount: amountStr,
      status: "held",
      at: new Date().toISOString()
    });
  } finally {
    await releaseLock(lockGlob, tokenG);
    await releaseLock(lockAddr, tokenA);
  }

  let terminal = false;
  return {
    reservationId,
    release: async () => {
      if (terminal) return;
      terminal = true;
      const dailyStore = new NamespaceStore<{ day: string; used: string }>("cctp-demo-fund-daily");
      const globalStore = new NamespaceStore<{ day: string; used: string }>("cctp-demo-fund-global");
      const rowP = await dailyStore.get(addrKey);
      if (rowP?.day === day) {
        const p = BigInt(rowP.used || "0");
        await dailyStore.set(addrKey, {
          day,
          used: (p > amount ? p - amount : 0n).toString()
        });
      }
      const rowG = await globalStore.get("treasury");
      if (rowG?.day === day) {
        const g = BigInt(rowG.used || "0");
        await globalStore.set("treasury", {
          day,
          used: (g > amount ? g - amount : 0n).toString()
        });
      }
      await reservationStore.set(reservationId, {
        id: reservationId,
        addrKey,
        day,
        amount: amountStr,
        status: "released",
        at: new Date().toISOString()
      });
    },
    finalize: async () => {
      if (terminal) return;
      terminal = true;
      await reservationStore.set(reservationId, {
        id: reservationId,
        addrKey,
        day,
        amount: amountStr,
        status: "finalized",
        at: new Date().toISOString()
      });
    }
  };
}

export function cctpSourceConfigured(): boolean {
  return Boolean(process.env.CCTP_SOURCE_PRIVATE_KEY);
}

export function cctpSourceAddress(): `0x${string}` | null {
  const key = process.env.CCTP_SOURCE_PRIVATE_KEY;
  if (!key) return null;
  try {
    const pk = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    return privateKeyToAccount(pk).address;
  } catch {
    return null;
  }
}

/** Canonical message for injected-wallet EIP-191 (includes expiry so signatures expire). */
export function demoFundAuthMessage(params: {
  mintTo: string;
  amountUsdc: string;
  nonce: string;
  expiresAt: number;
  chainId?: number;
}): string {
  return [
    "ProbX CCTP Demo Funding",
    `wallet: ${getAddress(params.mintTo)}`,
    `amount: ${params.amountUsdc}`,
    `nonce: ${params.nonce}`,
    `chainId: ${params.chainId ?? DEMO_FUND_CHAIN_ID}`,
    `expiresAt: ${params.expiresAt}`,
    `domain: ${DEMO_FUND_DOMAIN}`
  ].join("\n");
}

/** Consume a one-time nonce (atomic SET NX, long TTL). Call only after op-store miss. */
export async function consumeDemoFundNonce(nonce: string): Promise<void> {
  const n = (nonce || "").trim();
  if (!/^[a-fA-F0-9]{16,64}$/.test(n)) throw new Error("Invalid demo-fund nonce.");
  const ok = await setIfAbsent(`cctp-nonce:${n}`, { usedAt: new Date().toISOString() }, 7 * 24 * 3600);
  if (!ok) throw new Error("Demo-fund nonce already used.");
}

/** Verify EIP-191 without consuming nonce (safe for retries after lost HTTP response). */
export async function verifyInjectedDemoFundAuth(params: {
  mintTo: string;
  amountUsdc: string;
  nonce: string;
  signature: string;
  expiresAt: number | string;
  /** When false, only verify signature (default true for backward compat). */
  consumeNonce?: boolean;
}): Promise<`0x${string}`> {
  requireDurableKv("CCTP demo fund auth");
  const expiresAt = Number(params.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    throw new Error("Demo-fund signature expired. Request a new signature.");
  }
  if (expiresAt > Math.floor(Date.now() / 1000) + 15 * 60) {
    throw new Error("Demo-fund expiresAt too far in the future.");
  }

  const message = demoFundAuthMessage({
    mintTo: params.mintTo,
    amountUsdc: params.amountUsdc,
    nonce: params.nonce,
    expiresAt
  });
  const recovered = await recoverMessageAddress({
    message,
    signature: params.signature as `0x${string}`
  });
  if (getAddress(recovered) !== getAddress(params.mintTo)) {
    throw new Error("Signature does not match mintTo address.");
  }
  if (params.consumeNonce !== false) {
    await consumeDemoFundNonce(params.nonce);
  }
  return getAddress(recovered);
}

/**
 * Re-sending an identical signed transaction is safe: same nonce and signature produce
 * the same hash, so the network either accepts it once or reports that it already knows
 * it. Those two rejections mean "already on chain", which is exactly what we want — any
 * other error is real and must surface.
 */
async function broadcastSignedBurn(
  client: {
    sendRawTransaction: (a: { serializedTransaction: `0x${string}` }) => Promise<`0x${string}`>;
    getTransaction?: (a: { hash: `0x${string}` }) => Promise<unknown>;
  },
  signedTx: string,
  expectedHash: `0x${string}`
): Promise<void> {
  try {
    await client.sendRawTransaction({ serializedTransaction: signedTx as `0x${string}` });
    return;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).toLowerCase();

    // "already known" identifies *this* transaction — the node has our exact bytes.
    if (message.includes("already known") || message.includes("already exists")) return;

    // "nonce too low" / "underpriced" only say that *some* transaction occupies this
    // nonce. On a shared treasury that could be a different burn entirely, so treating
    // it as success would report a hash that will never exist. Verify by hash instead.
    const nonceTaken =
      message.includes("nonce too low") || message.includes("transaction underpriced");
    if (!nonceTaken) throw err;

    if (!client.getTransaction) throw err;
    try {
      const found = await client.getTransaction({ hash: expectedHash });
      if (found) return; // our transaction really is on chain
    } catch {
      // fall through — not found
    }
    throw new Error(
      `Burn nonce conflict: another transaction occupies this nonce and ${expectedHash} is not on chain. ` +
        `Treasury writes must be serialised; retry with the same idempotencyKey.`
    );
  }
}

function opResponse(op: DemoFundOp, sourceAddress: `0x${string}`) {
  return {
    mintTo: getAddress(op.mintTo) as `0x${string}`,
    amount: op.requestedAmount,
    requestedAmount: op.requestedAmount,
    networkFee: op.networkFee || "0",
    maxFee: op.maxFee || "0",
    totalBurn: op.totalBurn || op.requestedAmount,
    burnTxHash: (op.burnTxHash || "0x") as `0x${string}`,
    sourceAddress,
    status: "burned_pending_mint" as const,
    domain: CCTP.domains.baseSepolia,
    opStatus: op.status
  };
}

/**
 * Burn only — client polls GET /api/cctp/status.
 * Caller must already have authorized mintTo (session or EIP-191).
 */
export async function demoFundViaCctp(params: {
  mintTo: string;
  amountUsdc?: string;
  /** Client UUID per user action — retries return the same burnTxHash. */
  idempotencyKey?: string;
  /** Authenticated principal (session wallet or EIP-191 signer). Defaults to mintTo. */
  principal?: string;
  /** Injected path: consume EIP-191 nonce only when starting a new burn. */
  claimNonce?: string;
}): Promise<{
  mintTo: `0x${string}`;
  amount: string;
  requestedAmount: string;
  networkFee: string;
  maxFee: string;
  totalBurn: string;
  burnTxHash: `0x${string}`;
  sourceAddress: `0x${string}`;
  status: "burned_pending_mint";
  domain: number;
  opStatus?: string;
}> {
  requireDurableKv("CCTP demo fund");
  const key = process.env.CCTP_SOURCE_PRIVATE_KEY;
  if (!key) throw new Error("CCTP_SOURCE_PRIVATE_KEY not set on API.");

  const mintTo = getAddress(params.mintTo);
  // Prefer explicit principal (email:… or address); default mintTo only for legacy callers.
  const principal = normalizePrincipal(params.principal || params.mintTo);
  const amountHuman = params.amountUsdc ?? "2";
  const amount = parseUnits(amountHuman, 6);
  if (amount <= 0n) throw new Error("amount must be > 0");

  const maxPerCall = parseUnits((process.env.CCTP_DEMO_MAX_PER_CALL || "10").trim() || "10", 6);
  if (amount > maxPerCall) {
    throw new Error(`Demo fund is limited to ${formatUnits(maxPerCall, 6)} USDC per call.`);
  }

  const clientKey = (params.idempotencyKey || "").trim();
  if (!clientKey || clientKey.length < 8) {
    throw new Error("idempotencyKey required (client UUID per user action).");
  }

  const requestedAmount = amount.toString();
  const serverKey = computeServerIdempotencyKey({
    clientKey,
    principal,
    mintTo,
    requestedAmount,
    chainId: DEMO_FUND_CHAIN_ID
  });

  const sourceFallback =
    cctpSourceAddress() ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`);

  // Reject client key reused with different principal/mintTo/amount.
  const priorByClient = await opStore.get(`client:${clientKey}`);
  if (priorByClient && priorByClient.serverKey !== serverKey) {
    throw new Error(
      "idempotencyKey already bound to a different principal, mintTo, or amount. Use a new UUID."
    );
  }

  const prior = (await opStore.get(serverKey)) ?? priorByClient;
  if (prior?.burnTxHash && prior.status !== "failed") {
    // Binding check on retry
    if (
      getAddress(prior.mintTo) !== mintTo ||
      prior.requestedAmount !== requestedAmount ||
      normalizePrincipal(prior.principal) !== principal
    ) {
      throw new Error("idempotencyKey parameters do not match the original operation.");
    }
    // `signed` means we have a durable hash but cannot prove the tx reached the network
    // (we may have died between persisting and broadcasting). Re-send the stored raw tx
    // rather than handing the client a hash that may not exist anywhere.
    if (prior.status === "signed" && prior.signedBurnTx) {
      const rpc = process.env.BASE_SEPOLIA_RPC_URL || CCTP.chains.baseSepolia.rpcUrl;
      const recoveryClient = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
      await broadcastSignedBurn(
        recoveryClient,
        prior.signedBurnTx,
        prior.burnTxHash as `0x${string}`
      );
      const rebroadcast: DemoFundOp = {
        ...prior,
        status: "broadcast",
        updatedAt: new Date().toISOString()
      };
      await opStore.set(serverKey, rebroadcast);
      await opStore.set(`client:${clientKey}`, rebroadcast);
      return opResponse(rebroadcast, sourceFallback);
    }
    return opResponse(prior, sourceFallback);
  }

  const opLockToken = randomBytes(8).toString("hex");
  const opLockKey = `cctp-op:${serverKey}`;
  let lockHeld = false;
  let quota: Awaited<ReturnType<typeof reserveQuota>> | null = null;
  let burnTxHash: `0x${string}` | undefined;

  // Every funding burns from the SAME treasury EOA, but the op lock is keyed per
  // operation — so two different users hold two different locks and race on one account:
  // their approves overwrite each other's allowance and their transactions collide on
  // nonce. Treasury writes therefore take a second, global lock. Acquisition order is
  // always op → treasury, never the reverse, so two workers cannot deadlock.
  const treasuryLockKey = TREASURY_WRITE_LOCK;
  const treasuryLockToken = randomBytes(8).toString("hex");
  let treasuryLockHeld = false;

  // A fixed TTL cannot cover approve + burn + receipts on a slow testnet: it expires
  // mid-flight and a second worker starts the same burn. Hold short leases and renew
  // them while we work, so a lock outlives the operation when we are alive and is
  // released quickly when we are not.
  const LEASE_MS = 45_000;
  const RENEW_EVERY_MS = 15_000;
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Set when a renewal fails. A lost lease means another worker may already have taken
   * the operation over, so continuing to sign or broadcast would be exactly the double
   * burn the lock exists to prevent. Renewing blindly (ignoring the result) makes the
   * lease decorative — the fence has to be checked before every side effect.
   */
  let leaseLost = false;
  const startLease = () => {
    leaseTimer = setInterval(() => {
      void (async () => {
        const okOp = await renewLock(opLockKey, LEASE_MS, opLockToken).catch(() => false);
        const okTreasury = treasuryLockHeld
          ? await renewLock(treasuryLockKey, LEASE_MS, treasuryLockToken).catch(() => false)
          : true;
        if (!okOp || !okTreasury) leaseLost = true;
      })();
    }, RENEW_EVERY_MS);
    // Never keep the process alive just to renew a lock.
    leaseTimer.unref?.();
  };
  const stopLease = () => {
    if (leaseTimer) clearInterval(leaseTimer);
    leaseTimer = undefined;
  };
  /** Fence: refuse to produce any further on-chain effect once the lease is gone. */
  const assertLeaseHeld = (stage: string) => {
    if (leaseLost) {
      throw new Error(
        `Lost demo-fund lease before ${stage} — another worker may own this operation. Retry with the same idempotencyKey.`
      );
    }
  };

  try {
    if (!(await acquireLock(opLockKey, LEASE_MS, opLockToken))) {
      await new Promise((r) => setTimeout(r, 1500));
      const again = await opStore.get(serverKey);
      if (again?.burnTxHash && again.status !== "failed") {
        return opResponse(again, sourceFallback);
      }
      throw new Error("Demo fund operation in progress — retry shortly.");
    }
    lockHeld = true;
    startLease();

    // Re-check under lock
    const underLock = await opStore.get(serverKey);
    if (underLock?.burnTxHash && underLock.status !== "failed") {
      return opResponse(underLock, sourceFallback);
    }

    // A previous attempt died before it burned (created/approving/failed). Its quota
    // reservation is still counted against the caps, and we are about to make another
    // one — hand the old one back first so an interrupted funding does not consume the
    // daily budget twice.
    if (underLock?.reservationId && !underLock.burnTxHash) {
      await releaseStaleReservation(underLock.reservationId);
    }

    // Claim nonce for injected path only when starting a new burn.
    const claimNonce = params.claimNonce?.trim();
    if (claimNonce) {
      await consumeDemoFundNonce(claimNonce);
    }

    // Create op record BEFORE any chain action (crash recovery).
    const nowIso = new Date().toISOString();
    let op: DemoFundOp = {
      clientKey,
      serverKey,
      principal,
      mintTo,
      requestedAmount,
      chainId: DEMO_FUND_CHAIN_ID,
      status: "created",
      at: nowIso,
      updatedAt: nowIso
    };
    await opStore.set(serverKey, op);
    await opStore.set(`client:${clientKey}`, op);

    const pk = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    const account = privateKeyToAccount(pk);
    const rpc = process.env.BASE_SEPOLIA_RPC_URL || CCTP.chains.baseSepolia.rpcUrl;

    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpc)
    });
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(rpc)
    });

    // Quote first: the treasury is debited totalBurn (amount + CCTP fee), so that is
    // what the daily caps must account for. Reserving only `amount` lets the fee
    // escape the cap and lets actual spend drift above the configured ceiling.
    const quote = await quoteForwardingBurn(amount, CCTP.domains.baseSepolia);
    const totalBurn = BigInt(quote.totalBurn);
    const maxFee = BigInt(quote.maxFee);
    const networkFee = BigInt(quote.forwardFee || "0");

    op = {
      ...op,
      networkFee: networkFee.toString(),
      maxFee: maxFee.toString(),
      totalBurn: totalBurn.toString(),
      updatedAt: new Date().toISOString()
    };
    await opStore.set(serverKey, op);

    // Reserve quota (durable reservation — not a long lock).
    quota = await reserveQuota(mintTo, totalBurn);
    op = {
      ...op,
      reservationId: quota.reservationId,
      status: "approving",
      updatedAt: new Date().toISOString()
    };
    await opStore.set(serverKey, op);

    const usdc = CCTP.usdc.baseSepolia;
    const messenger = CCTP.tokenMessengerV2;
    const mintRecipient = `0x${mintTo.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
    const destinationCaller = `0x${"0".repeat(64)}` as `0x${string}`;

    // ── Treasury-serialised section ────────────────────────────────────────────
    // Everything that spends the treasury's nonce sequence or its allowance happens
    // under one global lock, held until the burn is mined. Releasing at broadcast is
    // not enough: the next worker could read a nonce from a node that has not yet seen
    // our pending transaction and sign a colliding one.
    assertLeaseHeld("treasury lock acquisition");
    if (!(await acquireLock(treasuryLockKey, LEASE_MS, treasuryLockToken))) {
      throw new Error("Demo treasury is busy with another funding — retry in a moment.");
    }
    treasuryLockHeld = true;

    // Approve only when the standing allowance cannot cover this burn. Re-approving on
    // every request is what made concurrent fundings clobber each other; it also burns
    // a nonce for nothing. The allowance stays exact — never unlimited.
    const currentAllowance = (await publicClient.readContract({
      address: usdc,
      abi: erc20AllowanceAbi,
      functionName: "allowance",
      args: [account.address, messenger]
    })) as bigint;

    if (currentAllowance < totalBurn) {
      const approveData = encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "approve",
            stateMutability: "nonpayable",
            inputs: [
              { name: "spender", type: "address" },
              { name: "amount", type: "uint256" }
            ],
            outputs: [{ name: "", type: "bool" }]
          }
        ],
        functionName: "approve",
        args: [messenger, totalBurn]
      });

      assertLeaseHeld("approve");
      const approveHash = await walletClient.sendTransaction({ to: usdc, data: approveData });
      op = {
        ...op,
        approveTxHash: approveHash,
        updatedAt: new Date().toISOString()
      };
      await opStore.set(serverKey, op);
      await waitSuccessfulReceipt(publicClient, approveHash);
    }

    const burnData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "depositForBurnWithHook",
          stateMutability: "nonpayable",
          inputs: [
            { name: "amount", type: "uint256" },
            { name: "destinationDomain", type: "uint32" },
            { name: "mintRecipient", type: "bytes32" },
            { name: "burnToken", type: "address" },
            { name: "destinationCaller", type: "bytes32" },
            { name: "maxFee", type: "uint256" },
            { name: "minFinalityThreshold", type: "uint32" },
            { name: "hookData", type: "bytes" }
          ],
          outputs: []
        }
      ],
      functionName: "depositForBurnWithHook",
      args: [
        totalBurn,
        CCTP.domains.arcTestnet,
        mintRecipient,
        usdc,
        destinationCaller,
        maxFee,
        quote.finalityThreshold || 1000,
        FORWARDING_HOOK
      ]
    });

    // Sign first, persist the hash, only then broadcast. Sending first leaves a window
    // where the burn is on the network but no record of it exists — a crash there makes
    // the retry sign a *second* burn at the next nonce. Signing is local, so the
    // remaining unprotected gap is microseconds instead of an RPC round-trip.
    assertLeaseHeld("burn signing");
    const burnRequest = await walletClient.prepareTransactionRequest({
      to: messenger,
      data: burnData
    });
    const signedBurnTx = await walletClient.signTransaction(
      burnRequest as Parameters<typeof walletClient.signTransaction>[0]
    );
    burnTxHash = keccak256(signedBurnTx);

    op = {
      ...op,
      burnTxHash,
      signedBurnTx,
      burnNonce: burnRequest.nonce === undefined ? undefined : Number(burnRequest.nonce),
      status: "signed",
      updatedAt: new Date().toISOString()
    };
    await opStore.set(serverKey, op);
    await opStore.set(`client:${clientKey}`, op);

    assertLeaseHeld("burn broadcast");
    await broadcastSignedBurn(publicClient, signedBurnTx, burnTxHash);

    op = { ...op, status: "broadcast", updatedAt: new Date().toISOString() };
    await opStore.set(serverKey, op);
    await opStore.set(`client:${clientKey}`, op);

    try {
      await waitSuccessfulReceipt(publicClient, burnTxHash);
    } catch (receiptErr) {
      if (isTransactionRevertedError(receiptErr)) {
        op = {
          ...op,
          status: "failed",
          error: "burn reverted",
          updatedAt: new Date().toISOString()
        };
        await opStore.set(serverKey, op);
        await quota.release();
        throw new Error(`CCTP burn reverted on-chain: ${burnTxHash}`);
      }
      // RPC timeout / unknown: keep reservation, return pending.
      await quota.finalize();
      return opResponse(op, account.address);
    }

    await quota.finalize();
    op = {
      ...op,
      status: "confirmed",
      updatedAt: new Date().toISOString()
    };
    await opStore.set(serverKey, op);
    await opStore.set(`client:${clientKey}`, op);
    return opResponse(op, account.address);
  } catch (e) {
    if (quota) {
      if (!burnTxHash) {
        await quota.release().catch(() => undefined);
      } else {
        await quota.finalize().catch(() => undefined);
      }
    }
    // Mark failed only if no burn was broadcast (safe to retry with same key after fix).
    if (!burnTxHash) {
      try {
        const failed: DemoFundOp = {
          clientKey,
          serverKey,
          principal,
          mintTo,
          requestedAmount,
          chainId: DEMO_FUND_CHAIN_ID,
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
          at: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await opStore.set(serverKey, failed);
      } catch {
        /* ignore */
      }
    }
    throw e;
  } finally {
    // Stop renewing before releasing, or the timer can resurrect an expired lease.
    stopLease();
    // Release in reverse acquisition order: treasury, then the operation.
    if (treasuryLockHeld) {
      await releaseLock(treasuryLockKey, treasuryLockToken).catch(() => undefined);
    }
    // Always release op lock (including early reserveQuota failures).
    if (lockHeld) {
      await releaseLock(opLockKey, opLockToken).catch(() => undefined);
    }
  }
}

/** Exposed for tests — dual-counter Lua path. */
export async function __testAtomicQuotaPathAvailable(): Promise<boolean> {
  if (persistenceMode() !== "kv") return false;
  try {
    await kvEval("return 1", [], []);
    return true;
  } catch {
    return false;
  }
}
