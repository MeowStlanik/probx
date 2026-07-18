import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { formatCompact, formatDisplayOdds } from "@/lib/format";
import type { Market } from "@/lib/types";
import { CountdownTimer } from "./CountdownTimer";

interface MarketTableProps {
  markets: Market[];
}

export function MarketTable({ markets }: MarketTableProps) {
  return (
    <div className="tableShell compactTable">
      <table className="marketTable compactMarketTable">
        <thead>
          <tr>
            <th>Market</th>
            <th>Status</th>
            <th>Lock</th>
            <th>YES / NO</th>
            <th>Vol</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {markets.map((market) => (
            <tr key={market.id}>
              <td>
                <Link className="marketTableQuestion" href={`/markets/${market.id}`}>
                  {market.question}
                </Link>
                <span className="marketTableMeta">
                  {shortSource(market.resolutionSource)}
                  {" · "}
                  {market.ticketCount ?? 0} tix
                </span>
              </td>
              <td>
                <span className={market.status === "OPEN" ? "statusPill open" : "statusPill"}>
                  {market.status}
                </span>
              </td>
              <td className="marketTableLock">
                {market.status === "OPEN" ? (
                  <CountdownTimer target={market.lockTime} label="Locks in" finishedLabel="Locking…" />
                ) : market.status === "LOCKED" ? (
                  <CountdownTimer target={market.observationEnd} label="Settles" finishedLabel="Settling…" />
                ) : market.status === "RESOLVED" ? (
                  <span className="countdown">Resolved</span>
                ) : (
                  <CountdownTimer target={market.lockTime} />
                )}
              </td>
              <td className="marketTableOdds">
                <strong className="yesText">{formatDisplayOdds(market.yesPrice, market.noPrice, "YES")}</strong>
                <span> / </span>
                <strong className="noText">{formatDisplayOdds(market.yesPrice, market.noPrice, "NO")}</strong>
              </td>
              <td className="marketTableVol">
                {formatCompact(market.volume)}
                <span>
                  Y{formatCompact(market.yesVolume ?? 0)}/N{formatCompact(market.noVolume ?? 0)}
                </span>
              </td>
              <td>
                <Link className="iconOnly tableAction" href={`/markets/${market.id}`} aria-label={`Open ${market.question}`}>
                  <ArrowUpRight size={16} aria-hidden />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function shortSource(source: string): string {
  if (/coinbase/i.test(source)) return "Coinbase";
  if (/meteo|weather|met norway/i.test(source)) return "Weather";
  return source.length > 18 ? `${source.slice(0, 18)}…` : source;
}
