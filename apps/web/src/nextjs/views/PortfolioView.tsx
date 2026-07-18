import Link from "next/link";
import { theme } from "../theme";
import { Position, LoadState } from "../types";
import { SideChip } from "../components/StatusPill";
import { EmptyState, SkeletonRow } from "../components/EmptyState";
import { Button } from "../components/Button";

interface Props {
  state: LoadState;
  openCount: number;
  totalStaked: string;
  claimable: string;
  pnl: string;
  pnlPositive: boolean;
  positions: Position[];
  onClaim: (id: string) => void;
  onRetry: () => void;
  claimingId?: string | null;
  claimMessage?: string | null;
}

// /portfolio — summary stats + ticket table (open / won-unclaimed / claimed / lost).
export function PortfolioView({
  state,
  openCount,
  totalStaked,
  claimable,
  pnl,
  pnlPositive,
  positions,
  onClaim,
  onRetry,
  claimingId,
  claimMessage
}: Props) {
  const stat = (label: string, value: string, color: string = theme.color.ink) => (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${theme.color.border}`,
        borderRadius: 12,
        boxShadow: theme.shadow.card,
        padding: 20
      }}
    >
      <div style={{ fontSize: 11.5, color: theme.color.muted }}>{label}</div>
      <div style={{ fontFamily: theme.font.mono, fontSize: 24, fontWeight: 600, color, marginTop: 4 }}>{value}</div>
    </div>
  );

  const statusChipStyle = (status: Position["status"]) => {
    if (status === "Won · unclaimed" || status === "Claimed") return { bg: theme.color.yesSoft, fg: theme.color.yes };
    if (status === "Lost") return { bg: theme.color.noSoft, fg: theme.color.no };
    return { bg: theme.color.blueSoft, fg: theme.color.blue };
  };

  return (
    <main style={{ maxWidth: theme.layout.portfolioMaxWidth, margin: "0 auto", padding: "40px 24px 72px", flex: 1 }}>
      <h1 style={{ fontSize: 26, fontWeight: 600, color: theme.color.ink }}>Portfolio</h1>
      <p style={{ fontSize: 13.5, color: theme.color.muted, margin: "6px 0 28px" }}>
        Your open and settled tickets on Arc.
      </p>

      {state === "error" && (
        <EmptyState
          tone="error"
          title="Couldn't load your positions"
          description="Arc RPC call failed — your funds are safe, just retry the read."
          action={
            <button
              onClick={onRetry}
              style={{
                background: theme.color.ink,
                color: "#fff",
                border: "none",
                borderRadius: 9,
                padding: "9px 16px",
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer"
              }}
            >
              Retry
            </button>
          }
        />
      )}

      {state === "loading" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      )}

      {state === "live" && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
              gap: 16,
              marginBottom: 24
            }}
          >
            {stat("Open positions", String(openCount))}
            {stat("Total staked", totalStaked)}
            {stat("Claimable", claimable, theme.color.yes)}
            {stat("Realized P&L", pnl, pnlPositive ? theme.color.yes : theme.color.no)}
          </div>

          {claimMessage ? (
            <div
              style={{
                marginBottom: 16,
                padding: "10px 14px",
                borderRadius: 10,
                fontSize: 13,
                background: /fail|error|reject|wrong/i.test(claimMessage)
                  ? theme.color.noSoft
                  : theme.color.yesSoft,
                color: /fail|error|reject|wrong/i.test(claimMessage) ? theme.color.no : theme.color.yes,
                border: `1px solid ${
                  /fail|error|reject|wrong/i.test(claimMessage) ? theme.color.noBorder : theme.color.yesBorder
                }`
              }}
            >
              {claimMessage}
            </div>
          ) : null}

          {positions.length === 0 ? (
            <EmptyState title="No tickets yet" description="Buy your first ticket from any open market." />
          ) : (
            <div
              style={{
                background: "#fff",
                border: `1px solid ${theme.color.border}`,
                borderRadius: 12,
                boxShadow: theme.shadow.card,
                padding: 20,
                overflowX: "auto"
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: theme.color.ink }}>Tickets</span>
              <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 12, minWidth: 640 }}>
                <thead>
                  <tr style={{ textAlign: "left" }}>
                    {["Market", "Side", "Stake", "Boost", "Payout", "Status", "Action"].map((h, i) => (
                      <th
                        key={h}
                        style={{
                          padding: "6px 8px",
                          fontWeight: 500,
                          fontSize: 11,
                          color: theme.color.muted,
                          textTransform: "uppercase",
                          letterSpacing: ".02em",
                          textAlign: i >= 2 && i <= 4 ? "right" : "left"
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => {
                    const c = statusChipStyle(p.status);
                    const marketCell = p.marketId ? (
                      <Link
                        href={`/markets/${encodeURIComponent(p.marketId)}`}
                        style={{
                          color: theme.color.blue,
                          textDecoration: "none",
                          fontWeight: 500,
                          fontSize: 12.5
                        }}
                      >
                        {p.market}
                      </Link>
                    ) : (
                      <span style={{ color: theme.color.ink, fontSize: 12.5 }}>{p.market}</span>
                    );
                    return (
                      <tr key={p.id} style={{ background: i % 2 === 0 ? "#fff" : theme.color.tint }}>
                        <td style={{ padding: "10px 8px", maxWidth: 280 }}>{marketCell}</td>
                        <td style={{ padding: "10px 8px" }}>
                          <SideChip side={p.side} />
                        </td>
                        <td
                          style={{
                            padding: "10px 8px",
                            fontFamily: theme.font.mono,
                            color: theme.color.ink,
                            textAlign: "right",
                            fontSize: 12.5
                          }}
                        >
                          {p.stake}
                        </td>
                        <td
                          style={{
                            padding: "10px 8px",
                            fontFamily: theme.font.mono,
                            color: theme.color.ink,
                            textAlign: "right",
                            fontSize: 12.5
                          }}
                        >
                          {p.boost}
                        </td>
                        <td
                          style={{
                            padding: "10px 8px",
                            fontFamily: theme.font.mono,
                            color: theme.color.ink,
                            textAlign: "right",
                            fontSize: 12.5
                          }}
                        >
                          {p.payout}
                        </td>
                        <td style={{ padding: "10px 8px" }}>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: c.fg,
                              background: c.bg,
                              borderRadius: 6,
                              padding: "3px 8px"
                            }}
                          >
                            {p.status}
                          </span>
                        </td>
                        <td style={{ padding: "10px 8px", textAlign: "right" }}>
                          {p.canClaim ? (
                            <Button
                              size="sm"
                              disabled={claimingId === p.id}
                              onClick={() => onClaim(p.id)}
                            >
                              {claimingId === p.id ? "…" : "Claim"}
                            </Button>
                          ) : p.status === "Lost" ? (
                            <span style={{ fontSize: 11.5, color: theme.color.muted }}>No payout</span>
                          ) : p.txHref ? (
                            <a
                              href={p.txHref}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontFamily: theme.font.mono, fontSize: 11, color: theme.color.purple }}
                            >
                              tx ↗
                            </a>
                          ) : (
                            <span style={{ fontSize: 11.5, color: theme.color.muted }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </main>
  );
}
