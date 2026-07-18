import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  fallback,
  formatUnits,
  getAddress,
  http,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const rpcUrl = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const rpcUrls = buildRpcUrls({ rpcUrl });
const rpcTransport = buildRpcTransport(rpcUrls);
const usdcAddress = getAddress(process.env.ARC_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000");
const privateKey = process.env.PRIVATE_KEY;
const lpDeposit = process.env.LP_DEPOSIT_USDC ?? "8";

if (!privateKey) {
  throw new Error("PRIVATE_KEY is required");
}

const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } }
});

const account = privateKeyToAccount(privateKey);
const publicClient = createPublicClient({ chain: arcTestnet, transport: rpcTransport });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: rpcTransport });

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
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
];

function artifact(name) {
  return JSON.parse(readFileSync(resolve(root, `contracts/out/${name}.sol/${name}.json`), "utf8"));
}

let deploymentFromBlock;


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
    "https://arc-testnet.drpc.org",
    "https://rpc.quicknode.testnet.arc.network",
    "https://rpc.blockdaemon.testnet.arc.network"
  ].filter(Boolean)));
}

function buildRpcTransport(urls) {
  const transports = urls.map((url) => http(url));
  return transports.length === 1 ? transports[0] : fallback(transports, { rank: false });
}

async function wait(hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${label} failed: ${hash}`);
  }
  deploymentFromBlock ??= receipt.blockNumber;
  return receipt;
}

async function deploy(name, args = []) {
  const item = artifact(name);
  const hash = await walletClient.deployContract({
    abi: item.abi,
    bytecode: item.bytecode.object,
    args
  });
  const receipt = await wait(hash, `deploy ${name}`);
  console.log(`${name}: ${receipt.contractAddress}`);
  return getAddress(receipt.contractAddress);
}

async function send(address, abi, functionName, args = []) {
  const hash = await walletClient.writeContract({
    address,
    abi,
    functionName,
    args
  });
  await wait(hash, functionName);
  return hash;
}

const deployerBalance = await publicClient.readContract({
  address: usdcAddress,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [account.address]
});

console.log(`Deployer: ${account.address}`);
console.log(`USDC balance: ${formatUnits(deployerBalance, 6)} USDC`);

const requiredLp = parseUnits(lpDeposit, 6);
if (deployerBalance < requiredLp) {
  throw new Error(`Need at least ${lpDeposit} ERC-20 USDC for LP seed`);
}

const liquidityPoolArtifact = artifact("LiquidityPool");
const insuranceArtifact = artifact("InsuranceFund");
const feeRouterArtifact = artifact("FeeRouter");
const ticketArtifact = artifact("PositionTicket");
const engineArtifact = artifact("MicroBoostEngine");
const oracleArtifact = artifact("OracleAdapter");
const factoryArtifact = artifact("MicroMarketFactory");
const marketArtifact = artifact("MicroMarket");

const liquidityPool = await deploy("LiquidityPool", [usdcAddress]);
const insuranceFund = await deploy("InsuranceFund", [usdcAddress]);
const feeRouter = await deploy("FeeRouter", [usdcAddress, liquidityPool, insuranceFund, account.address]);
const positionTicket = await deploy("PositionTicket");
const microBoostEngine = await deploy("MicroBoostEngine", [
  usdcAddress,
  liquidityPool,
  feeRouter,
  positionTicket
]);
const oracleAdapter = await deploy("OracleAdapter", [account.address]);
const marketFactory = await deploy("MicroMarketFactory", [microBoostEngine, oracleAdapter]);

await send(liquidityPool, liquidityPoolArtifact.abi, "setEngine", [microBoostEngine]);
await send(liquidityPool, liquidityPoolArtifact.abi, "setFeeRouter", [feeRouter]);
await send(insuranceFund, insuranceArtifact.abi, "setEngine", [microBoostEngine]);
await send(positionTicket, ticketArtifact.abi, "setEngine", [microBoostEngine]);

await send(usdcAddress, erc20Abi, "approve", [liquidityPool, requiredLp]);
await send(liquidityPool, liquidityPoolArtifact.abi, "deposit", [requiredLp]);
console.log(`Seeded LP: ${lpDeposit} USDC`);

const now = Math.floor(Date.now() / 1000);
const openTime = BigInt(now - 30);
const lockTime = BigInt(now + 3600);
const observationStart = lockTime;
const observationEnd = lockTime + 300n;
const yesPrice = 500_000n;

const createHash = await walletClient.writeContract({
  address: marketFactory,
  abi: factoryArtifact.abi,
  functionName: "createMarket",
  args: [
    "Will the next demo signal be GREEN?",
    "0x" + Buffer.from("Demo Oracle emits GREEN; RED or timeout resolves NO").toString("hex").padEnd(64, "0").slice(0, 64),
    openTime,
    lockTime,
    observationStart,
    observationEnd,
    yesPrice
  ]
});
const createReceipt = await wait(createHash, "createMarket");
const createdLog = createReceipt.logs.find((log) => log.address.toLowerCase() === marketFactory.toLowerCase());
if (!createdLog) throw new Error("MarketCreated log not found");
const marketAddress = getAddress(`0x${createdLog.topics[2].slice(26)}`);
await send(marketAddress, marketArtifact.abi, "open");
console.log(`Demo market: ${marketAddress}`);

const deployment = {
  chainId: 5_042_002,
  chainName: "Arc Testnet",
  rpcUrl,
  rpcUrls,
  explorerUrl: "https://testnet.arcscan.app",
  deployer: account.address,
  usdc: usdcAddress,
  liquidityPool,
  insuranceFund,
  feeRouter,
  positionTicket,
  microBoostEngine,
  oracleAdapter,
  marketFactory,
  demoMarket: marketAddress,
  lpSeedUsdc: lpDeposit,
  fromBlock: Number(deploymentFromBlock ?? createReceipt.blockNumber),
  deployedAt: new Date().toISOString()
};

const deploymentPath = resolve(root, "apps/web/src/lib/deployment.json");
mkdirSync(dirname(deploymentPath), { recursive: true });
writeFileSync(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);
writeFileSync(resolve(root, "docs/DEPLOYMENT_ARC_TESTNET.json"), `${JSON.stringify(deployment, null, 2)}\n`);

console.log(JSON.stringify(deployment, null, 2));
