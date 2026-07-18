"use client";

import type { ReactNode } from "react";
import { WalletProvider } from "@/lib/wallet";

/** Single client boundary so all pages share one WalletContext instance. */
export function AppProviders({ children }: { children: ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
