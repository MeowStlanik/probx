"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, getAddress, parseUnits } from "viem";
import { fetchRecentLpLedger, recordLocalLpAction, type LpLedgerRow } from "@/lib/lpDeposits";
import { arcDeployment, poolAbi, usdcAbi } from "@/lib/onchain";
import { readableWalletError, useWallet } from "@/lib/wallet";
import { moneyUsdc } from "../mapMarket";
import { LPView, type LpAction } from "../views/LPView";

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
  const { address, getWalletClient, publicClient, ensureArcChain } = useWallet();
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
      setTvl(Number(formatUnits(totalAssets, 6)));
      setReserved(Number(formatUnits(reservedAssets, 6)));
      setAvailable(Number(formatUnits(availableOnchain, 6)));
      setTotalShares(totalSh);
      setManaged(managedAssets);
      setAvailableAssets(availableOnchain);

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
          await publicClient.waitForTransactionReceipt({ hash });
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
          await publicClient.waitForTransactionReceipt({ hash });
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
        await publicClient.waitForTransactionReceipt({ hash });
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
    />
  );
}
