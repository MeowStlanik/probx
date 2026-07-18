import Image from "next/image";
import Link from "next/link";
import { arcDeployment } from "@/lib/onchain";
import { theme } from "../theme";

const productLinks = [
  { href: "/markets", label: "Markets" },
  { href: "/markets", label: "Quick trade" },
  { href: "/lp", label: "LP vault" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/admin", label: "Admin" }
];

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function Footer() {
  const explorer = arcDeployment.explorerUrl || "https://testnet.arcscan.app";
  const contractLinks = [
    {
      label: `USDC · ${short(arcDeployment.usdc)}`,
      href: `${explorer}/address/${arcDeployment.usdc}`
    },
    {
      label: "Liquidity Pool ↗",
      href: `${explorer}/address/${arcDeployment.liquidityPool}`
    },
    {
      label: "Position Ticket ↗",
      href: `${explorer}/address/${arcDeployment.positionTicket}`
    },
    {
      label: "Boost Engine ↗",
      href: `${explorer}/address/${arcDeployment.microBoostEngine}`
    }
  ];

  return (
    <footer style={{ borderTop: `1px solid ${theme.color.border}`, background: theme.color.tint, marginTop: "auto" }}>
      <div
        style={{
          maxWidth: theme.layout.maxWidth,
          margin: "0 auto",
          padding: "40px 24px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))",
          gap: 32
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <Image src="/probx-logo.png" alt="ProbX Arc" width={20} height={20} style={{ borderRadius: 5 }} />
            <span style={{ fontFamily: theme.font.display, fontWeight: 700, fontSize: 15, color: theme.color.ink }}>
              ProbX Arc
            </span>
          </div>
          <p style={{ fontSize: 12, color: theme.color.muted, lineHeight: 1.6 }}>
            Hackathon demo · USDC-native prediction markets on Arc Testnet.
          </p>
        </div>
        <div>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: theme.color.muted,
              letterSpacing: ".03em",
              textTransform: "uppercase"
            }}
          >
            Product
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 12 }}>
            {productLinks.map((l) => (
              <Link key={l.label} href={l.href} style={{ fontSize: 13, color: theme.color.ink, textDecoration: "none" }}>
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        <div>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: theme.color.muted,
              letterSpacing: ".03em",
              textTransform: "uppercase"
            }}
          >
            Contracts
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 12 }}>
            {contractLinks.map((l) => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noreferrer"
                style={{ fontFamily: theme.font.mono, fontSize: 12, color: theme.color.purple }}
              >
                {l.label}
              </a>
            ))}
          </div>
        </div>
        <div>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: theme.color.muted,
              letterSpacing: ".03em",
              textTransform: "uppercase"
            }}
          >
            Chain
          </span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 9,
              marginTop: 12,
              fontSize: 12.5,
              color: theme.color.ink
            }}
          >
            <span>
              Arc Testnet · chain <span style={{ fontFamily: theme.font.mono }}>{arcDeployment.chainId}</span>
            </span>
            <span style={{ fontFamily: theme.font.mono, color: theme.color.muted }}>rpc.testnet.arc.network</span>
            <a
              href={explorer}
              target="_blank"
              rel="noreferrer"
              style={{ fontFamily: theme.font.mono, color: theme.color.purple }}
            >
              testnet.arcscan.app ↗
            </a>
            <a
              href="https://github.com/MeowStlanik/probx"
              target="_blank"
              rel="noreferrer"
              style={{ fontFamily: theme.font.mono, color: theme.color.purple }}
            >
              GitHub ↗
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
