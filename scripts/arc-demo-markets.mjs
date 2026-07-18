import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  stringToHex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const deploymentPath = process.env.PROBX_DEPLOYMENT_PATH ?? resolve(root, "apps/web/src/lib/deployment.json");
const docsDeploymentPath = resolve(root, "docs/DEPLOYMENT_ARC_TESTNET.json");
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
const rpcUrls = buildRpcUrls(deployment);
const rpcTransport = buildRpcTransport(rpcUrls);

const ownerKey = process.env.OWNER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
if (!ownerKey) throw new Error("OWNER_PRIVATE_KEY or PRIVATE_KEY is required. Use the factory owner/deployer key.");

const arcChain = defineChain({
  id: deployment.chainId,
  name: deployment.chainName ?? "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } },
  blockExplorers: { default: { name: "ArcScan", url: deployment.explorerUrl ?? "https://testnet.arcscan.app" } }
});

const account = privateKeyToAccount(ownerKey);
const publicClient = createPublicClient({ chain: arcChain, transport: rpcTransport });
const walletClient = createWalletClient({ account, chain: arcChain, transport: rpcTransport });

const factoryAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "question", type: "string" },
      { name: "rulesHash", type: "bytes32" },
      { name: "openTime", type: "uint64" },
      { name: "lockTime", type: "uint64" },
      { name: "observationStart", type: "uint64" },
      { name: "observationEnd", type: "uint64" },
      { name: "yesPrice", type: "uint256" }
    ],
    outputs: [{ name: "market", type: "address" }]
  },
  {
    type: "event",
    name: "MarketCreated",
    inputs: [
      { name: "marketId", type: "uint256", indexed: true },
      { name: "market", type: "address", indexed: true },
      { name: "question", type: "string", indexed: false },
      { name: "metadataHash", type: "bytes32", indexed: true }
    ]
  }
];

const marketAbi = [
  { type: "function", name: "open", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "resolve", stateMutability: "nonpayable", inputs: [{ name: "outcome", type: "uint8" }], outputs: [] },
  { type: "function", name: "status", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] }
];

const factory = getAddress(deployment.marketFactory);
const factoryOwner = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "owner" });
if (factoryOwner.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(`This key is ${account.address}, but factory owner is ${factoryOwner}. Use the deployer/owner key to create demo markets.`);
}

const now = Math.floor(Date.now() / 1000);
const openLockSeconds = Math.max(Number(process.env.OPEN_LOCK_SECONDS ?? "3600"), 300);
const nearLockSeconds = Math.max(Number(process.env.NEAR_LOCK_SECONDS ?? "90"), 45);
const resolvedLockSeconds = Math.max(Number(process.env.RESOLVED_LOCK_SECONDS ?? "60"), 45);
const definitions = [
  {
    id: "mkt_demo_open",
    label: "OPEN demo market",
    role: "open",
    question: "Will the next demo signal be GREEN?",
    openOffset: -30,
    lockOffset: openLockSeconds,
    observeSeconds: 300,
    yesPrice: 500_000n
  },
  {
    id: "mkt_demo_near_lock",
    label: "Near-lock demo market",
    role: "near_lock",
    question: "Will the quick demo signal be GREEN?",
    openOffset: -10,
    lockOffset: nearLockSeconds,
    observeSeconds: 120,
    yesPrice: 500_000n
  },
  {
    id: "mkt_demo_resolved",
    label: "Resolved settlement demo market",
    role: "resolved",
    question: "Did the completed demo signal resolve GREEN?",
    openOffset: -30,
    lockOffset: resolvedLockSeconds,
    observeSeconds: 60,
    yesPrice: 500_000n,
    resolveOutcome: 1
  }
];

const demoMarkets = [];
let firstCreationBlock;

for (const definition of definitions) {
  const openTime = BigInt(now + definition.openOffset);
  const lockTime = BigInt(now + definition.lockOffset);
  const observationStart = lockTime;
  const observationEnd = observationStart + BigInt(definition.observeSeconds);
  const rulesHash = keccak256(stringToHex(`${definition.id}:${definition.question}:Arc demo oracle GREEN`));

  const hash = await walletClient.writeContract({
    address: factory,
    abi: factoryAbi,
    functionName: "createMarket",
    args: [definition.question, rulesHash, openTime, lockTime, observationStart, observationEnd, definition.yesPrice]
  });
  const receipt = await wait(hash, `create ${definition.id}`);
  firstCreationBlock ??= receipt.blockNumber;

  const logs = parseEventLogs({ abi: factoryAbi, logs: receipt.logs, eventName: "MarketCreated" });
  const market = logs[0]?.args.market;
  if (!market) throw new Error(`MarketCreated log missing for ${definition.id}`);

  const openHash = await walletClient.writeContract({ address: market, abi: marketAbi, functionName: "open" });
  await wait(openHash, `open ${definition.id}`);

  if (definition.resolveOutcome) {
    const waitMs = Math.max(0, Number(lockTime - BigInt(Math.floor(Date.now() / 1000))) + 2) * 1000;
    if (waitMs > 0) await sleep(waitMs);
    const resolveHash = await walletClient.writeContract({
      address: market,
      abi: marketAbi,
      functionName: "resolve",
      args: [definition.resolveOutcome]
    });
    await wait(resolveHash, `resolve ${definition.id}`);
  }

  demoMarkets.push({
    id: definition.id,
    label: definition.label,
    role: definition.role,
    market: getAddress(market)
  });
  console.log(`${definition.id}: ${getAddress(market)}`);
}

const updated = {
  ...deployment,
  demoMarket: demoMarkets[0].market,
  demoMarkets,
  fromBlock: deployment.fromBlock ?? Number(firstCreationBlock ?? 0n),
  demoMarketsCreatedAt: new Date().toISOString()
};

writeFileSync(deploymentPath, `${JSON.stringify(updated, null, 2)}\n`);
writeFileSync(docsDeploymentPath, `${JSON.stringify(updated, null, 2)}\n`);
console.log("Updated deployment JSON with demoMarkets.");
console.log(JSON.stringify({ demoMarket: updated.demoMarket, demoMarkets: updated.demoMarkets }, null, 2));


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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
