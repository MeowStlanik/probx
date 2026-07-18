import { LPStatsPanel } from "@/components/LPStatsPanel";
import { OnchainLpVault } from "@/components/OnchainLpVault";
import { fetchLpStats } from "@/lib/api.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LpPage() {
  let initial;
  try {
    initial = await fetchLpStats();
  } catch {
    initial = undefined;
  }

  return (
    <main className="pageShell">
      <div className="sectionHeader">
        <div>
          <h1>LP vault</h1>
          <p className="pageLead">Liquidity backing every ticket&apos;s payout on Arc.</p>
        </div>
      </div>

      <LPStatsPanel stats={initial} showWaterfall={false} />

      <OnchainLpVault />
    </main>
  );
}
