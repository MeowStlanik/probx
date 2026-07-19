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
  // Cap SSR wait so navigation never feels frozen; client shell will finish loading.
  let initial = null;
  try {
    initial =
      (await Promise.race([
        fetchMarket(marketId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000))
      ])) ?? null;
  } catch {
    initial = null;
  }
  return <MarketDetailShell marketId={marketId} initial={initial} serverNow={serverNow} />;
}
