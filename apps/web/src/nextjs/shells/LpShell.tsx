"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, getAddress, parseUnits } from "viem";
import { fetchRecentLpLedger, recordLocalLpAction, type LpLedgerRow } from "@/lib/lpDeposits";
import { arcDeployment, poolAbi, usdcAbi } from "@/lib/onchain";
import { waitSuccessfulReceipt } from "@/lib/txReceipt";
import { readableWalletError, useWallet } from "@/lib/wallet";
import { moneyUsdc } from "../mapMarket";
import { LPView, type LpAction, type LpAnyChainSource } from "../views/LPView";

/**
 * Wires LPView → LiquidityPool deposit/withdraw + /api/lp/stats + recent deposits.
 */
export function LpShell({
  initialTvl,
  initialReserved,
  initialAvailable,
  initialApy
}: {
  initialTvl?: number;
  initialReserved?: number;
  initialAvailable?: number;
  initialApy?: number;
}) {
  const { address, getWalletClient, publicClient, ensureArcChain, trackTx } = useWallet();
  const [tvl, setTvl] = useState(initialTvl ?? 0);
  const [reserved, setReserved] = useState(initialReserved ?? 0);
  const [available, setAvailable] = useState(initialAvailable ?? 0);
  const [apy] = useState(initialApy ?? 0);
  const [yourShare, setYourShare] = useState("0%");
  const [ledger, setLedger] = useState<LpLedgerRow[]>([]);
  const [shares, setShares] = useState(0n);
  const [totalShares, setTotalShares] = useState(0n);
  const [managed, setManaged] = useState(0n);
  const [availableAssets, setAvailableAssets] = useState(0n);
  const [allowance, setAllowance] = useState(0n);
  const [usdcBal, setUsdcBal] = useState(0n);

  const utilization = useMemo(() => {
    if (tvl <= 0) return "—";
    return `${((reserved / tvl) * 100).toFixed(2)}%`;
  }, [tvl, reserved]);

  const allowanceUsdc = useMemo(() => Number(formatUnits(allowance, 6)), [allowance]);

  const refresh = useCallback(async () => {
    try {
      const pool = getAddress(arcDeployment.liquidityPool);
      const [totalAssets, reservedAssets, availableOnchain, totalSh, managedAssets] = await Promise.all([
        publicClient.readContract({ address: pool, abi: poolAbi, functionName: "totalAssets" }),
        publicClient.readContract({ address: pool, abi: poolAbi, functionName: "reservedAssets" }),
        publicClient.readContract({ address: pool, abi: poolAbi, functionName: "availableAssets" }),
        publicClient.readContract({ address: pool, abi: poolAbi, functionName: "totalShares" }),
        publicClient.readContract({ address: pool, abi: poolAbi, functionName: "managedAssets" })
      ]);
      // TVL = LP equity (managedAssets), not raw token balance (includes locked user risk / donations).
      setTvl(Number(formatUnits(managedAssets, 6)));
      setReserved(Number(formatUnits(reservedAssets, 6)));
      setAvailable(Number(formatUnits(availableOnchain, 6)));
      setTotalShares(totalSh);
      setManaged(managedAssets);
      setAvailableAssets(availableOnchain);
      void totalAssets; // raw contract balance available if needed later

      if (address) {
        const [sh, bal, allw] = await Promise.all([
          publicClient.readContract({
            address: pool,
            abi: poolAbi,
            functionName: "sharesOf",
            args: [address]
          }),
          publicClient.readContract({
            address: getAddress(arcDeployment.usdc),
            abi: usdcAbi,
            functionName: "balanceOf",
            args: [address]
          }),
          publicClient.readContract({
            address: getAddress(arcDeployment.usdc),
            abi: usdcAbi,
            functionName: "allowance",
            args: [address, pool]
          })
        ]);
        setShares(sh);
        setUsdcBal(bal);
        setAllowance(allw);
        setYourShare(totalSh > 0n ? `${((Number(sh) / Number(totalSh)) * 100).toFixed(2)}%` : "0.00%");
      } else {
        setShares(0n);
        setYourShare("0.00%");
      }
    } catch {
      /* keep SSR seed */
    }
  }, [address, publicClient]);

  const refreshLedger = useCallback(async () => {
    try {
      // Global vault history (all LPs) — last 5 real deposit/withdraw events
      const rows = await fetchRecentLpLedger(publicClient, { limit: 5 });
      setLedger(rows);
    } catch {
      setLedger([]);
    }
  }, [publicClient]);

  useEffect(() => {
    void refresh();
    void refreshLedger();
    const id = window.setInterval(() => {
      void refresh();
      void refreshLedger();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [refresh, refreshLedger]);

  const onAction = useCallback(
    async (action: LpAction, amount: number) => {
      if (!address) return "Connect wallet in the header first.";
      const assets = parseUnits(String(amount || 0), 6);
      if (assets <= 0n) return "Enter an amount greater than zero.";

      try {
        await ensureArcChain();
        const walletClient = getWalletClient();
        if (!walletClient) return "Wallet provider unavailable.";

        if (action === "approve") {
          if (assets > usdcBal) return "Not enough USDC on wallet. Use Deposit / Bridge in the header.";
          const hash = await walletClient.writeContract({
            address: getAddress(arcDeployment.usdc),
            abi: usdcAbi,
            functionName: "approve",
            args: [getAddress(arcDeployment.liquidityPool), assets]
          });
          trackTx({ hash, kind: "approve", label: `Approve ${amount} USDC for LP` });
          await waitSuccessfulReceipt(publicClient, hash);
          await refresh();
          return `Approved ${amount} USDC — now press Deposit USDC.`;
        }

        if (action === "deposit") {
          if (assets > usdcBal) return "Not enough USDC on wallet. Use Deposit / Bridge in the header.";
          if (allowance < assets) return "Approve USDC first.";
          const hash = await walletClient.writeContract({
            address: getAddress(arcDeployment.liquidityPool),
            abi: poolAbi,
            functionName: "deposit",
            args: [assets]
          });
          trackTx({ hash, kind: "deposit", label: `Deposit ${amount} USDC to LP`, amountUsdc: String(amount) });
          await waitSuccessfulReceipt(publicClient, hash);
          recordLocalLpAction({ kind: "Deposit", amountUsdc: amount, tx: hash });
          await refresh();
          await refreshLedger();
          return `Deposited ${amount} USDC to the LP vault.`;
        }

        // withdraw
        if (totalShares <= 0n || managed <= 0n || shares <= 0n) {
          return "No LP shares to withdraw.";
        }
        const sharesNeeded = (assets * totalShares + managed - 1n) / managed;
        if (sharesNeeded > shares) return "Withdrawal exceeds your LP shares.";
        if (assets > availableAssets) return "Not enough available vault liquidity right now.";
        const hash = await walletClient.writeContract({
          address: getAddress(arcDeployment.liquidityPool),
          abi: poolAbi,
          functionName: "withdraw",
          args: [sharesNeeded]
        });
        trackTx({ hash, kind: "other", label: `Withdraw ${amount} USDC from LP`, amountUsdc: String(amount) });
        await waitSuccessfulReceipt(publicClient, hash);
        recordLocalLpAction({ kind: "Withdraw", amountUsdc: amount, tx: hash });
        await refresh();
        await refreshLedger();
        return `Withdrew ${amount} USDC from the LP vault.`;
      } catch (error) {
        return readableWalletError(error);
      }
    },
    [
      address,
      allowance,
      availableAssets,
      ensureArcChain,
      getWalletClient,
      managed,
      publicClient,
      refresh,
      refreshLedger,
      shares,
      totalShares,
      usdcBal
    ]
  );

  const [pendingUbSpend, setPendingUbSpend] = useState<{
    source: LpAnyChainSource;
    amount: string;
    recipientAddress: string;
    sourceWalletAddress?: string;
    depositHash?: string | null;
  } | null>(null);

  const pendingFromStorage = useCallback(
    (p: {
      source: LpAnyChainSource | string;
      amount: string;
      recipientAddress: string;
      sourceWalletAddress?: string;
      depositHash?: string | null;
    }) => ({
      source: p.source as LpAnyChainSource,
      amount: p.amount,
      recipientAddress: p.recipientAddress,
      sourceWalletAddress: p.sourceWalletAddress,
      depositHash: p.depositHash
    }),
    []
  );

  useEffect(() => {
    void import("@/lib/appKit").then(({ loadPendingUbSpend }) => {
      const p = loadPendingUbSpend();
      if (!p) return;
      setPendingUbSpend(pendingFromStorage(p));
    });
  }, [pendingFromStorage]);

  /**
   * Approve + deposit using live on-chain reads (never stale React state).
   * Polls for *balance increase* after bridge/spend (not absolute ≥ amount).
   */
  const finishVaultAfterFund = useCallback(
    async (amount: number, fundMode: string, balanceBefore: bigint) => {
      if (!address) return "Connect wallet in the header first.";
      const assets = parseUnits(String(amount || 0), 6);
      if (assets <= 0n) return "Enter an amount greater than zero.";

      await ensureArcChain();
      const walletClient = getWalletClient();
      if (!walletClient) return "Wallet provider unavailable.";

      const usdc = getAddress(arcDeployment.usdc);
      const pool = getAddress(arcDeployment.liquidityPool);
      const targetBalance = balanceBefore + assets;

      // Poll until bridged/spent amount lands (delta vs pre-fund balance).
      const maxAttempts = 18; // ~45s at 2.5s
      const delayMs = 2500;
      let balanceNow = balanceBefore;
      for (let i = 0; i < maxAttempts; i++) {
        balanceNow = (await publicClient.readContract({
          address: usdc,
          abi: usdcAbi,
          functionName: "balanceOf",
          args: [address]
        })) as bigint;
        if (balanceNow >= targetBalance) break;
        if (i < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      if (balanceNow < targetBalance) {
        await refresh();
        return (
          `⚡ via Circle App Kit (${fundMode}) → Arc OK, but vault deposit paused: ` +
          `USDC has not arrived yet (have ${formatUnits(balanceNow, 6)}, need +${amount} from bridge). ` +
          `Wait a moment, then deposit from the Deposit tab.`
        );
      }

      let allowanceNow = (await publicClient.readContract({
        address: usdc,
        abi: usdcAbi,
        functionName: "allowance",
        args: [address, pool]
      })) as bigint;

      const steps: string[] = [];

      if (allowanceNow < assets) {
        const approveHash = await walletClient.writeContract({
          address: usdc,
          abi: usdcAbi,
          functionName: "approve",
          args: [pool, assets]
        });
        trackTx({ hash: approveHash, kind: "approve", label: `Approve ${amount} USDC for LP` });
        await waitSuccessfulReceipt(publicClient, approveHash);
        steps.push(`Approved ${amount} USDC`);
        allowanceNow = (await publicClient.readContract({
          address: usdc,
          abi: usdcAbi,
          functionName: "allowance",
          args: [address, pool]
        })) as bigint;
        if (allowanceNow < assets) {
          await refresh();
          return `Approve mined but allowance still low — try Deposit USDC manually.`;
        }
      } else {
        steps.push("Allowance already sufficient");
      }

      balanceNow = (await publicClient.readContract({
        address: usdc,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [address]
      })) as bigint;
      if (balanceNow < assets) {
        await refresh();
        return "USDC balance dropped before deposit — check wallet and try Deposit tab.";
      }

      const depositHash = await walletClient.writeContract({
        address: pool,
        abi: poolAbi,
        functionName: "deposit",
        args: [assets]
      });
      trackTx({
        hash: depositHash,
        kind: "deposit",
        label: `Deposit ${amount} USDC to LP`,
        amountUsdc: String(amount)
      });
      await waitSuccessfulReceipt(publicClient, depositHash);
      recordLocalLpAction({ kind: "Deposit", amountUsdc: amount, tx: depositHash });
      steps.push(`Deposited ${amount} USDC to the LP vault`);
      await refresh();
      await refreshLedger();
      return `⚡ via Circle App Kit (${fundMode}) → Arc → vault deposit.\n${steps.join("\n")}`;
    },
    [address, ensureArcChain, getWalletClient, publicClient, refresh, refreshLedger, trackTx]
  );

  const readUsdcBalance = useCallback(async () => {
    if (!address) return 0n;
    return (await publicClient.readContract({
      address: getAddress(arcDeployment.usdc),
      abi: usdcAbi,
      functionName: "balanceOf",
      args: [address]
    })) as bigint;
  }, [address, publicClient]);

  const onAnyChainDeposit = useCallback(
    async (source: LpAnyChainSource, amount: number) => {
      if (!address) return "Connect wallet in the header first (Arc mint + vault deposit target).";
      if (!(amount > 0)) return "Enter an amount greater than zero.";
      try {
        const balanceBefore = await readUsdcBalance();
        const { appKitUnifiedBalanceToArc } = await import("@/lib/appKit");
        const fund = await appKitUnifiedBalanceToArc({
          source,
          amount: String(amount),
          recipientAddress: address,
          purpose: "lp",
          onProgress: () => {
            /* progress surfaced via final message */
          }
        });
        setPendingUbSpend(null);
        return await finishVaultAfterFund(amount, fund.mode, balanceBefore);
      } catch (error) {
        const { UbSpendPendingError, loadPendingUbSpend } = await import("@/lib/appKit");
        if (error instanceof UbSpendPendingError) {
          setPendingUbSpend(pendingFromStorage(error.pending));
          return error.message;
        }
        const pending = loadPendingUbSpend();
        if (pending) setPendingUbSpend(pendingFromStorage(pending));
        return readableWalletError(error);
      }
    },
    [address, finishVaultAfterFund, pendingFromStorage, readUsdcBalance]
  );

  const onCompleteUbSpend = useCallback(async () => {
    if (!address) return "Connect wallet in the header first.";
    const pending = pendingUbSpend;
    if (!pending) return "No pending Unified Balance spend to complete.";
    try {
      const balanceBefore = await readUsdcBalance();
      const { appKitSpendUnifiedBalance } = await import("@/lib/appKit");
      const fund = await appKitSpendUnifiedBalance({
        source: pending.source,
        amount: pending.amount,
        recipientAddress: pending.recipientAddress || address,
        sourceWalletAddress: pending.sourceWalletAddress
      });
      setPendingUbSpend(null);
      const amountNum = Number(pending.amount);
      if (!(amountNum > 0)) {
        return `⚡ Unified Balance spend complete (${fund.hash ?? "ok"}). Deposit into vault manually if needed.`;
      }
      return await finishVaultAfterFund(amountNum, fund.mode, balanceBefore);
    } catch (error) {
      return readableWalletError(error);
    }
  }, [address, finishVaultAfterFund, pendingUbSpend, readUsdcBalance]);

  const onDismissUbSpend = useCallback(() => {
    void import("@/lib/appKit").then(({ clearPendingUbSpend }) => clearPendingUbSpend());
    setPendingUbSpend(null);
  }, []);

  return (
    <LPView
      tvl={moneyUsdc(tvl, 2)}
      reserved={moneyUsdc(reserved, 2)}
      available={moneyUsdc(available, 2)}
      utilization={utilization}
      ledger={ledger}
      apy={apy > 0 ? `${(apy * 100).toFixed(2)}%` : "—"}
      yourShare={yourShare}
      allowanceUsdc={allowanceUsdc}
      onAction={onAction}
      onAnyChainDeposit={onAnyChainDeposit}
      pendingUbSpend={pendingUbSpend}
      onCompleteUbSpend={onCompleteUbSpend}
      onDismissUbSpend={onDismissUbSpend}
    />
  );
}
