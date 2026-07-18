"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  formatUnits,
  getAddress,
  http,
  type PublicClient
} from "viem";
import { apiUrl } from "@/lib/api";
import { arcChain, arcDeployment, arcRpcUrls, usdcAbi } from "@/lib/onchain";

/** Minimal wallet client surface used by trade / LP / portfolio write paths. */
export type AppWalletClient = {
  writeContract: (args: Record<string, unknown>) => Promise<`0x${string}`>;
};

export type WalletMode = "injected" | "embedded";

const STORAGE_KEY = "probx.wallet.connected";
const EMBEDDED_STORAGE_KEY = "probx.wallet.embedded";
const OTP_STORAGE_PREFIX = "probx.otp.";
/** Last OTP challenge for any email (fallback if email string differs slightly). */
const OTP_LAST_KEY = "probx.otp.last";

function otpSessionKey(email: string): string {
  return `${OTP_STORAGE_PREFIX}${email.trim().toLowerCase()}`;
}

function persistOtpChallenge(email: string, otpToken: string): void {
  const payload = JSON.stringify({
    otpToken,
    email: email.trim().toLowerCase(),
    at: Date.now()
  });
  for (const storage of [sessionStorage, localStorage]) {
    try {
      storage.setItem(otpSessionKey(email), payload);
      storage.setItem(OTP_LAST_KEY, payload);
    } catch {
      // private mode / blocked storage
    }
  }
}

function readOtpChallenge(email: string): string {
  const emailNorm = email.trim().toLowerCase();
  const tryParse = (raw: string | null): string => {
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw) as { otpToken?: string; email?: string; at?: number };
      if (!parsed.otpToken) return "";
      if (parsed.at && Date.now() - parsed.at > 15 * 60_000) return "";
      if (parsed.email && parsed.email !== emailNorm) return "";
      return parsed.otpToken;
    } catch {
      return "";
    }
  };
  // Only the exact email key — never reuse another address's challenge via "last".
  for (const storage of [sessionStorage, localStorage]) {
    try {
      const exact = tryParse(storage.getItem(otpSessionKey(emailNorm)));
      if (exact) return exact;
    } catch {
      // ignore
    }
  }
  return "";
}

function clearOtpChallenge(email?: string): void {
  for (const storage of [sessionStorage, localStorage]) {
    try {
      if (email) {
        storage.removeItem(otpSessionKey(email));
      } else {
        // Wipe every probx.otp.* key + last challenge.
        const keys: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k && (k.startsWith(OTP_STORAGE_PREFIX) || k === OTP_LAST_KEY)) keys.push(k);
        }
        for (const k of keys) storage.removeItem(k);
      }
      storage.removeItem(OTP_LAST_KEY);
    } catch {
      // ignore
    }
  }
}

export type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type EmbeddedSession = {
  email: string;
  address: `0x${string}`;
  sessionToken: string;
};

