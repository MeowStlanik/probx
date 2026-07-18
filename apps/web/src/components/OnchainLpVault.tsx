"use client";

import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, RefreshCcw, ShieldCheck, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatUnits,
  getAddress,
  parseUnits
} from "viem";
import { arcDeployment, poolAbi, usdcAbi } from "@/lib/onchain";
import { readableWalletError, shortHex, useWallet } from "@/lib/wallet";

type VaultSnapshot = {
  usdcBalance: bigint;
  allowance: bigint;
  shares: bigint;
  totalShares: bigint;
  totalAssets: bigint;
  managedAssets: bigint;
  availableAssets: bigint;
  reservedAssets: bigint;
};

const emptySnapshot: VaultSnapshot = {
  usdcBalance: 0n,
  allowance: 0n,
  shares: 0n,
  totalShares: 0n,
  totalAssets: 0n,
  managedAssets: 0n,
  availableAssets: 0n,
  reservedAssets: 0n
};

export function OnchainLpVault() {
  const {
    address: account,
    connecting,
    wrongNetwork,
    connect,
    getWalletClient,
    publicClient
  } = useWallet();

  const [depositAmount, setDepositAmount] = useState("1");
  const [withdrawAmount, setWithdrawAmount] = useState("0.1");
  const [snapshot, setSnapshot] = useState<VaultSnapshot>(emptySnapshot);
  const [message, setMessage] = useState("Connect wallet once in the header — LP uses the same session.");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);

  const depositAssets = useMemo(() => parseUsdcSafe(depositAmount), [depositAmount]);
  const withdrawAssets = useMemo(() => parseUsdcSafe(withdrawAmount), [withdrawAmount]);
  const maxWithdrawAssets = useMemo(() => maxWithdrawableAssets(snapshot), [snapshot]);
  const withdrawShares = useMemo(() => sharesForAssets(withdrawAssets, snapshot), [snapshot, withdrawAssets]);

  const needsApproval = account && depositAssets > 0n && snapshot.allowance < depositAssets;
  const depositError = depositValidation(depositAssets, snapshot.usdcBalance, wrongNetwork);
  const withdrawError = withdrawValidation(withdrawAssets, withdrawShares, maxWithdrawAssets, snapshot.shares, wrongNetwork);
  const canDeposit = Boolean(account && !depositError && !needsApproval && !busy);
  const canApprove = Boolean(account && !depositError && needsApproval && !busy);
  const canWithdraw = Boolean(account && !withdrawError && !busy);

  const refresh = useCallback(async (address = account) => {
    try {
      const [totalAssets, managedAssets, availableAssets, reservedAssets, totalShares] = await Promise.all([
        publicClient.readContract({ address: getAddress(arcDeployment.liquidityPool), abi: poolAbi, functionName: "totalAssets" }),
        publicClient.readContract({ address: getAddress(arcDeployment.liquidityPool), abi: poolAbi, functionName: "managedAssets" }),
        publicClient.readContract({ address: getAddress(arcDeployment.liquidityPool), abi: poolAbi, functionName: "availableAssets" }),
        publicClient.readContract({ address: getAddress(arcDeployment.liquidityPool), abi: poolAbi, functionName: "reservedAssets" }),
        publicClient.readContract({ address: getAddress(arcDeployment.liquidityPool), abi: poolAbi, functionName: "totalShares" })
      ]);

      if (!address) {
        setSnapshot((current) => ({
          ...current,
          usdcBalance: 0n,
          allowance: 0n,
          shares: 0n,
          totalAssets,
          managedAssets,
          availableAssets,
          reservedAssets,
          totalShares
        }));
        return;
      }

      const [usdcBalance, allowance, shares] = await Promise.all([
        publicClient.readContract({ address: getAddress(arcDeployment.usdc), abi: usdcAbi, functionName: "balanceOf", args: [address] }),
        publicClient.readContract({
          address: getAddress(arcDeployment.usdc),
          abi: usdcAbi,
          functionName: "allowance",
          args: [address, getAddress(arcDeployment.liquidityPool)]
        }),
        publicClient.readContract({
          address: getAddress(arcDeployment.liquidityPool),
          abi: poolAbi,
          functionName: "sharesOf",
          args: [address]
        })
      ]);

      setSnapshot({ usdcBalance, allowance, shares, totalShares, totalAssets, managedAssets, availableAssets, reservedAssets });
    } catch (error) {
      setMessage(readableVaultError(error));
    }
  }, [account, publicClient]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 12_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (account) {
      setMessage(`${shortHex(account)} connected — vault balances load automatically.`);
    } else {
      setMessage("Connect wallet once in the header — LP uses the same session.");
    }
  }, [account]);

  async function handleConnect() {
    setBusy(true);
    try {
      const next = await connect();
      setMessage(next ? `${shortHex(next)} connected. Vault balances loaded.` : "No wallet account selected.");
      await refresh(next);
    } catch (error) {
      setMessage(readableVaultError(error));
    } finally {
      setBusy(false);
    }
  }

  async function approveDeposit() {
    if (!account || depositAssets <= 0n) return;
    const walletClient = getWalletClient();
    if (!walletClient) {
      setMessage("Wallet provider unavailable.");
      return;
    }
    setBusy(true);
    try {
      const hash = await walletClient.writeContract({
        address: getAddress(arcDeployment.usdc),
        abi: usdcAbi,
        functionName: "approve",
        args: [getAddress(arcDeployment.liquidityPool), depositAssets]
      });
      setTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      setMessage(`Approved ${formatUsdc6(depositAssets)} for LP vault.`);
      await refresh(account);
    } catch (error) {
      setMessage(readableVaultError(error));
    } finally {
      setBusy(false);
    }
  }

  async function deposit() {
    if (!account || !canDeposit) return;
    const walletClient = getWalletClient();
    if (!walletClient) {
      setMessage("Wallet provider unavailable.");
      return;
    }
    setBusy(true);
    try {
      const hash = await walletClient.writeContract({
        address: getAddress(arcDeployment.liquidityPool),
        abi: poolAbi,
        functionName: "deposit",
        args: [depositAssets]
      });
      setTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      setMessage(`Deposited ${formatUsdc6(depositAssets)} into LP vault.`);
      await refresh(account);
    } catch (error) {
      setMessage(readableVaultError(error));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!account || !canWithdraw) return;
    const walletClient = getWalletClient();
    if (!walletClient) {
      setMessage("Wallet provider unavailable.");
      return;
    }
    setBusy(true);
    try {
      const hash = await walletClient.writeContract({
        address: getAddress(arcDeployment.liquidityPool),
        abi: poolAbi,
        functionName: "withdraw",
        args: [withdrawShares]
      });
      setTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      setMessage(`Withdrew about ${formatUsdc6(withdrawAssets)} from LP vault.`);
      await refresh(account);
    } catch (error) {
      setMessage(readableVaultError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="lpActions">
      <div className="lpActionPanel">
        <div className="surfaceHeader">
          <div>
            <h2>Deposit USDC</h2>

          </div>
          <button className="iconOnly" onClick={() => void refresh()} type="button" aria-label="Refresh LP vault">
            <RefreshCcw size={18} aria-hidden />
          </button>
        </div>
        <div className="amountInput">
          <input inputMode="decimal" onChange={(event) => setDepositAmount(event.target.value)} type="number" value={depositAmount} />
          <span>USDC</span>
        </div>
        <div className="feeRow">
          <span>Wallet USDC</span>
          <strong>{formatUsdc6(snapshot.usdcBalance)}</strong>
        </div>
        <div className="feeRow">
          <span>Approved to vault</span>
          <strong>{formatUsdc6(snapshot.allowance)}</strong>
        </div>
        {!account ? (
          <button className="confirmButton" disabled={busy || connecting} onClick={() => void handleConnect()} type="button">
            <Wallet size={18} aria-hidden />
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        ) : needsApproval ? (
          <button className="confirmButton" disabled={!canApprove} onClick={() => void approveDeposit()} type="button">
            <ShieldCheck size={18} aria-hidden />
            {busy ? "Approving..." : `Approve ${formatUsdc6(depositAssets)}`}
          </button>
        ) : (
          <button className="confirmButton" disabled={!canDeposit} onClick={() => void deposit()} type="button">
            <ArrowDownToLine size={18} aria-hidden />
            {busy ? "Depositing..." : "Deposit into vault"}
          </button>
        )}
        {depositError && account ? <p className="settlementNote">{depositError}</p> : null}
      </div>

      <div className="lpActionPanel">
        <h2>Withdraw USDC</h2>
        <div className="amountInput">
          <input inputMode="decimal" onChange={(event) => setWithdrawAmount(event.target.value)} type="number" value={withdrawAmount} />
          <span>USDC</span>
        </div>
        <div className="feeRow">
          <span>Your LP shares</span>
          <strong>{formatUsdc6(snapshot.shares)}</strong>
        </div>
        <div className="feeRow">
          <span>Max withdrawable now</span>
          <strong>{formatUsdc6(maxWithdrawAssets)}</strong>
        </div>
        <div className="feeRow">
          <span>Shares to burn</span>
          <strong>{formatUsdc6(withdrawShares)}</strong>
        </div>
        <button className="iconButton" disabled={!canWithdraw} onClick={() => void withdraw()} type="button">
          <ArrowUpFromLine size={18} aria-hidden />
          {busy ? "Withdrawing..." : "Withdraw available liquidity"}
        </button>
        {withdrawError && account ? <p className="settlementNote">{withdrawError}</p> : null}
      </div>

      <div className="lpActionPanel lpStatusPanel">
        <h2>Your vault position</h2>
        <div className="feeRow">
          <span>Wallet</span>
          <strong>{account ? shortHex(account) : "Not connected"}</strong>
        </div>
        <div className="feeRow">
          <span>Vault total assets</span>
          <strong>{formatUsdc6(snapshot.totalAssets)}</strong>
        </div>
        <div className="feeRow">
          <span>Managed assets</span>
          <strong>{formatUsdc6(snapshot.managedAssets)}</strong>
        </div>
        <div className="feeRow">
          <span>Available assets</span>
          <strong>{formatUsdc6(snapshot.availableAssets)}</strong>
        </div>
        <p className="settlementNote">{busy ? "Waiting for transaction confirmation..." : message}</p>
        {txHash ? (
          <a className="txLink" href={`${arcDeployment.explorerUrl}/tx/${txHash}`} target="_blank">
            View tx <ExternalLink size={13} aria-hidden />
          </a>
        ) : null}
      </div>
    </section>
  );
}

function depositValidation(amount: bigint, balance: bigint, wrongNetwork: boolean): string | null {
  if (wrongNetwork) return `Wrong network. Switch to ${arcDeployment.chainName}.`;
  if (amount <= 0n) return "Enter a deposit amount greater than zero.";
  if (amount > balance) {
    return "Not enough USDC on your wallet for this deposit. Use “Add funds” in the header, then try again.";
  }
  return null;
}

function withdrawValidation(
  amount: bigint,
  sharesNeeded: bigint,
  maxAssets: bigint,
  userShares: bigint,
  wrongNetwork: boolean
): string | null {
  if (wrongNetwork) return `Wrong network. Switch to ${arcDeployment.chainName}.`;
  if (amount <= 0n) return "Enter a withdrawal amount greater than zero.";
  if (userShares <= 0n) return "This wallet has no LP shares to withdraw.";
  if (amount > maxAssets) return "Withdrawal amount exceeds your withdrawable LP position or currently available vault liquidity.";
  if (sharesNeeded > userShares) return "Withdrawal would burn more LP shares than this wallet owns.";
  return null;
}

function maxWithdrawableAssets(snapshot: VaultSnapshot): bigint {
  if (snapshot.totalShares <= 0n || snapshot.shares <= 0n) return 0n;
  const userManagedAssets = (snapshot.shares * snapshot.managedAssets) / snapshot.totalShares;
  return userManagedAssets < snapshot.availableAssets ? userManagedAssets : snapshot.availableAssets;
}

function sharesForAssets(assets: bigint, snapshot: VaultSnapshot): bigint {
  if (assets <= 0n || snapshot.totalShares <= 0n || snapshot.managedAssets <= 0n) return 0n;
  return ceilDiv(assets * snapshot.totalShares, snapshot.managedAssets);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return denominator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function parseUsdcSafe(value: string): bigint {
  try {
    return parseUnits(value || "0", 6);
  } catch {
    return 0n;
  }
}

function formatUsdc6(value: bigint): string {
  return `${Number(formatUnits(value, 6)).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`;
}

function readableVaultError(error: unknown): string {
  const message = readableWalletError(error);
  if (message.includes("SHARES")) return "Withdrawal amount is larger than this wallet's LP shares.";
  if (message.includes("RESERVED")) return "Vault liquidity is reserved for payouts, so this amount is not withdrawable now.";
  if (message.includes("TRANSFER_FROM")) {
    return "USDC transfer failed — not enough USDC on your wallet, or allowance is missing.";
  }
  return message;
}
