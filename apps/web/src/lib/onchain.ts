import deployment from "./deployment.json";

export const arcDeployment = deployment;

type DeploymentWithRpcFallbacks = typeof deployment & { rpcUrls?: string[] };

export const arcRpcUrls = Array.from(new Set([
  ...(((deployment as DeploymentWithRpcFallbacks).rpcUrls ?? []) as string[]),
  deployment.rpcUrl,
  "https://arc-testnet.drpc.org"
].filter(Boolean) as string[])).filter(isStableArcRpcUrl);

function isStableArcRpcUrl(url: string): boolean {
  return !url.includes("quicknode") && !url.includes("blockdaemon");
}

export const arcChain = {
  id: deployment.chainId,
  name: deployment.chainName,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: arcRpcUrls
    }
  },
  blockExplorers: {
    default: {
      name: "ArcScan",
      url: deployment.explorerUrl
    }
  }
} as const;

export const hasArcDeployment = Boolean(deployment.microBoostEngine && deployment.demoMarket);

export const usdcAbi = [
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
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
] as const;

export const engineAbi = [
  {
    type: "function",
    name: "quoteTicket",
    stateMutability: "view",
    inputs: [
      { name: "market", type: "address" },
      { name: "outcome", type: "uint8" },
      { name: "riskAmount", type: "uint256" },
      { name: "boostBps", type: "uint256" }
    ],
    outputs: [
      {
        name: "quote",
        type: "tuple",
        components: [
          { name: "price", type: "uint256" },
          { name: "payout", type: "uint256" },
          { name: "requiredReserve", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "totalDebit", type: "uint256" },
          { name: "maxAvailableBoostBps", type: "uint256" },
          { name: "accepted", type: "bool" },
          { name: "reason", type: "string" }
        ]
      }
    ]
  },
  {
    type: "function",
    name: "buyTicket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "market", type: "address" },
      { name: "outcome", type: "uint8" },
      { name: "riskAmount", type: "uint256" },
      { name: "boostBps", type: "uint256" }
    ],
    outputs: [{ name: "ticketId", type: "uint256" }]
  },
  {
    type: "function",
    name: "settleTicket",
    stateMutability: "nonpayable",
    inputs: [{ name: "ticketId", type: "uint256" }],
    outputs: []
  },
  {
    type: "event",
    name: "TicketBought",
    inputs: [
      { name: "ticketId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "market", type: "address", indexed: true },
      { name: "outcome", type: "uint8", indexed: false },
      { name: "riskAmount", type: "uint256", indexed: false },
      { name: "boostBps", type: "uint256", indexed: false },
      { name: "payout", type: "uint256", indexed: false },
      { name: "reserve", type: "uint256", indexed: false }
    ]
  }
] as const;

export const marketAbi = [
  {
    type: "function",
    name: "open",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: []
  },
  {
    type: "function",
    name: "status",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "winningOutcome",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "resolve",
    stateMutability: "nonpayable",
    inputs: [{ name: "outcome", type: "uint8" }],
    outputs: []
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [{ name: "reason", type: "string" }],
    outputs: []
  }
] as const;

export const factoryAbi = [
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "question", type: "string" },
      { name: "rulesHash", type: "bytes32" },
      { name: "openTime", type: "uint64" },
      { name: "lockTime", type: "uint64" },
      { name: "observationStart", type: "uint64" },
      { name: "observationEnd", type: "uint64" },
      { name: "yesPrice", type: "uint256" }
    ],
    outputs: [{ name: "market", type: "address" }]
  },
  {
    type: "event",
    name: "MarketCreated",
    inputs: [
      { name: "marketId", type: "uint256", indexed: true },
      { name: "market", type: "address", indexed: true },
      { name: "question", type: "string", indexed: false },
      { name: "metadataHash", type: "bytes32", indexed: true }
    ]
  }
] as const;

export const poolAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ name: "mintedShares", type: "uint256" }]
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }]
  },
  {
    type: "function",
    name: "totalShares",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "sharesOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "managedAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "reservedAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "availableAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }]
  }
] as const;