type WalletContextValue = {
  address: `0x${string}` | null;
  chainId: number | null;
  usdcBalance: bigint | null;
  connecting: boolean;
  restoring: boolean;
  ready: boolean;
  wrongNetwork: boolean;
  hasProvider: boolean;
  error: string | null;
  mode: WalletMode | null;
  email: string | null;
  /** MetaMask / injected */
  connect: () => Promise<`0x${string}` | null>;
  /** Step 1: request 6-digit email OTP (returns otpToken for Vercel multi-instance verify). */
  requestEmailOtp: (
    email: string
  ) => Promise<{ email: string; message: string; otpToken: string } | null>;
  /** Step 2: verify OTP → Circle Developer-Controlled wallet session. */
  verifyEmailOtp: (email: string, code: string, otpToken?: string) => Promise<`0x${string}` | null>;
  /** @deprecated use requestEmailOtp + verifyEmailOtp */
  connectEmail: (email: string) => Promise<`0x${string}` | null>;
  /** Drop cached OTP challenge (wrong email / resend / cancel). */
  clearEmailOtp: (email?: string) => void;
  disconnect: () => void;
  ensureArcChain: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  getWalletClient: () => AppWalletClient | null;
  publicClient: PublicClient;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasProvider, setHasProvider] = useState(false);
  const [mode, setMode] = useState<WalletMode | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [embedded, setEmbedded] = useState<EmbeddedSession | null>(null);

  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: arcChain,
        transport: fallback(arcRpcUrls.map((url) => http(url)), { rank: false })
      }),
    []
  );

  const setActiveAddress = useCallback((value: string | null) => {
    if (!value) {
      setAddress(null);
      setUsdcBalance(null);
      return;
    }
    try {
      setAddress(getAddress(value));
    } catch {
      setAddress(null);
      setUsdcBalance(null);
    }
  }, []);

  const refreshChain = useCallback(async () => {
    if (!window.ethereum) {
      setChainId(null);
      return null;
    }
    try {
      const chainIdHex = (await window.ethereum.request({ method: "eth_chainId" })) as string;
      const next = Number.parseInt(chainIdHex, 16);
      setChainId(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const refreshBalance = useCallback(async (walletAddress?: string | null) => {
    const target = walletAddress ?? address;
    if (!target) {
      setUsdcBalance(null);
      return;
    }
    try {
      const rawBalance = await publicClient.readContract({
        address: arcDeployment.usdc as `0x${string}`,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [getAddress(target)]
      });
      setUsdcBalance(rawBalance);
    } catch {
      setUsdcBalance(null);
    }
  }, [address, publicClient]);

  /**
   * Force injected wallet onto Arc Testnet.
   * `wallet_addEthereumChain` alone often only *registers* the chain and leaves
   * the user on Base/Eth — UI said “switched” but writes still went to the wrong net.
   * Correct flow: switch → if 4902 add → switch again → verify eth_chainId.
   */
  const ensureArcChain = useCallback(async () => {
    if (!window.ethereum) throw new Error("Install a browser wallet to continue.");

    const targetHex = `0x${arcDeployment.chainId.toString(16)}` as const;

    const readChainId = async (): Promise<number | null> => {
      try {
        const hex = (await window.ethereum!.request({ method: "eth_chainId" })) as string;
        return Number.parseInt(hex, 16);
      } catch {
        return null;
      }
    };

    const already = await readChainId();
    if (already === arcDeployment.chainId) {
      setChainId(arcDeployment.chainId);
      return;
    }

    const switchToArc = async () => {
      await window.ethereum!.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetHex }]
      });
    };

    const addArc = async () => {
      await window.ethereum!.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: targetHex,
            chainName: arcDeployment.chainName,
            rpcUrls: arcRpcUrls,
            nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
            blockExplorerUrls: [arcDeployment.explorerUrl]
          }
        ]
      });
    };

    try {
      await switchToArc();
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? Number((error as { code?: number }).code)
          : undefined;
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error !== null && "message" in error
            ? String((error as { message?: string }).message)
            : "";
      // 4902 = chain not added yet; some wallets use nested originalError
      const nested =
        typeof error === "object" &&
        error !== null &&
        "data" in error &&
        typeof (error as { data?: { originalError?: { code?: number } } }).data?.originalError?.code ===
          "number"
          ? (error as { data: { originalError: { code: number } } }).data.originalError.code
          : undefined;
      if (code === 4902 || nested === 4902 || /unrecognized chain|unknown chain/i.test(msg)) {
        await addArc();
        // After add, many wallets stay on the previous chain — force switch.
        try {
          await switchToArc();
        } catch {
          // Some wallets switch as part of add; verify below.
        }
      } else if (code === 4001) {
        throw new Error("Network switch rejected in wallet. Select Arc Testnet manually and retry.");
      } else {
        throw error instanceof Error ? error : new Error(msg || "Failed to switch network");
      }
    }

    // Brief wait for MetaMask chainChanged to settle
    await new Promise((r) => setTimeout(r, 150));
    const verified = (await refreshChain()) ?? (await readChainId());
    if (verified !== arcDeployment.chainId) {
      throw new Error(
        `Wallet is still on chain ${verified ?? "unknown"}, not Arc Testnet (${arcDeployment.chainId}). Open the wallet and switch network, then retry.`
      );
    }
  }, [refreshChain]);

  const connect = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError("Install a browser wallet");
      return null;
    }
    setConnecting(true);
    try {
      clearEmbeddedSession();
      setEmbedded(null);
      setEmail(null);
      await ensureArcChain();
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      const next = accounts[0] ? getAddress(accounts[0]) : null;
      setMode("injected");
      setActiveAddress(next);
      if (next) {
        writeConnectedFlag(true);
        await refreshBalance(next);
      } else {
        writeConnectedFlag(false);
        setMode(null);
      }
      return next;
    } catch (caught) {
      setError(readableWalletError(caught));
      return null;
    } finally {
      setConnecting(false);
    }
  }, [ensureArcChain, refreshBalance, setActiveAddress]);

  const applyEmbeddedSession = useCallback(async (payload: {
    email: string;
    address: string;
    sessionToken: string;
  }) => {
    const session: EmbeddedSession = {
      email: payload.email,
      address: getAddress(payload.address),
      sessionToken: payload.sessionToken
    };
    writeEmbeddedSession(session);
    writeConnectedFlag(false);
    setEmbedded(session);
    setEmail(session.email);
    setMode("embedded");
    setChainId(arcDeployment.chainId);
    setActiveAddress(session.address);
    await refreshBalance(session.address);
    return session.address;
  }, [refreshBalance, setActiveAddress]);

  const requestEmailOtp = useCallback(async (emailInput: string) => {
    setError(null);
    setConnecting(true);
    try {
      // Empty base = same-origin unified API (Vercel) — valid
      const response = await fetch(apiUrl("/api/wallet/session/request-otp"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: emailInput.trim().toLowerCase() })
      });
      const payload = (await response.json()) as {
        error?: string;
        email?: string;
        message?: string;
        otpToken?: string;
      };
      if (!response.ok) throw new Error(payload.error || `OTP HTTP ${response.status}`);
      if (!payload.email) throw new Error("Invalid OTP response.");
      if (!payload.otpToken) throw new Error("Server did not return otpToken — redeploy required.");
      // Persist across menu close / re-render / multi-instance verify (Vercel).
      // Server also sets HttpOnly cookie as backup.
      persistOtpChallenge(payload.email, payload.otpToken);
      return {
        email: payload.email,
        message: payload.message || "Enter the verification code.",
        otpToken: payload.otpToken
      };
    } catch (caught) {
      setError(readableWalletError(caught));
      return null;
    } finally {
      setConnecting(false);
    }
  }, []);

  const verifyEmailOtp = useCallback(async (emailInput: string, code: string, otpToken?: string) => {
    setError(null);
    setConnecting(true);
    try {
      const emailNorm = emailInput.trim().toLowerCase();
      // Prefer explicit token, then storage; cookie still applied server-side if body empty.
      let token = (otpToken || "").trim() || readOtpChallenge(emailNorm);
      const response = await fetch(apiUrl("/api/wallet/session/verify-otp"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        // credentials: include cookie so HttpOnly probx_otp is sent
        credentials: "same-origin",
        body: JSON.stringify({
          email: emailNorm,
          code: String(code ?? "").trim(),
          ...(token ? { otpToken: token } : {})
        })
      });
      const payload = (await response.json()) as {
        error?: string;
        email?: string;
        address?: string;
        sessionToken?: string;
      };
      if (!response.ok) throw new Error(payload.error || `Verify HTTP ${response.status}`);
      if (!payload.address || !payload.sessionToken || !payload.email) {
        throw new Error("Invalid session response from API.");
      }
      clearOtpChallenge(emailNorm);
      clearEmbeddedSession();
      setEmbedded(null);
      return await applyEmbeddedSession({
        email: payload.email,
        address: payload.address,
        sessionToken: payload.sessionToken
      });
    } catch (caught) {
      setError(readableWalletError(caught));
      return null;
    } finally {
      setConnecting(false);
    }
  }, [applyEmbeddedSession]);

  /** Legacy one-shot — blocked by API unless OTP is sent as code. */
  const connectEmail = useCallback(async (emailInput: string) => {
    setError("Enter email, request code, then verify — one-step login is disabled.");
    return null;
  }, []);

  const clearEmailOtp = useCallback((emailInput?: string) => {
    clearOtpChallenge(emailInput?.trim().toLowerCase() || undefined);
  }, []);

  const disconnect = useCallback(() => {
    writeConnectedFlag(false);
    clearEmbeddedSession();
    clearOtpChallenge();
    setEmbedded(null);
    setEmail(null);
    setMode(null);
    setActiveAddress(null);
    setError(null);
  }, [setActiveAddress]);

  const getWalletClient = useCallback((): AppWalletClient | null => {
    if (!address) return null;

    if (mode === "embedded" && embedded) {
      const session = embedded;
      return {
        writeContract: async (args) => {
          const safeArgs = (Array.isArray(args.args) ? args.args : []).map((value) =>
            typeof value === "bigint" ? value.toString() : value
          );
          let response: Response;
          try {
            response = await fetch(apiUrl("/api/wallet/write-contract"), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                email: session.email,
                sessionToken: session.sessionToken,
                address: args.address,
                abi: args.abi,
                functionName: args.functionName,
                args: safeArgs,
                value:
                  args.value !== undefined
                    ? typeof args.value === "bigint"
                      ? args.value.toString()
                      : String(args.value)
                    : undefined
              })
            });
          } catch (networkError) {
            throw new Error(
              `Cannot reach API for Circle signing (${readableWalletError(networkError)}).`
            );
          }
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string;
            hash?: string;
          };
          if (!response.ok || !payload.hash) {
            throw new Error(payload.error || `Circle write failed (HTTP ${response.status})`);
          }
          return payload.hash as `0x${string}`;
        }
      };
    }

    if (!window.ethereum) return null;
    // Capture ensureArcChain in closure — always re-switch before writes so a
    // stale "switched" UI state cannot send LP withdraw/deposit to Base/Eth.
    const switchThenWrite = async (args: Record<string, unknown>) => {
      await ensureArcChain();
      const client = createWalletClient({
        account: address,
        chain: arcChain,
        transport: custom(window.ethereum!)
      });
      return client.writeContract(args as never);
    };
    return {
      writeContract: (args) => switchThenWrite(args)
    };
  }, [address, embedded, ensureArcChain, mode]);

  // Restore session: embedded first, then injected MetaMask flag.
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      setHasProvider(Boolean(typeof window !== "undefined" && window.ethereum));

      const savedEmbedded = readEmbeddedSession();
      if (savedEmbedded) {
        try {
          {
            // Headers keep the session token out of URLs, logs and browser history.
            const response = await fetch(apiUrl("/api/wallet/session"), {
              cache: "no-store",
              headers: {
                "x-session-email": savedEmbedded.email,
                "x-session-token": savedEmbedded.sessionToken
              }
            });
            if (response.ok) {
              if (cancelled) return;
              setEmbedded(savedEmbedded);
              setEmail(savedEmbedded.email);
              setMode("embedded");
              setChainId(arcDeployment.chainId);
              setActiveAddress(savedEmbedded.address);
              await refreshBalance(savedEmbedded.address);
              if (!cancelled) setRestoring(false);
              return;
            }
          }
          clearEmbeddedSession();
        } catch {
          clearEmbeddedSession();
        }
      }

      if (!window.ethereum) {
        if (!cancelled) setRestoring(false);
        return;
      }

      try {
        await refreshChain();
        const wantsReconnect = readConnectedFlag();
        const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
        const next = accounts[0] ? getAddress(accounts[0]) : null;

        if (cancelled) return;

        if (next && wantsReconnect) {
          setMode("injected");
          setActiveAddress(next);
          await refreshBalance(next);
        } else {
          setActiveAddress(null);
        }
      } catch {
        if (!cancelled) setActiveAddress(null);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [refreshBalance, refreshChain, setActiveAddress]);

  // Injected-wallet listeners only (email/Circle sessions ignore MetaMask account changes).
  useEffect(() => {
    if (!window.ethereum || mode === "embedded") return;

    const onAccountsChanged = (accounts: unknown) => {
      if (mode !== "injected") return;
      const next = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
      if (!next) {
        writeConnectedFlag(false);
        setActiveAddress(null);
        setMode(null);
        return;
      }
      if (readConnectedFlag()) {
        setMode("injected");
        setActiveAddress(next);
        void refreshBalance(next);
      }
    };

    const onChainChanged = (nextChainId: unknown) => {
      if (mode !== "injected") return;
      if (typeof nextChainId === "string") {
        setChainId(Number.parseInt(nextChainId, 16));
      } else {
        void refreshChain();
      }
      if (address) void refreshBalance(address);
    };

    window.ethereum.on?.("accountsChanged", onAccountsChanged);
    window.ethereum.on?.("chainChanged", onChainChanged);
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", onAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", onChainChanged);
    };
  }, [address, mode, refreshBalance, refreshChain, setActiveAddress]);

  useEffect(() => {
    if (!address) return;
    void refreshBalance(address);
    const interval = window.setInterval(() => void refreshBalance(address), 15_000);
    return () => window.clearInterval(interval);
  }, [address, refreshBalance]);

  const wrongNetwork =
    mode === "embedded"
      ? false
      : chainId !== null && chainId !== arcDeployment.chainId;

  const value = useMemo<WalletContextValue>(() => ({
    address,
    chainId: mode === "embedded" ? arcDeployment.chainId : chainId,
    usdcBalance,
    connecting,
    restoring,
    ready: !restoring,
    wrongNetwork,
    hasProvider,
    error,
    mode,
    email,
    connect,
    requestEmailOtp,
    verifyEmailOtp,
    connectEmail,
    clearEmailOtp,
    disconnect,
    ensureArcChain,
    refreshBalance: () => refreshBalance(address),
    getWalletClient,
    publicClient
  }), [
    address,
    chainId,
    usdcBalance,
    connecting,
    restoring,
    wrongNetwork,
    hasProvider,
    error,
    mode,
    email,
    connect,
    requestEmailOtp,
    verifyEmailOtp,
    connectEmail,
    clearEmailOtp,
    disconnect,
    ensureArcChain,
    refreshBalance,
    getWalletClient,
    publicClient
  ]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within WalletProvider");
  }
  return ctx;
}

