"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, getAddress, parseEventLogs, parseUnits } from "viem";
import { loadActivity, type ActivityItem } from "@/lib/activity";
import { fetchMarket } from "@/lib/api";
import { MarketLiveChart } from "@/components/MarketLiveChart";
import { arcDeployment, engineAbi, usdcAbi } from "@/lib/onchain";
import { savePosition } from "@/lib/positions";
import type { Market } from "@/lib/types";
import { readableWalletError, shortHex, useWallet } from "@/lib/wallet";
import { toMarketDetail } from "../mapMarket";
import type { ActivityRow, LoadState, Side } from "../types";
import { MarketDetailView } from "../views/MarketDetailView";

/**
 * Wires MarketDetailView → fetchMarket + MicroBoostEngine.buyTicket
 * (same contracts as OnchainTradeTicket).
 */
export function MarketDetailShell({
  marketId,
  initial,
  serverNow
}: {
  marketId: string;
  initial?: Market | null;
  serverNow?: number;
}) {
  const router = useRouter();
  const { address, getWalletClient, publicClient, ensureArcChain } = useWallet();
  const [state, setState] = useState<LoadState>(initial ? "live" : "loading");
  const [market, setMarket] = useState<Market | null>(initial ?? null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  // Hydration-stable clock: start from SSR snapshot, tick only after mount
  const [now, setNow] = useState(() => serverNow ?? 0);
  const [engineAllowance, setEngineAllowance] = useState(0n);
  const [quotedDebit, setQuotedDebit] = useState(0n);
  const marketRef = useRef(market);
  marketRef.current = market;

  const needsApproval = quotedDebit > 0n && engineAllowance < quotedDebit;

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const detail = useMemo(() => {
    if (!market) return null;
    // Before first client tick (now===0), freeze at serverNow to avoid hydration drift
    const t = now || serverNow || Date.now();
    return toMarketDetail(market, [], t);
  }, [market, now, serverNow]);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent && !marketRef.current) setState("loading");
      try {
        // Prefer raw 0x address (portfolio tickets store full address)
        const m = await fetchMarket(marketId);
        if (!m) {
          // Never wipe a good market on a flaky poll (e.g. right after approve)
          if (!marketRef.current) {
            setMarket(null);
            setState("error");
          }
          return;
        }
        setMarket(m);
        const items = loadActivity().filter(
          (a: ActivityItem) => a.marketId === m.id || a.marketId === m.contractAddress
        );
        setActivity(
          items.slice(0, 12).map((a) => ({
            time: relativeTime(a.at),
            side: (a.title.includes("NO") ? "NO" : "YES") as Side,
            stake: "—",
            boost: "—",
            payout: "—",
            tx: a.txHash ? shortHex(a.txHash) : "—",
            txHref: a.txHash ? `${arcDeployment.explorerUrl}/tx/${a.txHash}` : "#"
          }))
        );
        setState("live");
      } catch {
        // Keep previous market on error — do not flip to error screen mid-session
        if (!marketRef.current) setState("error");
      }
    },
    [marketId]
  );

  useEffect(() => {
    void load({ silent: Boolean(initial) });
    // Poll less aggressively — reduces tab-switch jank
    const id = window.setInterval(() => void load({ silent: true }), 15_000);
    return () => window.clearInterval(id);
  }, [load, initial]);

  const quoteBuy = useCallback(
    async (side: Side, stake: number, boost: number) => {
      if (!market) throw new Error("Market not loaded");
      if (!address) throw new Error("Connect wallet in the header first.");
      const marketAddress = getAddress(market.contractAddress || market.id);
      const risk = parseUnits(String(stake || 0), 6);
      if (risk <= 0n) throw new Error("Stake must be > 0");
      const boostBps = BigInt(Math.round(boost * 10_000));
      const outcomeId = side === "YES" ? 1 : 2;

      const quote = (await publicClient.readContract({
        address: getAddress(arcDeployment.microBoostEngine),
        abi: engineAbi,
        functionName: "quoteTicket",
        args: [marketAddress, outcomeId, risk, boostBps],
        account: address
      })) as {
        totalDebit: bigint;
        payout: bigint;
        fee: bigint;
        price: bigint;
        accepted: boolean;
        reason: string;
      };
      if (!quote.accepted) {
        throw new Error(quote.reason || "Quote rejected — market locked or LP reserve insufficient.");
      }
      setQuotedDebit(quote.totalDebit);

      const allowance = await publicClient.readContract({
        address: getAddress(arcDeployment.usdc),
        abi: usdcAbi,
        functionName: "allowance",
        args: [address, getAddress(arcDeployment.microBoostEngine)]
      });
      setEngineAllowance(allowance);

      return { quote, marketAddress, risk, boostBps, outcomeId, allowance };
    },
    [address, market, publicClient]
  );

  // Refresh allowance + debit estimate when wallet / market changes
  useEffect(() => {
    if (!address || !market) {
      setEngineAllowance(0n);
      setQuotedDebit(0n);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const allw = await publicClient.readContract({
          address: getAddress(arcDeployment.usdc),
          abi: usdcAbi,
          functionName: "allowance",
          args: [address, getAddress(arcDeployment.microBoostEngine)]
        });
        if (!cancelled) setEngineAllowance(allw);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, market, publicClient]);

  const onApprove = useCallback(
    async (side: Side, stake: number, boost: number) => {
      await ensureArcChain();
      const walletClient = getWalletClient();
      if (!walletClient) throw new Error("Wallet provider unavailable.");
      const { quote } = await quoteBuy(side, stake, boost);
      const approveHash = await walletClient.writeContract({
        address: getAddress(arcDeployment.usdc),
        abi: usdcAbi,
        functionName: "approve",
        args: [getAddress(arcDeployment.microBoostEngine), quote.totalDebit]
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash, timeout: 120_000 });
      const allw = await publicClient.readContract({
        address: getAddress(arcDeployment.usdc),
        abi: usdcAbi,
        functionName: "allowance",
        args: [address!, getAddress(arcDeployment.microBoostEngine)]
      });
      setEngineAllowance(allw);
      setQuotedDebit(quote.totalDebit);
    },
    [address, ensureArcChain, getWalletClient, publicClient, quoteBuy]
  );

  const onConfirmTicket = useCallback(
    async (side: Side, stake: number, boost: number) => {
      if (!market) throw new Error("Market not loaded");
      if (!address) throw new Error("Connect wallet in the header first.");
      // Mirror UI: only OPEN accepts buys (lifecycle Lock/Observe block the form).
      if (market.status !== "OPEN" && market.status !== "CREATED") {
        throw new Error("Betting is closed for this market — wait for the next open round.");
      }
      await ensureArcChain();
      const walletClient = getWalletClient();
      if (!walletClient) throw new Error("Wallet provider unavailable.");

      const { quote, marketAddress, risk, boostBps, outcomeId, allowance } = await quoteBuy(
        side,
        stake,
        boost
      );
      if (allowance < quote.totalDebit) {
        throw new Error("Approve USDC first.");
      }

      const hash = await walletClient.writeContract({
        address: getAddress(arcDeployment.microBoostEngine),
        abi: engineAbi,
        functionName: "buyTicket",
        args: [marketAddress, outcomeId, risk, boostBps]
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      let ticketId: string | undefined;
      try {
        const logs = parseEventLogs({ abi: engineAbi, logs: receipt.logs, eventName: "TicketBought" });
        ticketId = logs[0]?.args.ticketId?.toString();
      } catch {
        /* ignore */
      }
      if (ticketId) {
        savePosition({
          ticketId,
          marketId: market.id,
          marketAddress,
          marketQuestion: market.question,
          outcome: side,
          riskAmount: stake,
          boost,
          fillPrice: Number(quote.price) / 1_000_000,
          payout: Number(formatUnits(quote.payout, 6)),
          fee: Number(formatUnits(quote.fee, 6)),
          lockTime: market.lockTime,
          observationEnd: market.observationEnd,
          createdAt: new Date().toISOString(),
          txHash: hash
        });
        window.dispatchEvent(new Event("probx-position-saved"));
      }

      void load({ silent: true });

      const gas = receipt.gasUsed ? `${formatUnits(receipt.gasUsed, 0)} units` : "—";
      return { txHash: hash, gas };
    },
    [address, ensureArcChain, getWalletClient, load, market, publicClient, quoteBuy]
  );

  const chart =
    market && (market.demoRole === "btc_price" || market.category === "crypto-candle") ? (
      <MarketLiveChart market={market} feed="btc" />
    ) : market && (market.demoRole === "london_weather" || market.category === "weather") ? (
      <MarketLiveChart market={market} feed="weather" />
    ) : undefined;

  return (
    <MarketDetailView
      state={state}
      market={detail}
      activity={activity}
      chart={chart}
      needsApproval={needsApproval}
      onRetry={() => void load()}
      onBack={() => router.push("/markets")}
      onPreviewQuote={(side, stake, boost) => {
        void quoteBuy(side, stake, boost).catch(() => {
          /* keep last known needsApproval */
        });
      }}
      onApprove={async (side, stake, boost) => {
        try {
          await onApprove(side, stake, boost);
        } catch (error) {
          throw new Error(readableWalletError(error));
        }
      }}
      onConfirmTicket={async (side, stake, boost) => {
        try {
          return await onConfirmTicket(side, stake, boost);
        } catch (error) {
          throw new Error(readableWalletError(error));
        }
      }}
    />
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
