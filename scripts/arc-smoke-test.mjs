import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  formatUnits,
  getAddress,
  http,
  parseEventLogs,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const deploymentPath = process.env.PROBX_DEPLOYMENT_PATH ?? resolve(root, "apps/web/src/lib/deployment.json");
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
const rpcUrls = buildRpcUrls(deployment);
const rpcTransport = buildRpcTransport(rpcUrls);
const tradeKey = process.env.TRADE_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
const oracleKey = process.env.ORACLE_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
if (!tradeKey) throw new Error("TRADE_PRIVATE_KEY or PRIVATE_KEY is required for approve/buy/settle.");

const riskAmount = process.env.RISK_USDC ?? "0.1";
const boost = process.env.BOOST ?? "2";
const outcome = (process.env.OUTCOME ?? "YES").toUpperCase() === "NO" ? 2 : 1;
const resolveOutcome = (process.env.RESOLVE_OUTCOME ?? "YES").toUpperCase() === "NO" ? 2 : 1;
const backendUrl = process.env.BACKEND_URL?.replace(/\/$/, "");

const arcChain = defineChain({
  id: deployment.chainId,
  name: deployment.chainName ?? "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } },
  blockExplorers: { default: { name: "ArcScan", url: deployment.explorerUrl ?? "https://testnet.arcscan.app" } }
});

const tradeAccount = privateKeyToAccount(tradeKey);
const oracleAccount = oracleKey ? privateKeyToAccount(oracleKey) : undefined;
const publicClient = createPublicClient({ chain: arcChain, transport: rpcTransport });
const trader = createWalletClient({ account: tradeAccount, chain: arcChain, transport: rpcTransport });
const oracle = oracleAccount ? createWalletClient({ account: oracleAccount, chain: arcChain, transport: rpcTransport }) : undefined;

const usdcAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }
];

const engineAbi = [
  {
    type: "function",
    name: "quoteTicket",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "outcome", type: "uint8" },
      { name: "riskAmount", type: "uint256" },
      { name: "boostBps", type: "uint256" }
    ],
    outputs: [{
      name: "quote",
      type: "tuple",
      components: [
        { name: "price", type: "uint256" },
        { name: "payout", type: "uint256" },
        { name: "requiredReserve", type: "uint256" },
        { name: "fee", type: "uint256" },
        { name: "totalDebit", type: "uint256" },
        { name: "maxAvailableBoostBps", type: "uint256" },
        { name: "accepted", type: "bool" },
        { name: "reason", type: "string" }
      ]
    }]
  },
  {
    type: "function",
    name: "buyTicket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "outcome", type: "uint8" },
      { name: "riskAmount", type: "uint256" },
      { name: "boostBps", type: "uint256" }
    ],
    outputs: [{ name: "ticketId", type: "uint256" }]
  },
  { type: "function", name: "settleTicket", stateMutability: "nonpayable", inputs: [{ name: "ticketId", type: "uint256" }], outputs: [] },
  {
    type: "event",
    name: "TicketBought",
    inputs: [
      { name: "ticketId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "market", type: "address", indexed: true },
      { name: "outcome", type: "uint8", indexed: false },
      { name: "riskAmount", type: "uint256", indexed: false },
      { name: "boostBps", type: "uint256", indexed: false },
      { name: "payout", type: "uint256", indexed: false },
      { name: "reserve", type: "uint256", indexed: false }
    ]
  }
];

const marketAbi = [
  { type: "function", name: "status", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  { type: "function", name: "openTime", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "lockTime", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "observationStart", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "canBuy", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "resolve", stateMutability: "nonpayable", inputs: [{ name: "outcome", type: "uint8" }], outputs: [] }
];

const ticketAbi = [
  {
    type: "function",
    name: "getTicket",
    stateMutability: "view",
    inputs: [{ name: "ticketId", type: "uint256" }],
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "market", type: "address" },
        { name: "owner", type: "address" },
        { name: "outcome", type: "uint8" },
        { name: "riskAmount", type: "uint256" },
        { name: "boostBps", type: "uint256" },
        { name: "quotedPrice", type: "uint256" },
        { name: "payout", type: "uint256" },
        { name: "reservedAmount", type: "uint256" },
        { name: "fee", type: "uint256" },
        { name: "status", type: "uint8" }
      ]
    }]
  }
];

console.log(`Trader: ${tradeAccount.address}`);
if (oracleAccount) console.log(`Oracle/admin signer: ${oracleAccount.address}`);
await checkBackend();