/** Safe hook for optional use outside provider (returns null). */
export function useWalletOptional(): WalletContextValue | null {
  return useContext(WalletContext);
}

export function formatUsdcBalance(balance: bigint, decimals = 6): string {
  const value = Number(formatUnits(balance, decimals));
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: value > 0 && value < 1 ? 4 : 0,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2
  }).format(value)} USDC`;
}

export function shortHex(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function readableWalletError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? Number((error as { code?: number }).code)
    : undefined;
  if (code === 4001) return "Wallet request rejected.";
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String((error as { message?: string }).message)
      : "Wallet request failed.";
  if (message.toLowerCase().includes("user rejected")) return "Wallet request rejected.";
  return message;
}

function readConnectedFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeConnectedFlag(connected: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (connected) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore private mode / quota issues.
  }
}

function readEmbeddedSession(): EmbeddedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(EMBEDDED_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EmbeddedSession;
    if (!parsed?.email || !parsed?.address || !parsed?.sessionToken) return null;
    return {
      email: parsed.email,
      address: getAddress(parsed.address),
      sessionToken: parsed.sessionToken
    };
  } catch {
    return null;
  }
}

function writeEmbeddedSession(session: EmbeddedSession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EMBEDDED_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // ignore
  }
}

function clearEmbeddedSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(EMBEDDED_STORAGE_KEY);
  } catch {
    // ignore
  }
}
