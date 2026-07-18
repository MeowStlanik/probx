import { apiUrl } from "@/lib/api";

export type CctpSourceKey = "baseSepolia" | "ethereumSepolia";

export type CctpConfig = {
  irisBase: string;
  faucetUrl: string;
  paymaster: boolean;
  notes: string[];
  forwardingHookData: `0x${string}`;
  destination: {
    key: string;
    id: number;
    name: string;
    domain: number;
    rpcUrl: string;
    explorerUrl: string;
    usdc: string;
    tokenMessengerV2: string;
    messageTransmitterV2: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
  };
  sources: Record<
    CctpSourceKey,
    {
      key: CctpSourceKey;
      recommended: boolean;
      id: number;
      name: string;
      domain: number;
      rpcUrl: string;
      explorerUrl: string;
      usdc: string;
      tokenMessengerV2: string;
      nativeCurrency: { name: string; symbol: string; decimals: number };
    }
  >;
};

export type CctpQuote = {
  source: CctpSourceKey;
  destination: string;
  amount: string;
  forwardFee: string;
  protocolFee: string;
  maxFee: string;
  totalBurn: string;
  finalityThreshold: number;
};

export const tokenMessengerAbi = [
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" }
    ],
    outputs: []
  }
] as const;

export const erc20ApproveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;

export async function fetchCctpConfig(): Promise<CctpConfig> {
  const response = await fetch(apiUrl("/api/cctp/config"), { cache: "no-store" });
  if (!response.ok) throw new Error(`CCTP config HTTP ${response.status}`);
  return (await response.json()) as CctpConfig;
}

export async function fetchCctpQuote(source: CctpSourceKey, amountUnits: bigint): Promise<CctpQuote> {
  const response = await fetch(apiUrl("/api/cctp/quote"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, amount: amountUnits.toString() })
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || `CCTP quote HTTP ${response.status}`);
  }
  return (await response.json()) as CctpQuote;
}

export async function pollCctpStatus(domain: number, txHash: string): Promise<{
  status: "pending" | "forwarded" | "attested";
  forwardTxHash?: string;
  attestation?: string;
  cctpMessage?: string;
}> {
  const url = apiUrl(`/api/cctp/status?domain=${domain}&txHash=${encodeURIComponent(txHash)}`);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`CCTP status HTTP ${response.status}`);
  }
  return (await response.json()) as {
    status: "pending" | "forwarded" | "attested";
    forwardTxHash?: string;
    attestation?: string;
    cctpMessage?: string;
  };
}

export function addressToBytes32(address: `0x${string}`): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
}

export function emptyBytes32(): `0x${string}` {
  return `0x${"0".repeat(64)}`;
}
