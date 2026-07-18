export interface ContractAddresses {
  mode?: string;
  chainId?: number;
  chainName?: string;
  rpcUrl?: string;
  explorerUrl?: string;
  usdc: string;
  microBoostEngine: string;
  liquidityPool: string;
  marketFactory: string;
  positionTicket?: string;
  oracleAdapter?: string;
  demoMarket?: string;
}

import { getDeployment, onchainEnabled } from "./onchainService.js";

export function contractAddresses(): ContractAddresses {
  const deployment = getDeployment();
  if (onchainEnabled()) {
    return {
      mode: "arc-testnet",
      chainId: deployment.chainId,
      chainName: deployment.chainName,
      rpcUrl: deployment.rpcUrl,
      explorerUrl: deployment.explorerUrl,
      usdc: deployment.usdc,
      microBoostEngine: deployment.microBoostEngine,
      liquidityPool: deployment.liquidityPool,
      marketFactory: deployment.marketFactory,
      positionTicket: deployment.positionTicket,
      oracleAdapter: deployment.oracleAdapter,
      demoMarket: deployment.demoMarket
    };
  }
  return {
    mode: "demo",
    usdc: process.env.NEXT_PUBLIC_USDC_ADDRESS ?? "",
    microBoostEngine: process.env.NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS ?? "",
    liquidityPool: process.env.NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS ?? "",
    marketFactory: process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS ?? ""
  };
}