const blockNumber = await publicClient.getBlockNumber();
const chainId = await publicClient.getChainId();
console.log(`Arc RPC OK. chainId=${chainId}, block=${blockNumber}`);
if (chainId !== deployment.chainId) throw new Error(`Wrong chainId: expected ${deployment.chainId}, got ${chainId}`);

const market = await pickMarket();
console.log(`Using market ${market.id}: ${market.address}`);

const [usdcBalance, allowance] = await Promise.all([
  publicClient.readContract({ address: getAddress(deployment.usdc), abi: usdcAbi, functionName: "balanceOf", args: [tradeAccount.address] }),
  publicClient.readContract({ address: getAddress(deployment.usdc), abi: usdcAbi, functionName: "allowance", args: [tradeAccount.address, getAddress(deployment.microBoostEngine)] })
]);
console.log(`USDC balance: ${formatUnits(usdcBalance, 6)}; allowance: ${formatUnits(allowance, 6)}`);

const risk = parseUnits(riskAmount, 6);
const boostBps = BigInt(Math.round(Number(boost) * 10_000));
const quote = await publicClient.readContract({
  address: getAddress(deployment.microBoostEngine),
  abi: engineAbi,
  functionName: "quoteTicket",
  args: [market.address, outcome, risk, boostBps],
  account: tradeAccount.address
});
console.log(`Quote: accepted=${quote.accepted}, reason=${quote.reason}, totalDebit=${formatUnits(quote.totalDebit, 6)}, payout=${formatUnits(quote.payout, 6)}`);
if (!quote.accepted) throw new Error(`Quote rejected: ${quote.reason}`);
if (usdcBalance < quote.totalDebit) throw new Error("Insufficient USDC for smoke test.");

if (allowance < quote.totalDebit) {
  const approveHash = await trader.writeContract({
    address: getAddress(deployment.usdc),
    abi: usdcAbi,
    functionName: "approve",
    args: [getAddress(deployment.microBoostEngine), quote.totalDebit]
  });
  await wait(approveHash, "approve USDC");
} else {
  console.log("Approve skipped; allowance is enough.");
}

const buyHash = await trader.writeContract({
  address: getAddress(deployment.microBoostEngine),
  abi: engineAbi,
  functionName: "buyTicket",
  args: [market.address, outcome, risk, boostBps]
});
const buyReceipt = await wait(buyHash, "buy ticket");
const ticketId = readTicketId(buyReceipt.logs);
console.log(`Bought ticket #${ticketId}`);
await checkPortfolio(ticketId);

await maybeResolve(market);
await maybeSettle(ticketId);
console.log("Smoke test completed.");

async function pickMarket() {
  const candidates = deployedDemoMarkets();
  const explicit = process.env.MARKET_ID_OR_ADDRESS;
  const selected = explicit
    ? candidates.find((item) => item.id === explicit || item.market.toLowerCase() === explicit.toLowerCase()) ?? { id: explicit, market: explicit }
    : candidates.find((item) => item.role === "near_lock") ?? candidates.find((item) => item.role === "open") ?? candidates[0];
  if (!selected?.market) throw new Error("No demo market configured. Run scripts/arc-demo-markets.mjs first or set MARKET_ID_OR_ADDRESS.");
  const address = getAddress(selected.market);
  const [status, canBuy, openTime, lockTime, observationStart] = await Promise.all([
    publicClient.readContract({ address, abi: marketAbi, functionName: "status" }),
    publicClient.readContract({ address, abi: marketAbi, functionName: "canBuy" }),
    publicClient.readContract({ address, abi: marketAbi, functionName: "openTime" }),
    publicClient.readContract({ address, abi: marketAbi, functionName: "lockTime" }),
    publicClient.readContract({ address, abi: marketAbi, functionName: "observationStart" })
  ]);
  console.log(`Market status=${statusName(Number(status))}, canBuy=${canBuy}, lock=${new Date(Number(lockTime) * 1000).toISOString()}`);
  if (!canBuy) throw new Error("Selected market is not buyable. Create fresh demo markets or pass an OPEN market via MARKET_ID_OR_ADDRESS.");
  return { id: selected.id ?? address, address, openTime, lockTime, observationStart };
}

