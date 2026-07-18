"use client";

import { ArrowRightLeft, Loader2, Wallet, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  parseUnits
} from "viem";
import { apiUrl } from "@/lib/api";
import {
  addressToBytes32,
  emptyBytes32,
  erc20ApproveAbi,
  fetchCctpConfig,
  fetchCctpQuote,
  pollCctpStatus,
  tokenMessengerAbi,
  type CctpConfig,
  type CctpSourceKey
} from "@/lib/cctp";
import { arcDeployment } from "@/lib/onchain";
import { readableWalletError, shortHex, useWallet } from "@/lib/wallet";

type FundTab = "direct" | "bridge";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Which tab to show when the modal opens (from wallet popover Deposit / Bridge). */
  initialTab?: FundTab;
};

type Step =
  | "idle"
  | "quote"
  | "switch"
  | "approve"
  | "burn"
  | "attestation"
  | "done"
  | "error";

export function FundUsdcPanel({ open, onClose, initialTab = "direct" }: Props) {
  const {
    address: mintTo,
    refreshBalance,
    mode: sessionMode,
    email: sessionEmail,
    hasProvider
  } = useWallet();
  const [tab, setTab] = useState<FundTab>(initialTab);
  const [config, setConfig] = useState<CctpConfig | null>(null);
  const [source, setSource] = useState<CctpSourceKey>("baseSepolia");
  const [amount, setAmount] = useState("1");
  const [step, setStep] = useState<Step>("idle");
  const [message, setMessage] = useState("");
  const [burnTx, setBurnTx] = useState<string | null>(null);
  const [mintTx, setMintTx] = useState<string | null>(null);
  const [sourceUsdc, setSourceUsdc] = useState<bigint | null>(null);
  const [cctpSourceAddress, setCctpSourceAddress] = useState<`0x${string}` | null>(null);
  const [cctpConnecting, setCctpConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setMessage("");
    setStep("idle");
    document.body.classList.add("fundModalOpen");
    return () => document.body.classList.remove("fundModalOpen");
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    void fetchCctpConfig()
      .then(setConfig)
      .catch((error) => setMessage(readableWalletError(error)));
  }, [open]);

  const sourceCfg = config?.sources[source];
  const destCfg = config?.destination;
  const demoFundEnabled = Boolean(
    (config as CctpConfig & { demoFund?: { enabled?: boolean } })?.demoFund?.enabled
  );

  const amountUnits = useMemo(() => {
    try {
      return parseUnits(amount || "0", 6);
    } catch {
      return 0n;
    }
  }, [amount]);

  const copyAddress = useCallback(async () => {
    if (!mintTo) return;
    try {
      await navigator.clipboard.writeText(mintTo);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setMessage("Could not copy — select the address manually.");
    }
  }, [mintTo]);

  const refreshSourceBalance = useCallback(async (ownerAddress?: `0x${string}` | null) => {
    const owner = ownerAddress ?? cctpSourceAddress;
    if (!sourceCfg || !owner) {
      setSourceUsdc(null);
      return;
    }
    try {
      const client = createPublicClient({
        chain: {
          id: sourceCfg.id,
          name: sourceCfg.name,
          nativeCurrency: sourceCfg.nativeCurrency,
          rpcUrls: { default: { http: [sourceCfg.rpcUrl] } }
        },
        transport: http(sourceCfg.rpcUrl)
      });
      const bal = await client.readContract({
        address: sourceCfg.usdc as `0x${string}`,
        abi: erc20ApproveAbi,
        functionName: "balanceOf",
        args: [owner]
      });
      setSourceUsdc(bal);
    } catch {
      setSourceUsdc(null);
    }
  }, [cctpSourceAddress, sourceCfg]);

  useEffect(() => {
    if (!open || tab !== "bridge") return;
    void refreshSourceBalance();
  }, [open, refreshSourceBalance, source, tab, cctpSourceAddress]);

  const ensureSourceChain = useCallback(async () => {
    if (!window.ethereum || !sourceCfg) throw new Error("Install a browser wallet to fund via CCTP.");
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: `0x${sourceCfg.id.toString(16)}`,
          chainName: sourceCfg.name,
          rpcUrls: [sourceCfg.rpcUrl],
          nativeCurrency: sourceCfg.nativeCurrency,
          blockExplorerUrls: [sourceCfg.explorerUrl]
        }
      ]
    });
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${sourceCfg.id.toString(16)}` }]
      });
    } catch {
      // already added
    }
  }, [sourceCfg]);

  /** MetaMask for CCTP source burn only (does not change ProbX session). */
  const connectCctpSource = useCallback(async () => {
    if (!window.ethereum) {
      setMessage("Install a browser wallet for the CCTP burn side.");
      return null;
    }
    setCctpConnecting(true);
    setMessage("");
    try {
      if (sourceCfg) await ensureSourceChain();
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const next = accounts[0] ? getAddress(accounts[0]) : null;
      setCctpSourceAddress(next);
      if (next) {
        await refreshSourceBalance(next);
        setMessage(`CCTP source: ${shortHex(next)}`);
      }
      return next;
    } catch (error) {
      setMessage(readableWalletError(error));
      return null;
    } finally {
      setCctpConnecting(false);
    }
  }, [ensureSourceChain, refreshSourceBalance, sessionMode, sourceCfg]);

  const runDemoFund = useCallback(async () => {
    if (!mintTo) {
      setMessage("Connect an Arc wallet first (email or browser wallet).");
      return;
    }
    setBusy(true);
    setBurnTx(null);
    setMintTx(null);
    try {
      setStep("burn");
      setMessage("Server CCTP: burning Base Sepolia USDC from demo treasury → Arc…");
      const response = await fetch(apiUrl("/api/cctp/demo-fund"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mintTo, amountUsdc: amount || "2" })
      });
      const payload = (await response.json()) as {
        error?: string;
        burnTxHash?: string;
        forwardTxHash?: string;
      };
      if (!response.ok) throw new Error(payload.error || `Demo fund HTTP ${response.status}`);
      if (payload.burnTxHash) setBurnTx(payload.burnTxHash);
      if (payload.forwardTxHash) setMintTx(payload.forwardTxHash);
      setStep("done");
      setMessage(
        payload.forwardTxHash
          ? "Demo CCTP complete — USDC minted on Arc. Keep a little for gas."
          : "Burn sent — mint may still finalize; refresh balance in a minute."
      );
      await refreshBalance();
    } catch (error) {
      setStep("error");
      setMessage(readableWalletError(error));
    } finally {
      setBusy(false);
    }
  }, [amount, mintTo, refreshBalance]);

  const runFund = useCallback(async () => {
    if (!config || !sourceCfg || !destCfg) {
      setMessage("CCTP config not loaded.");
      return;
    }
    if (!mintTo) {
      setMessage("Connect wallet in the header first — mint goes to that Arc address.");
      return;
    }
    if (!window.ethereum) {
      setMessage("Browser wallet is required on the source chain (Base/Eth Sepolia) to burn USDC.");
      return;
    }
    if (amountUnits <= 0n) {
      setMessage("Enter an amount greater than 0.");
      return;
    }

    setBusy(true);
    setBurnTx(null);
    setMintTx(null);
    try {
      setStep("quote");
      setMessage("Quoting CCTP forwarding fees…");
      const quote = await fetchCctpQuote(source, amountUnits);
      const totalBurn = BigInt(quote.totalBurn);
      const maxFee = BigInt(quote.maxFee);

      setStep("switch");
      setMessage(`Switch wallet network to ${sourceCfg.name}…`);
      await ensureSourceChain();

      let from = cctpSourceAddress;
      if (!from) {
        const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
        from = accounts[0] ? getAddress(accounts[0]) : null;
        if (from) setCctpSourceAddress(from);
      }
      if (!from) throw new Error("Connect browser wallet for CCTP source (burn side) first.");

      const chain = {
        id: sourceCfg.id,
        name: sourceCfg.name,
        nativeCurrency: sourceCfg.nativeCurrency,
        rpcUrls: { default: { http: [sourceCfg.rpcUrl] } }
      } as const;

      const walletClient = createWalletClient({
        account: from,
        chain,
        transport: custom(window.ethereum)
      });
      const publicClient = createPublicClient({
        chain,
        transport: http(sourceCfg.rpcUrl)
      });

      setStep("approve");
      setMessage(`Approve ${formatUnits(totalBurn, 6)} USDC on ${sourceCfg.name} from ${shortHex(from)}…`);
      const approveHash = await walletClient.writeContract({
        address: sourceCfg.usdc as `0x${string}`,
        abi: erc20ApproveAbi,
        functionName: "approve",
        args: [sourceCfg.tokenMessengerV2 as `0x${string}`, totalBurn]
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });

      setStep("burn");
      setMessage(`Burning USDC → mint to ProbX Arc ${shortHex(mintTo)}…`);
      const burnHash = await walletClient.writeContract({
        address: sourceCfg.tokenMessengerV2 as `0x${string}`,
        abi: tokenMessengerAbi,
        functionName: "depositForBurnWithHook",
        args: [
          totalBurn,
          destCfg.domain,
          addressToBytes32(mintTo),
          sourceCfg.usdc as `0x${string}`,
          emptyBytes32(),
          maxFee,
          quote.finalityThreshold || 1000,
          config.forwardingHookData
        ]
      });
      setBurnTx(burnHash);
      await publicClient.waitForTransactionReceipt({ hash: burnHash });

      setStep("attestation");
      setMessage("Waiting for Circle Forwarding Service mint on Arc…");
      const started = Date.now();
      let forwardTx: string | undefined;
      while (Date.now() - started < 8 * 60_000) {
        const status = await pollCctpStatus(sourceCfg.domain, burnHash);
        if (status.status === "forwarded" && status.forwardTxHash) {
          forwardTx = status.forwardTxHash;
          break;
        }
        if (status.status === "attested") {
          setMessage(
            "Attestation ready. Forwarding mint not seen yet — USDC may still arrive shortly on Arc."
          );
        }
        await new Promise((r) => setTimeout(r, 5000));
      }

      if (forwardTx) {
        setMintTx(forwardTx);
        setStep("done");
        setMessage(`USDC minted on Arc to ${shortHex(mintTo)}.`);
      } else {
        setStep("done");
        setMessage(
          "Burn confirmed. Mint may still be finalizing — refresh Arc balance in a minute."
        );
      }
      await refreshBalance();
      await refreshSourceBalance(from);
    } catch (error) {
      setStep("error");
      setMessage(readableWalletError(error));
    } finally {
      setBusy(false);
    }
  }, [
    amountUnits,
    config,
    cctpSourceAddress,
    destCfg,
    ensureSourceChain,
    mintTo,
    refreshBalance,
    refreshSourceBalance,
    sessionMode,
    source,
    sourceCfg
  ]);

  if (!open || !mounted) return null;

  const modal = (
    <div
      className="fundModalBackdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Add USDC to wallet"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className={tab === "bridge" ? "fundModal isBridge" : "fundModal"}
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="fundModalClose"
          onClick={onClose}
          aria-label="Close"
          disabled={busy}
        >
          <X size={16} />
        </button>

        <span className="eyebrow">Fund wallet</span>
        <h3 className="fundModalTitle">Get USDC on Arc</h3>
        <p className="fundModalSub">
          {tab === "bridge"
            ? "Bridge via CCTP from Base / Eth Sepolia."
            : "Deposit Arc testnet USDC to your session."}
        </p>

        <div className="fundTabs" role="tablist" aria-label="Fund method">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "direct"}
            className={`fundTab ${tab === "direct" ? "isActive" : ""}`}
            onClick={() => {
              setTab("direct");
              setMessage("");
              setStep("idle");
            }}
          >
            ⊟ Direct on Arc
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "bridge"}
            className={`fundTab ${tab === "bridge" ? "isActive" : ""}`}
            onClick={() => {
              setTab("bridge");
              setMessage("");
              setStep("idle");
            }}
          >
            ⇄ Bridge (CCTP)
          </button>
        </div>

        <div className="fundModalBody">
          {tab === "direct" ? (
            <div className="fundPanelCard">
              <label className="fundField">
                <span>Your Arc wallet address</span>
                <div className="fundAddressRow fundAddressBox">
                  <code className="fundAddressCode" title={mintTo ?? undefined}>
                    {mintTo ?? "Connect wallet first"}
                  </code>
                  <button
                    type="button"
                    className="fundCopyBtn"
                    disabled={!mintTo}
                    onClick={() => void copyAddress()}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </label>
              <p className="fundHint">
                Send <strong>native Arc Testnet USDC</strong> to the address above (same chain as ProbX
                markets). Or claim test USDC from the Circle faucet for Arc, then transfer if needed.
              </p>
              <ul className="fundDirectList">
                <li>
                  Network: <strong>{arcDeployment.chainName}</strong> (chain id {arcDeployment.chainId})
                </li>
                <li>
                  Token: Arc USDC{" "}
                  <code className="inlineCode">{shortHex(arcDeployment.usdc)}</code>
                </li>
                <li>Keep a small buffer for gas when you claim later.</li>
              </ul>
              <div className="fundLinkRow">
                <a
                  className="fundLinkBtn"
                  href={config?.faucetUrl ?? "https://faucet.circle.com"}
                  target="_blank"
                  rel="noreferrer"
                >
                  Circle faucet ↗
                </a>
                <a
                  className="fundLinkBtn"
                  href={`${arcDeployment.explorerUrl}/address/${mintTo ?? ""}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in explorer ↗
                </a>
              </div>
              <p className="fundHint fundHintTight">
                After a transfer lands, hit refresh on your balance in the header.
              </p>
            </div>
          ) : (
            <div className="fundPanelCard">
              <div className="fundBridgeRoles">
                <div className="fundRoleCard">
                  <span className="fundRoleLabel">Mint to (ProbX session)</span>
                  <strong>
                    {mintTo ? shortHex(mintTo) : "Connect email/Circle in header first"}
                  </strong>
                  <small>
                    {sessionMode === "embedded"
                      ? `Circle / email${sessionEmail ? ` · ${sessionEmail}` : ""}`
                      : sessionMode === "injected"
                        ? "Browser wallet (also used for trade)"
                        : "No session"}
                  </small>
                </div>
                <div className="fundRoleCard">
                  <span className="fundRoleLabel">Burn from (CCTP)</span>
                  <strong>
                    {cctpSourceAddress ? shortHex(cctpSourceAddress) : "Not connected"}
                  </strong>
                </div>
              </div>

              <div className="fundBridgeConnect">
                <button
                  type="button"
                  className="fundLinkBtn fundLinkBtnFull"
                  disabled={busy || cctpConnecting || !hasProvider}
                  onClick={() => void connectCctpSource()}
                >
                  {cctpConnecting ? <Loader2 size={15} className="spinIcon" /> : <Wallet size={15} aria-hidden />}
                  {!hasProvider
                    ? "Install wallet"
                    : cctpSourceAddress
                      ? `Source · ${shortHex(cctpSourceAddress)}`
                      : "⊟ Connect source wallet"}
                </button>
              </div>

              <label className="fundField">
                <span>Source chain (burn side)</span>
                <select
                  value={source}
                  disabled={busy}
                  onChange={(event) => setSource(event.target.value as CctpSourceKey)}
                >
                  <option value="baseSepolia">Base Sepolia (recommended)</option>
                  <option value="ethereumSepolia">Ethereum Sepolia</option>
                </select>
              </label>

              <label className="fundField">
                <span>Amount (USDC to receive ≈)</span>
                <input
                  inputMode="decimal"
                  value={amount}
                  disabled={busy}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="1"
                />
              </label>

              <p className="fundHint">
                Source USDC:{" "}
                {sourceUsdc === null ? "—" : `${formatUnits(sourceUsdc, 6)} USDC`}
                {" · "}
                <a
                  href={config?.faucetUrl ?? "https://faucet.circle.com"}
                  target="_blank"
                  rel="noreferrer"
                >
                  Circle faucet ↗
                </a>
              </p>
            </div>
          )}

          {message ? <p className={`fundStatus step-${step}`}>{message}</p> : null}
          {tab === "bridge" && burnTx && sourceCfg ? (
            <p className="fundHint">
              Burn tx:{" "}
              <a href={`${sourceCfg.explorerUrl}/tx/${burnTx}`} target="_blank" rel="noreferrer">
                {shortHex(burnTx)}
              </a>
            </p>
          ) : null}
          {tab === "bridge" && mintTx && destCfg ? (
            <p className="fundHint">
              Arc mint:{" "}
              <a href={`${destCfg.explorerUrl}/tx/${mintTx}`} target="_blank" rel="noreferrer">
                {shortHex(mintTx)}
              </a>
            </p>
          ) : null}
        </div>

        <footer className="fundModalFooter">
          <button type="button" className="fundFooterBtn secondary" disabled={busy} onClick={onClose}>
            Close
          </button>
          {tab === "direct" ? (
            <button
              type="button"
              className="fundFooterBtn primary"
              disabled={!mintTo}
              onClick={() => void copyAddress()}
            >
              {copied ? "Address copied" : "Copy Arc address"}
            </button>
          ) : (
            <>
              {demoFundEnabled ? (
                <button
                  type="button"
                  className="fundFooterBtn secondary"
                  disabled={busy || !mintTo}
                  onClick={() => void runDemoFund()}
                  title="Burns from server treasury on Base Sepolia"
                >
                  {busy ? <Loader2 size={16} className="spinIcon" /> : null}
                  Server fund
                </button>
              ) : null}
              <button
                type="button"
                className="fundFooterBtn primary"
                disabled={busy || !mintTo || !cctpSourceAddress || amountUnits <= 0n}
                onClick={() => void runFund()}
              >
                {busy ? <Loader2 size={16} className="spinIcon" /> : <ArrowRightLeft size={16} />}
                {busy ? "Working…" : "Bridge CCTP"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

