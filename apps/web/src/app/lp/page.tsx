import { fetchLpStats } from "@/lib/api.server";
import { LpShell } from "@/nextjs/shells/LpShell";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LpPage() {
  let stats;
  try {
    stats = await fetchLpStats();
  } catch {
    stats = undefined;
  }

  return (
    <LpShell
      initialTvl={stats?.tvl}
      initialReserved={stats?.reservedLiquidity}
      initialAvailable={stats?.availableLiquidity}
      initialApy={stats?.simulatedApy}
    />
  );
}
