"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, getAddress, isAddress, parseEventLogs, parseUnits } from "viem";
import { loadActivity, type ActivityItem } from "@/lib/activity";
import { fetchMarket, isOnchainMarketId } from "@/lib/api";
import { MarketLiveChart } from "@/components/MarketLiveChart";
import { arcDeployment, engineAbi, usdcAbi } from "@/lib/onchain";
import { savePosition } from "@/lib/positions";
import type { Market } from "@/lib/types";
import { readableWalletError, shortHex, useWallet } from "@/lib/wallet";
import { toMarketDetail } from "../mapMarket";
import type { ActivityRow, LoadState, Side } from "../types";
import { MarketDetailView } from "../views/MarketDetailView";

function resolveMarketAddress(market: Market): `0x${string}` {
  const raw = (market.contractAddress || market.id || "").trim();
  if (!isOnchainMarketId(raw) || !isAddress(raw)) {
    throw new Error(
      "This market is an offline placeholder (API did not load live Arc markets). " +
        "Refresh the home page and open a market whose id starts with 0x."
    );
  }
  return getAddress(raw);
}

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
  const { address, getWalletClient, publicClient, ensureArcChain, trackTx } = useWallet();
  // Ignore SSR offline placeholders so we never hydrate a non-0x market as bettable.
  const safeInitial = initial && isOnchainMarketId(initial.id) ? initial : null;
  const [state, setState] = useState<LoadState>(safeInitial ? "live" : "loading");
  const [market, setMarket] = useState<Market | null>(safeInitial);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  // Hydration-stable clock: start from SSR snapshot, tick only after mount
  const [now, setNow] = useState(() => serverNow ?? 0);
  const [engineAllowance, setEngineAllowance] = useState(0n);
  const [quotedDebit, setQuotedDebit] = useState(0n);
  const [liveQuote, setLiveQuote] = useState<{
    stake: number;
    fee: number;
    totalDebit: number;
    payout: number;
    accepted: boolean;
    reason?: string;
  } | null>(null);
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
    // If SSR already filled the card, refresh quietly; otherwise show loading shell.
    void load({ silent: Boolean(initial) });
    // Poll less aggressively — reduces tab-switch jank
    const id = window.setInterval(() => void load({ silent: true }), 20_000);
    return () => window.clearInterval(id);
  }, [load, initial]);

  const quoteBuy = useCallback(
    async (side: Side, stake: number, boost: number, opts?: { requireWallet?: boolean }) => {
      if (!market) throw new Error("Market not loaded");
      if (opts?.requireWallet && !address) {
        throw new Error("Connect wallet in the header first.");
      }
      const marketAddress = resolveMarketAddress(market);
      const risk = parseUnits(String(stake || 0), 6);
      if (risk <= 0n) throw new Error("Stake must be > 0");
      const boostBps = BigInt(Math.round(boost * 10_000));
      const outcomeId = side === "YES" ? 1 : 2;

      const quote = (await publicClient.readContract({
        address: getAddress(arcDeployment.microBoostEngine),
        abi: engineAbi,
        functionName: "quoteTicket",
        args: [marketAddress, outcomeId, risk, boostBps],
        ...(address ? { account: address } : {})
      })) as {
        totalDebit: bigint;
        payout: bigint;
        fee: bigint;
        price: bigint;
        accepted: boolean;
        reason: string;
      };

      const stakeN = Number(formatUnits(risk, 6));
      const feeN = Number(formatUnits(quote.fee, 6));
      const debitN = Number(formatUnits(quote.totalDebit, 6));
      const payoutN = Number(formatUnits(quote.payout, 6));
      // Always surface engine response (incl. rejected). UI ignores zero debit when !accepted.
      setLiveQuote({
        stake: stakeN,
        fee: feeN,
        totalDebit: debitN,
        payout: payoutN,
        accepted: Boolean(quote.accepted),
        reason: quote.reason
      });
      setQuotedDebit(quote.accepted && debitN > 0 ? quote.totalDebit : 0n);

      if (!quote.accepted) {
        // Do not throw on preview — only block buy/approve. Throwing cleared usable estimates.
        if (opts?.requireWallet) {
          throw new Error(quote.reason || "Quote rejected — market locked or LP reserve insufficient.");
        }
        return {
          quote,
          marketAddress,
          risk,
          boostBps,
          outcomeId,
          allowance: 0n
        };
      }

      let allowance = 0n;
      if (address) {
        allowance = await publicClient.readContract({
          address: getAddress(arcDeployment.usdc),
          abi: usdcAbi,
          functionName: "allowance",
          args: [address, getAddress(arcDeployment.microBoostEngine)]
        });
        setEngineAllowance(allowance);
      }

      return { quote, marketAddress, risk, boostBps, outcomeId, allowance };
    },
    [address, market, publicClient]
  );

  // Refresh allowance + debit estimate when wallet / market changes
  useEffect(() => {
    if (!address || !market) {
      setEngineAllowance(0n);
      setQuotedDebit(0n);
      setLiveQuote(null);
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
      if (!address) throw new Error("Connect wallet in the header first.");
      await ensureArcChain();
      const walletClient = getWalletClient();
      if (!walletClient) throw new Error("Wallet provider unavailable.");
      const { quote } = await quoteBuy(side, stake, boost, { requireWallet: true });
      const approveHash = await walletClient.writeContract({
        address: getAddress(arcDeployment.usdc),
        abi: usdcAbi,
        functionName: "approve",
        args: [getAddress(arcDeployment.microBoostEngine), quote.totalDebit]
      });
      trackTx({ hash: approveHash, kind: "approve", label: "Approve USDC" });
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
      // Wall-clock guard: last-second clicks often mine after lock and still burn gas.
      const lockMs = Date.parse(market.lockTime || "");
      if (Number.isFinite(lockMs) && Date.now() >= lockMs - 2_000) {
        throw new Error(
          "Too close to lock — this market is about to close. Wait for the next open round."
        );
      }
      await ensureArcChain();
      const walletClient = getWalletClient();
      if (!walletClient) throw new Error("Wallet provider unavailable.");

      const { quote, marketAddress, risk, boostBps, outcomeId, allowance } = await quoteBuy(
        side,
        stake,
        boost,
        { requireWallet: true }
      );
      if (!quote.accepted) {
        throw new Error(quote.reason || "Quote rejected — market locked or LP reserve insufficient.");
      }
      if (allowance < quote.totalDebit) {
        throw new Error("Approve USDC first.");
      }

      // Fresh balance: boost fee + stake can exceed what the UI stake field suggests.
      const balance = await publicClient.readContract({
        address: getAddress(arcDeployment.usdc),
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [address]
      });
      if (balance < quote.totalDebit) {
        const need = formatUnits(quote.totalDebit, 6);
        const have = formatUnits(balance, 6);
        throw new Error(
          `Not enough USDC: need ${need} (stake + fee), wallet has ${have}. Fund wallet or lower stake/boost.`
        );
      }

      const hash = await walletClient.writeContract({
        address: getAddress(arcDeployment.microBoostEngine),
        abi: engineAbi,
        functionName: "buyTicket",
        args: [marketAddress, outcomeId, risk, boostBps]
      });
      trackTx({ hash, kind: "buy", label: `Buy ${side} · ${market.question}` });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      // Critical: broadcast hash ≠ success. Reverted buys used to show "Ticket confirmed".
      if (receipt.status !== "success") {
        throw new Error(
          `Transaction reverted on-chain (${hash.slice(0, 10)}…). ` +
            `Common causes: insufficient USDC, market already locked, or allowance too low. No ticket was minted.`
        );
      }
      let ticketId: string | undefined;
      try {
        const logs = parseEventLogs({ abi: engineAbi, logs: receipt.logs, eventName: "TicketBought" });
        ticketId = logs[0]?.args.ticketId?.toString();
      } catch {
        /* ignore */
      }
      if (!ticketId) {
        throw new Error(
          `Tx mined but no TicketBought event (${hash.slice(0, 10)}…). Treat as failed — check explorer.`
        );
      }
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

      void load({ silent: true });

      const gas = receipt.gasUsed ? `${formatUnits(receipt.gasUsed, 0)} units` : "—";
      return { txHash: hash, gas };
    },
    [address, ensureArcChain, getWalletClient, load, market, publicClient, quoteBuy, trackTx]
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
      liveQuote={liveQuote}
      onRetry={() => void load()}
      onBack={() => router.push("/markets")}
      onPreviewQuote={(side, stake, boost) => {
        void quoteBuy(side, stake, boost).catch(() => {
          /* keep last known needsApproval / liveQuote */
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
