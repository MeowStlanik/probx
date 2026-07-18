import type { Metadata } from "next";
import Link from "next/link";
import { AppProviders } from "@/components/AppProviders";
import { MarketCycleHeartbeat } from "@/components/MarketCycleHeartbeat";
import { TxToast } from "@/components/TxToast";
import { WalletConnectButton } from "@/components/WalletConnectButton";
import { arcDeployment } from "@/lib/onchain";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProbX Arc | Short YES/NO markets on Arc",
  description:
    "USDC-native short prediction markets with Micro Boost tickets on Arc testnet. BTC and London weather auto-resolve from live feeds.",
  icons: {
    icon: [{ url: "/icon.png", type: "image/png" }],
    apple: "/icon.png",
    shortcut: "/favicon.ico"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const explorer = arcDeployment.explorerUrl || "https://testnet.arcscan.app";
  const pool = arcDeployment.liquidityPool;
  const engine = arcDeployment.microBoostEngine;
  const ticket = arcDeployment.positionTicket;
  const usdc = arcDeployment.usdc;
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AppProviders>
          <div className="appShell">
            <header className="appHeader">
              <Link className="brand" href="/" aria-label="ProbX Arc home">
                <span className="brandMark" aria-hidden>
                  <img src="/assets/probx-mark.png" alt="" width={36} height={36} />
                </span>
                <span className="brandText">
                  ProbX<span className="brandTextMuted"> Arc</span>
                </span>
              </Link>

              <nav className="topNav" aria-label="Main navigation">
                <Link href="/markets">Markets</Link>
                <Link href="/markets">Quick trade</Link>
                <Link href="/lp">LP</Link>
                <Link href="/portfolio">Portfolio</Link>
              </nav>

              <div className="headerActions">
                <a className="networkPill" href={explorer} target="_blank" rel="noreferrer">
                  <span className="dot" aria-hidden />
                  Arc Testnet
                </a>
                <Link className="adminGear" href="/admin" title="Admin" aria-label="Admin">
                  ⚙
                </Link>
                <WalletConnectButton />
              </div>
            </header>

            <MarketCycleHeartbeat />
            {children}

            <footer className="arcFooter">
              <div className="arcFooterInner">
                <div>
                  <div className="arcFooterBrand">
                    <img src="/assets/probx-mark.png" alt="" width={20} height={20} />
                    ProbX Arc
                  </div>
                  <p>Hackathon demo · USDC-native prediction markets on Arc Testnet.</p>
                </div>

                <div>
                  <h4>Product</h4>
                  <ul>
                    <li>
                      <Link href="/markets">Markets</Link>
                    </li>
                    <li>
                      <Link href="/markets">Quick trade</Link>
                    </li>
                    <li>
                      <Link href="/lp">LP vault</Link>
                    </li>
                    <li>
                      <Link href="/portfolio">Portfolio</Link>
                    </li>
                    <li>
                      <Link href="/admin">Admin</Link>
                    </li>
                  </ul>
                </div>

                <div>
                  <h4>Contracts</h4>
                  <ul>
                    <li>
                      <a
                        className="footerMonoLink"
                        href={`${explorer}/address/${usdc}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        USDC · {short(usdc)} ↗
                      </a>
                    </li>
                    {pool ? (
                      <li>
                        <a
                          className="footerMonoLink"
                          href={`${explorer}/address/${pool}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Liquidity Pool ↗
                        </a>
                      </li>
                    ) : null}
                    {ticket ? (
                      <li>
                        <a
                          className="footerMonoLink"
                          href={`${explorer}/address/${ticket}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Position Ticket ↗
                        </a>
                      </li>
                    ) : null}
                    {engine ? (
                      <li>
                        <a
                          className="footerMonoLink"
                          href={`${explorer}/address/${engine}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Boost Engine ↗
                        </a>
                      </li>
                    ) : null}
                  </ul>
                </div>

                <div>
                  <h4>Chain</h4>
                  <ul>
                    <li>
                      <span className="footerPlain">
                        Arc Testnet · chain{" "}
                        <span className="mono">{arcDeployment.chainId}</span>
                      </span>
                    </li>
                    <li>
                      <span className="footerMuted mono">rpc.testnet.arc.network</span>
                    </li>
                    <li>
                      <a className="footerMonoLink" href={explorer} target="_blank" rel="noreferrer">
                        testnet.arcscan.app ↗
                      </a>
                    </li>
                    <li>
                      <a
                        href="https://github.com/MeowStlanik/probx"
                        target="_blank"
                        rel="noreferrer"
                      >
                        GitHub ↗
                      </a>
                    </li>
                    <li>
                      <a
                        href="https://developers.circle.com/wallets/dev-controlled"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Circle docs ↗
                      </a>
                    </li>
                  </ul>
                </div>
              </div>
            </footer>
          </div>

          <TxToast />
        </AppProviders>
      </body>
    </html>
  );
}
