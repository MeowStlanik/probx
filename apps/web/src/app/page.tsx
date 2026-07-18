import { fetchLpStats, fetchMarkets } from "@/lib/api.server";
import { HomeShell } from "@/nextjs/shells/HomeShell";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage() {
  const serverNow = Date.now();
  const [markets, stats] = await Promise.all([fetchMarkets(), fetchLpStats()]);
  return <HomeShell markets={markets} stats={stats} serverNow={serverNow} />;
}
