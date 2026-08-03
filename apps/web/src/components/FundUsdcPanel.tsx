"use client";

import { ArrowRightLeft, Loader2, Wallet, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type FundTab = "direct" | "bridge" | "send";

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

type DemoFundOpMemo = {
  uuid: string;
  mintTo: string;
  amountUsdc: string;
  /** Set once the server reports a burn — recovery must resume this, never re-burn it. */
  burnTxHash?: string;
  /**
   * `pending`   — no burn yet; the UUID may be reused to retry the same request.
   * `broadcast` — burn is on Base Sepolia, mint on Arc not observed yet.
   * `forwarded` — Circle minted on Arc; the operation is finished and may be cleared.
   *
   * Clearing at `broadcast` (as this did before) is the dangerous case: the mint wait
   * runs for minutes, and a refresh inside that window would drop the UUID and let the
   * next click start a second burn.
   */
  status: "pending" | "broadcast" | "forwarded";
};

const DEMO_FUND_OP_KEY = "probx.cctp.demoFundOp.v1";

/** Survives refresh so an interrupted burn is retried, not duplicated. */
function readDemoOpMemo(): DemoFundOpMemo | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEMO_FUND_OP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DemoFundOpMemo>;
    if (!parsed?.uuid || !parsed.mintTo || !parsed.amountUsdc) return null;
    const status =
      parsed.status === "broadcast" || parsed.status === "forwarded" ? parsed.status : "pending";
    return {
      uuid: String(parsed.uuid),
      mintTo: String(parsed.mintTo),
      amountUsdc: String(parsed.amountUsdc),
      burnTxHash: parsed.burnTxHash ? String(parsed.burnTxHash) : undefined,
      status
    };
  } catch {
    return null;
  }
}

function writeDemoOpMemo(memo: DemoFundOpMemo | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!memo || memo.status === "forwarded") {
      // Only a completed mint retires the record — the next click is a new funding.
      window.localStorage.removeItem(DEMO_FUND_OP_KEY);
      return;
    }
    window.localStorage.setItem(DEMO_FUND_OP_KEY, JSON.stringify(memo));
  } catch {
    // Private mode / quota — in-memory ref still covers the common retry path.
  }
}

