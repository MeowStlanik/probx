import { LPStatsPanel } from "@/components/LPStatsPanel";
import { OnchainLpVault } from "@/components/OnchainLpVault";
import { fetchLpStats } from "@/lib/api.server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LpPage() {
  // Best-effort SSR seed; client panel always re-fetches /api/lp/stats + Arc RPC.
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
          <span className="eyebrow">Vault</span>
          <h1>LP vault</h1>
          <p style={{ color: "var(--muted)", fontSize: "13.5px", margin: "6px 0 0" }}>
            Liquidity backing every ticket&apos;s payout on Arc.
          </p>
        </div>
      </div>

      <LPStatsPanel stats={initial} showWaterfall />

      <OnchainLpVault />
    </main>
  );
}
