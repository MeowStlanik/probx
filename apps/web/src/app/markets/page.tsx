import { fetchMarkets } from "@/lib/api.server";
import { MarketsShell } from "@/nextjs/shells/MarketsShell";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function MarketsPage() {
  const serverNow = Date.now();
  let initial;
  try {
    initial = await fetchMarkets();
  } catch {
    initial = undefined;
  }
  return <MarketsShell initial={initial} serverNow={serverNow} />;
}
