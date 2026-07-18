/** CCTP v2: Base Sepolia / Ethereum Sepolia → Arc Testnet (Iris sandbox). */

export const CCTP_IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";

export const CCTP = {
  domains: {
    ethereumSepolia: 0,
    baseSepolia: 6,
    arcTestnet: 26
  },
  tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const,
  messageTransmitterV2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as const,
  forwardingHookData:
    "0x636374702d666f72776172640000000000000000000000000000000000000000" as const,
  usdc: {
    ethereumSepolia: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const,
    baseSepolia: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
    arcTestnet: "0x3600000000000000000000000000000000000000" as const
  },
  chains: {
    ethereumSepolia: {
      id: 11155111,
      name: "Ethereum Sepolia",
      domain: 0,
      rpcUrl: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      explorerUrl: "https://sepolia.etherscan.io",
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
    },
    baseSepolia: {
      id: 84532,
      name: "Base Sepolia",
      domain: 6,
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      explorerUrl: "https://sepolia.basescan.org",
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    },
    arcTestnet: {
      id: 5042002,
      name: "Arc Testnet",
      domain: 26,
      rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
      explorerUrl: "https://testnet.arcscan.app",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      usdc: "0x3600000000000000000000000000000000000000"
    }
  }
} as const;

export type CctpSourceKey = "baseSepolia" | "ethereumSepolia";

export function cctpPublicConfig() {
  return {
    irisBase: CCTP_IRIS_SANDBOX,
    destination: {
      key: "arcTestnet",
      ...CCTP.chains.arcTestnet,
      tokenMessengerV2: CCTP.tokenMessengerV2,
      messageTransmitterV2: CCTP.messageTransmitterV2
    },
    sources: {
      baseSepolia: {
        key: "baseSepolia" as const,
        recommended: true,
        ...CCTP.chains.baseSepolia,
        tokenMessengerV2: CCTP.tokenMessengerV2
      },
      ethereumSepolia: {
        key: "ethereumSepolia" as const,
        recommended: false,
        ...CCTP.chains.ethereumSepolia,
        tokenMessengerV2: CCTP.tokenMessengerV2
      }
    },
    forwardingHookData: CCTP.forwardingHookData,
    faucetUrl: "https://faucet.circle.com",
    paymaster: false,
    notes: [
      "Burn USDC on Base Sepolia (or Eth Sepolia), mint native USDC on Arc via CCTP v2.",
      "Forwarding Service path: depositForBurnWithHook — Circle submits receiveMessage on Arc.",
      "Source chain needs ETH for gas; Arc gas is USDC (no paymaster).",
      "Keep a small USDC buffer on Arc after mint for claim gas."
    ]
  };
}

type FeeQuote = {
  finalityThreshold: number;
  minimumFee: number;
  forwardFee?: { med?: number; low?: number; high?: number };
};

export async function fetchForwardingFees(sourceDomain: number, destDomain = CCTP.domains.arcTestnet) {
  const url = `${CCTP_IRIS_SANDBOX}/v2/burn/USDC/fees/${sourceDomain}/${destDomain}?forward=true`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`CCTP fee quote failed: HTTP ${response.status}`);
  }
  return (await response.json()) as FeeQuote[];
}

export async function quoteForwardingBurn(amountUnits: bigint, sourceDomain: number) {
  const fees = await fetchForwardingFees(sourceDomain);
  const feeData = fees.find((fee) => fee.finalityThreshold === 1000) ?? fees[0];
  if (!feeData) throw new Error("No CCTP fee quote available for this route.");

  const forwardFee = BigInt(feeData.forwardFee?.med ?? feeData.forwardFee?.high ?? 0);
  const protocolFee =
    (amountUnits * BigInt(Math.round((feeData.minimumFee ?? 0) * 100))) / 1_000_000n;
  const maxFee = forwardFee + protocolFee;
  const totalBurn = amountUnits + maxFee;

  return {
    amount: amountUnits.toString(),
    forwardFee: forwardFee.toString(),
    protocolFee: protocolFee.toString(),
    maxFee: maxFee.toString(),
    totalBurn: totalBurn.toString(),
    finalityThreshold: feeData.finalityThreshold ?? 1000,
    minimumFeeBpsLike: feeData.minimumFee
  };
}

export async function fetchIrisMessage(sourceDomain: number, transactionHash: string) {
  const url = `${CCTP_IRIS_SANDBOX}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (response.status === 404) {
    return { status: "pending" as const, messages: [] as unknown[] };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Iris message fetch failed: HTTP ${response.status} ${text}`);
  }
  const data = (await response.json()) as {
    messages?: Array<{
      status?: string;
      message?: string;
      attestation?: string;
      forwardTxHash?: string;
      txHash?: string;
    }>;
  };
  const message = data.messages?.[0];
  if (!message) return { status: "pending" as const, messages: data.messages ?? [] };

  if (message.forwardTxHash) {
    return {
      status: "forwarded" as const,
      forwardTxHash: message.forwardTxHash,
      message
    };
  }
  if (message.status === "complete" && message.attestation) {
    return {
      status: "attested" as const,
      message,
      attestation: message.attestation,
      cctpMessage: message.message
    };
  }
  return { status: "pending" as const, messages: data.messages ?? [], message };
}
