/**
 * Read LP vault stats directly from Arc RPC using the web deployment.json.
 * Independent of apps/api bundling — works in browser and in Next SSR.
 */
import { createPublicClient, fallback, formatUnits, getAddress, http } from "viem";
import { arcChain, arcDeployment, arcRpcUrls, poolAbi } from "./onchain";
import type { LpStats } from "./types";
import { emptyLpStats } from "./sampleData";

const poolReadAbi = [
  ...poolAbi,
  {
    type: "function",
    name: "lockedUserRisk",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "totalFeesEarned",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

function usdcNumber(value: bigint): number {
  // Matches API / onchainService (6 decimals for USDC amounts)
  return Number(formatUnits(value, 6));
}

export async function readOnchainLpStats(): Promise<LpStats> {
  if (!arcDeployment.liquidityPool) return emptyLpStats;

  const client = createPublicClient({
    chain: arcChain,
    transport: fallback(
      arcRpcUrls.map((url) => http(url, { timeout: 12_000 })),
      { rank: false }
    )
  });

  const pool = getAddress(arcDeployment.liquidityPool);
  const [tvl, reservedLiquidity, lockedUserRisk, availableLiquidity, feesEarned] = await Promise.all([
    client.readContract({ address: pool, abi: poolReadAbi, functionName: "managedAssets" }),
    client.readContract({ address: pool, abi: poolReadAbi, functionName: "reservedAssets" }),
    client.readContract({ address: pool, abi: poolReadAbi, functionName: "lockedUserRisk" }),
    client.readContract({ address: pool, abi: poolReadAbi, functionName: "availableAssets" }),
    client.readContract({ address: pool, abi: poolReadAbi, functionName: "totalFeesEarned" })
  ]);

  return {
    tvl: usdcNumber(tvl),
    reservedLiquidity: usdcNumber(reservedLiquidity),
    lockedUserRisk: usdcNumber(lockedUserRisk),
    availableLiquidity: usdcNumber(availableLiquidity),
    feesEarned: usdcNumber(feesEarned),
    dailyVolume: 0,
    simulatedApy: 0
  };
}
