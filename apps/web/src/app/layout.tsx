import type { Metadata } from "next";
import { AppProviders } from "@/components/AppProviders";
import { MarketCycleHeartbeat } from "@/components/MarketCycleHeartbeat";
import { TxToast } from "@/components/TxToast";
import { AppChrome } from "@/nextjs/shells/AppChrome";
// Keep legacy class styles for FundUsdcPanel + loading shells still using globals.
// New theme screens use nextjs/* inline styles; class names do not collide.
import "./globals.css";
import "@/nextjs/breakpoint.css";

export const metadata: Metadata = {
  title: "ProbX Arc | Short YES/NO markets on Arc",
  description:
    "USDC-native short prediction markets with Micro Boost tickets on Arc testnet. BTC and London weather auto-resolve from live feeds.",
  icons: {
    icon: [{ url: "/probx-logo.png", type: "image/png" }, { url: "/icon.png", type: "image/png" }],
    apple: "/probx-logo.png",
    shortcut: "/favicon.ico"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
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
          <AppChrome>
            <MarketCycleHeartbeat />
            {children}
          </AppChrome>
          <TxToast />
        </AppProviders>
      </body>
    </html>
  );
}
