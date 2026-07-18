import { fetchMarket } from "@/lib/api.server";
import { MarketDetailShell } from "@/nextjs/shells/MarketDetailShell";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MarketDetailPage({
  params
}: {
  params: Promise<{ marketId: string }>;
}) {
  const { marketId } = await params;
  const serverNow = Date.now();
  let initial = null;
  try {
    initial = (await fetchMarket(marketId)) ?? null;
  } catch {
    initial = null;
  }
  return <MarketDetailShell marketId={marketId} initial={initial} serverNow={serverNow} />;
}
