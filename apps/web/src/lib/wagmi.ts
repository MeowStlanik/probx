import { http, createConfig } from "wagmi";
import { defineChain } from "viem";

export const arcDemo = defineChain({
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 5041),
  name: "Arc Demo",
  nativeCurrency: { name: "Arc", symbol: "ARC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "http://localhost:8545"]
    }
  }
});

export const wagmiConfig = createConfig({
  chains: [arcDemo],
  transports: {
    [arcDemo.id]: http()
  },
  ssr: true
});
