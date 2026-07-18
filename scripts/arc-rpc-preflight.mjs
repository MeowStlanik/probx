import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const deploymentPath = process.env.PROBX_DEPLOYMENT_PATH ?? resolve(root, "apps/web/src/lib/deployment.json");
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
const urls = buildRpcUrls(deployment);

let ok = false;
for (const url of urls) {
  try {
    const chainId = await rpc(url, "eth_chainId", []);
    const blockNumber = await rpc(url, "eth_blockNumber", []);
    console.log(`${url} OK chainId=${Number(chainId)} block=${Number(blockNumber)}`);
    ok = true;
  } catch (error) {
    console.log(`${url} FAIL ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!ok) {
  process.exitCode = 1;
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
    "https://arc-testnet.drpc.org",
    "https://rpc.quicknode.testnet.arc.network",
    "https://rpc.blockdaemon.testnet.arc.network"
  ].filter(Boolean)));
}

async function rpc(url, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.RPC_PREFLIGHT_TIMEOUT_MS ?? 8000));
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
    return body.result;
  } finally {
    clearTimeout(timeout);
  }
}