export function FundUsdcPanel({ open, onClose, initialTab = "direct" }: Props) {
  const {
    address: mintTo,
    embeddedAddress,
    refreshBalance,
    mode: sessionMode,
    email: sessionEmail,
    sessionToken,
    hasProvider,
    usdcBalance,
    sendUsdc,
    pollTxStatus
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

  // Send-USDC tab state
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendStatus, setSendStatus] = useState<"idle" | "pending" | "confirmed" | "failed">("idle");
  const [sendTx, setSendTx] = useState<string | null>(null);
  const [sendError, setSendError] = useState("");

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

  /**
   * In-flight demo-fund op: reuse UUID only for retry of the *same* operation
   * (network error before success). Every new funding-click gets a fresh UUID.
   *
   * Mirrored into localStorage: a refresh or tab crash mid-burn would otherwise lose the
   * key, and the next click would start a *second* burn instead of recovering the first —
   * the server can only deduplicate operations it is asked about by the same key.
   */
  const demoOpRef = useRef<DemoFundOpMemo | null>(null);

  // Restore an unfinished op on mount so a refresh resumes instead of re-burning.
  useEffect(() => {
    if (demoOpRef.current) return;
    const restored = readDemoOpMemo();
    if (restored && restored.status !== "forwarded") {
      demoOpRef.current = restored;
      // Surface an interrupted funding so the user resumes it instead of starting over.
      if (restored.burnTxHash) {
        setBurnTx(restored.burnTxHash);
        setMessage(
          "Found an unfinished funding from a previous session — its burn is already on chain. " +
            "Reuse the same amount to resume; starting a different one abandons it."
        );
      }
    }
  }, []);

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
      const amountUsdc = amount || "2";
      // Reuse the UUID only for the *same* unfinished funding — that is what lets the
      // server recognise a retry instead of burning again. Anything else gets a new one.
      let idempotencyKey: string;
      const prev = demoOpRef.current;
      if (
        prev &&
        prev.status !== "forwarded" &&
        prev.mintTo.toLowerCase() === mintTo.toLowerCase() &&
        prev.amountUsdc === amountUsdc
      ) {
        idempotencyKey = prev.uuid;
      } else {
        idempotencyKey =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
        demoOpRef.current = {
          uuid: idempotencyKey,
          mintTo,
          amountUsdc,
          status: "pending"
        };
        writeDemoOpMemo(demoOpRef.current);
      }

      // Mint recipient must be the Circle (embedded) wallet whenever the user signed in
      // by email — even if MetaMask is connected as the *source* of the bridged USDC.
      // `mintTo`/`address` from useWallet gets overwritten to the injected address when a
      // wallet is connected as a source, which previously sent funds to MetaMask by mistake.
      const emailSession = sessionEmail && sessionToken ? { email: sessionEmail, token: sessionToken } : null;
      const recipient = emailSession ? (embeddedAddress ?? mintTo) : mintTo;

      const body: Record<string, string> = {
        mintTo: recipient,
        amountUsdc,
        idempotencyKey
      };
      if (emailSession) {
        // Circle path: session proves control of the wallet; recipient is the Circle wallet.
        body.email = emailSession.email;
        body.sessionToken = emailSession.token;
      } else if (sessionMode === "injected" && window.ethereum) {
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const expiresAt = Math.floor(Date.now() / 1000) + 10 * 60;
        const message = [
          "ProbX CCTP Demo Funding",
          `wallet: ${mintTo}`,
          `amount: ${amountUsdc}`,
          `nonce: ${nonce}`,
          `chainId: 5042002`,
          `expiresAt: ${expiresAt}`,
          `domain: probx`
        ].join("\n");
        const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
        const from = accounts[0];
        if (!from) throw new Error("Connect MetaMask to authorize demo fund.");
        const signature = (await window.ethereum.request({
          method: "personal_sign",
          params: [message, from]
        })) as string;
        body.signature = signature;
        body.nonce = nonce;
        body.expiresAt = String(expiresAt);
      } else {
        throw new Error("Sign in with email or connect MetaMask to use demo fund.");
      }
      const response = await fetch(apiUrl("/api/cctp/demo-fund"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json()) as {
        error?: string;
        burnTxHash?: string;
        forwardTxHash?: string;
        status?: string;
        domain?: number;
      };
      if (!response.ok) throw new Error(payload.error || `Demo fund HTTP ${response.status}`);
      if (payload.burnTxHash) {
        setBurnTx(payload.burnTxHash);
        // Burn is on chain but the Arc mint has not been seen yet. Keep the record —
        // clearing here would lose the UUID during the multi-minute mint wait.
        if (demoOpRef.current) {
          demoOpRef.current.burnTxHash = payload.burnTxHash;
          demoOpRef.current.status = "broadcast";
          writeDemoOpMemo(demoOpRef.current);
        }
      }
      let forwardHash = payload.forwardTxHash ?? null;
      if (forwardHash) setMintTx(forwardHash);

      // Burn returns immediately; poll status so we don't double-burn on timeout.
      if (payload.burnTxHash && payload.status === "burned_pending_mint") {
        setStep("attestation");
        setMessage("Burn confirmed — waiting for Circle mint on Arc…");
        const domain = payload.domain ?? 6;
        const started = Date.now();
        while (Date.now() - started < 5 * 60_000) {
          const st = await pollCctpStatus(domain, payload.burnTxHash);
          if (st.status === "forwarded" && st.forwardTxHash) {
            forwardHash = st.forwardTxHash;
            setMintTx(st.forwardTxHash);
            break;
          }
          await new Promise((r) => setTimeout(r, 4000));
        }
      }

      setStep("done");
      setMessage(
        forwardHash
          ? "Demo CCTP complete — USDC minted on Arc. Keep a little for gas."
          : "Burn sent — mint may still finalize; refresh balance in a minute."
      );
      // Retire the record only once Circle actually minted on Arc. If the mint wait timed
      // out, the funding is still in flight: keep it so a refresh resumes rather than
      // starting a second burn.
      if (demoOpRef.current) {
        demoOpRef.current.status = forwardHash ? "forwarded" : "broadcast";
        writeDemoOpMemo(demoOpRef.current);
      }
      await refreshBalance();
    } catch (error) {
      setStep("error");
      setMessage(readableWalletError(error));
      // Leave the record in place: an immediate retry must reuse this UUID so the server
      // recognises it. If a burn already went out, its hash and `broadcast` status were
      // recorded above and recovery will resume from there.
    } finally {
      setBusy(false);
    }
  }, [amount, mintTo, embeddedAddress, refreshBalance, sessionEmail, sessionMode, sessionToken]);

  const runFund = useCallback(async () => {
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
      // ——— Primary: Circle App Kit bridge (DeFi-track App Kits) ———
      setStep("burn");
      setMessage("⚡ App Kit bridge (CCTP under the hood)…");
      const strictAppKit =
        typeof process !== "undefined" && process.env.NEXT_PUBLIC_APP_KIT_STRICT === "1";
      try {
        const { appKitBridgeToArc, sourceKeyToAppKitChain } = await import("@/lib/appKit");
        const bridged = await appKitBridgeToArc({
          source: sourceKeyToAppKitChain(source),
          amount: amount || "1",
          // Mint to the session wallet shown in the UI (Circle email), not the MetaMask burner.
          recipientAddress: mintTo,
          onProgress: (msg) => setMessage(`⚡ App Kit: ${msg}`)
        });
        if (bridged.hash) setBurnTx(bridged.hash);
        setStep("done");
        setMessage(
          `⚡ via Circle App Kit · bridge complete → Arc ${shortHex(mintTo)}. Keep a little USDC for gas.`
        );
        await refreshBalance();
        return;
      } catch (appKitErr) {
        const why = appKitErr instanceof Error ? appKitErr.message : String(appKitErr);
        if (strictAppKit) {
          throw new Error(`App Kit bridge required (NEXT_PUBLIC_APP_KIT_STRICT=1): ${why}`);
        }
        setMessage(
          `⚠ App Kit bridge failed (${why}) — using manual CCTP fallback (judges: App Kit was attempted first).`
        );
      }

      // ——— Fallback: manual CCTP v2 (only if App Kit failed; never silent) ———
      if (!config || !sourceCfg || !destCfg) {
        throw new Error("CCTP config not loaded for manual fallback.");
      }
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
      {
        const { waitSuccessfulReceipt } = await import("@/lib/txReceipt");
        await waitSuccessfulReceipt(publicClient, approveHash);
      }

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
      {
        const { waitSuccessfulReceipt } = await import("@/lib/txReceipt");
        await waitSuccessfulReceipt(publicClient, burnHash);
      }

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
    amount,
    amountUnits,
    config,
    cctpSourceAddress,
    destCfg,
    ensureSourceChain,
    mintTo,
    refreshBalance,
    refreshSourceBalance,
    source,
    sourceCfg
  ]);

  const handleSend = useCallback(async () => {
    setSendError("");
    setSendTx(null);
    if (!mintTo) {
      setSendError("Connect a wallet first.");
      return;
    }
    setSendBusy(true);
    setSendStatus("pending");
    try {
      const result = await sendUsdc(sendTo, sendAmount);
      const hash = result.hash;
      setSendTx(hash);
      if (result.provider === "app-kit") {
        setSendError(""); // clear
        setMessage(`⚡ via Circle App Kit · send ${sendAmount} USDC`);
      } else if (result.provider === "viem-fallback") {
        setMessage(
          `⚠ App Kit missed → ${result.fallbackReason || "viem fallback"} (tx still sent)`
        );
      } else if (result.provider) {
        setMessage(`Send via ${result.provider}`);
      }
      // Poll durable status until confirmed / failed.
      let attempts = 0;
      const poll = async (): Promise<void> => {
        attempts += 1;
        const record = await pollTxStatus(hash);
        if (record?.status === "confirmed") {
          setSendStatus("confirmed");
          void refreshBalance();
          return;
        }
        if (record?.status === "failed") {
          setSendStatus("failed");
          setSendError(record.error || "Transaction failed on chain.");
          return;
        }
        if (attempts < 40) {
          window.setTimeout(() => void poll(), 3_000);
        }
      };
      void poll();
    } catch (error) {
      setSendStatus("failed");
      setSendError(readableWalletError(error));
    } finally {
      setSendBusy(false);
    }
  }, [mintTo, pollTxStatus, refreshBalance, sendAmount, sendTo, sendUsdc]);

  const sendBalanceLabel =
    usdcBalance === null ? "—" : `${formatUnits(usdcBalance, 6)} USDC`;

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

        <span className="eyebrow">{tab === "send" ? "Transfer" : "Fund wallet"}</span>
        <h3 className="fundModalTitle">{tab === "send" ? "Send USDC on Arc" : "Get USDC on Arc"}</h3>
        <p className="fundModalSub">
          {tab === "bridge"
            ? "Bridge via CCTP from Base / Eth Sepolia."
            : tab === "send"
              ? "Send Arc USDC to another wallet address."
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
          <button
            type="button"
            role="tab"
            aria-selected={tab === "send"}
            className={`fundTab ${tab === "send" ? "isActive" : ""}`}
            onClick={() => {
              setTab("send");
              setMessage("");
              setStep("idle");
              setSendError("");
            }}
          >
            ↗ Send
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
          ) : tab === "send" ? (
            <div className="fundPanelCard">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: "#5B6A7D" }}>Available</span>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 600, color: "#0B1622" }}>
                  {sendBalanceLabel}
                </span>
              </div>
              <label className="fundField">
                <span>Recipient Arc address</span>
                <input
                  placeholder="0x…"
                  value={sendTo}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={sendBusy}
                  onChange={(e) => {
                    setSendTo(e.target.value.trim());
                    setSendError("");
                    setSendStatus("idle");
                  }}
                />
              </label>
              <label className="fundField">
                <span>Amount (USDC)</span>
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={sendAmount}
                  disabled={sendBusy}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d.]/g, "");
                    setSendAmount(v);
                    setSendError("");
                    setSendStatus("idle");
                  }}
                />
              </label>

              {sendError ? (
                <p className="fundHint" style={{ color: "#D6544A" }}>{sendError}</p>
              ) : (
                <p className="fundHint">
                  Sends <strong>native Arc USDC</strong> on the same chain as ProbX markets. Gas is paid in Arc USDC.
                </p>
              )}

              {sendStatus !== "idle" && sendTx ? (
                <div
                  style={{
                    marginTop: 10,
                    padding: "10px 12px",
                    borderRadius: 10,
                    fontSize: 12.5,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background:
                      sendStatus === "confirmed"
                        ? "#E7F5EF"
                        : sendStatus === "failed"
                          ? "#FBEAE8"
                          : "#EAF2FB",
                    color:
                      sendStatus === "confirmed"
                        ? "#1F9D6B"
                        : sendStatus === "failed"
                          ? "#D6544A"
                          : "#2775CA"
                  }}
                >
                  {sendStatus === "pending" ? <Loader2 size={14} className="spinIcon" /> : null}
                  {sendStatus === "pending"
                    ? "Pending confirmation…"
                    : sendStatus === "confirmed"
                      ? "Confirmed"
                      : "Failed"}
                  <a
                    href={`${arcDeployment.explorerUrl || "https://testnet.arcscan.app"}/tx/${sendTx}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ marginLeft: "auto", fontSize: 11.5, color: "inherit", textDecoration: "underline" }}
                  >
                    {shortHex(sendTx)}
                  </a>
                </div>
              ) : null}

              <button
                type="button"
                className="fundFooterBtn primary"
                disabled={sendBusy || !mintTo || !sendTo || !sendAmount}
                onClick={() => void handleSend()}
                style={{ marginTop: 14 }}
              >
                {sendBusy ? (
                  <>
                    <Loader2 size={15} className="spinIcon" /> Sending…
                  </>
                ) : (
                  "Send USDC"
                )}
              </button>
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
          <button type="button" className="fundFooterBtn secondary" disabled={busy || sendBusy} onClick={onClose}>
            Close
          </button>
          {/* Primary footer action is tab-specific. Send keeps its button in the form body. */}
          {tab === "direct" ? (
            <button
              type="button"
              className="fundFooterBtn primary"
              disabled={!mintTo}
              onClick={() => void copyAddress()}
            >
              {copied ? "Address copied" : "Copy Arc address"}
            </button>
          ) : tab === "bridge" ? (
            <button
              type="button"
              className="fundFooterBtn primary"
              disabled={busy || !mintTo || !cctpSourceAddress || amountUnits <= 0n}
              onClick={() => void runFund()}
            >
              {busy ? <Loader2 size={16} className="spinIcon" /> : <ArrowRightLeft size={16} />}
              {busy ? "Working…" : "Bridge CCTP"}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