async function maybeResolve(market) {
  if (process.env.SKIP_RESOLVE === "1") return;
  if (!oracle) {
    console.log("Resolve skipped: ORACLE_PRIVATE_KEY is not set.");
    return;
  }
  const [owner, oracleAddress] = await Promise.all([
    publicClient.readContract({ address: market.address, abi: marketAbi, functionName: "owner" }),
    publicClient.readContract({ address: market.address, abi: marketAbi, functionName: "oracle" })
  ]);
  const signer = oracle.account.address.toLowerCase();
  if (signer !== owner.toLowerCase() && signer !== oracleAddress.toLowerCase()) {
    console.log(`Resolve skipped: signer is not owner/oracle for this market. owner=${owner}, oracle=${oracleAddress}`);
    return;
  }
  const waitMs = Math.max(0, Number(market.observationStart - BigInt(Math.floor(Date.now() / 1000))) + 2) * 1000;
  if (waitMs > 0) {
    console.log(`Waiting ${Math.ceil(waitMs / 1000)}s for observation window...`);
    await sleep(waitMs);
  }
  const resolveHash = await oracle.writeContract({
    address: market.address,
    abi: marketAbi,
    functionName: "resolve",
    args: [resolveOutcome]
  });
  await wait(resolveHash, `resolve ${resolveOutcome === 1 ? "YES" : "NO"}`);
}

async function maybeSettle(ticketId) {
  if (process.env.SKIP_SETTLE === "1") return;
  const before = await publicClient.readContract({
    address: getAddress(deployment.positionTicket),
    abi: ticketAbi,
    functionName: "getTicket",
    args: [ticketId]
  });
  if (Number(before.status) !== 1) {
    console.log(`Settle skipped: ticket status is ${before.status}.`);
    return;
  }
  const settleHash = await trader.writeContract({
    address: getAddress(deployment.microBoostEngine),
    abi: engineAbi,
    functionName: "settleTicket",
    args: [ticketId]
  });
  await wait(settleHash, "settle ticket");
  const after = await publicClient.readContract({
    address: getAddress(deployment.positionTicket),
    abi: ticketAbi,
    functionName: "getTicket",
    args: [ticketId]
  });
  console.log(`Ticket status after settlement: ${after.status}`);
}

async function checkBackend() {
  if (!backendUrl) return;
  for (const path of ["/health", "/api/contracts", "/api/markets", "/api/lp/stats"]) {
    const response = await fetch(`${backendUrl}${path}`);
    console.log(`${path}: HTTP ${response.status}`);
    if (!response.ok) throw new Error(`Backend check failed: ${path}`);
  }
}

async function checkPortfolio(ticketId) {
  if (!backendUrl) return;
  const response = await fetch(`${backendUrl}/api/users/${tradeAccount.address}/tickets`);
  console.log(`/api/users/:address/tickets: HTTP ${response.status}`);
  if (!response.ok) throw new Error("Portfolio endpoint failed.");
  const tickets = await response.json();
  const found = tickets.some((ticket) => String(ticket.id).endsWith(String(ticketId)));
  if (!found) throw new Error(`Ticket #${ticketId} was not found in backend portfolio response.`);
}

function deployedDemoMarkets() {
  if (Array.isArray(deployment.demoMarkets) && deployment.demoMarkets.length > 0) return deployment.demoMarkets;
  return [{ id: "mkt_demo_green", role: "legacy", market: deployment.demoMarket }];
}

function readTicketId(logs) {
  const parsed = parseEventLogs({ abi: engineAbi, logs, eventName: "TicketBought" });
  const ticketId = parsed[0]?.args.ticketId;
  if (!ticketId) throw new Error("TicketBought log missing; cannot continue.");
  return ticketId;
}


function buildRpcUrls(config) {
  const envUrls = (process.env.ARC_RPC_URLS ?? process.env.NEXT_PUBLIC_ARC_RPC_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return Array.from(new Set([
    ...envUrls,
    ...(Array.isArray(config?.rpcUrls) ? config.rpcUrls : []),
    config?.rpcUrl,
    "https://rpc.testnet.arc.network",
    "https://arc-testnet.drpc.org"
  ].filter(Boolean))).filter(isStableArcRpcUrl);
}

function isStableArcRpcUrl(url) {
  return !url.includes("quicknode") && !url.includes("blockdaemon");
}

function buildRpcTransport(urls) {
  const transports = urls.map((url) => http(url));
  return transports.length === 1 ? transports[0] : fallback(transports, { rank: false });
}

async function wait(hash, label) {
  console.log(`${label}: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  return receipt;
}

function statusName(status) {
  return ["CREATED", "OPEN", "LOCKED", "RESOLVED", "CANCELLED", "ARCHIVED"][status] ?? `UNKNOWN_${status}`;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
