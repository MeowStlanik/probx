export const contractAddresses = {
  arcRpcUrl: process.env.NEXT_PUBLIC_ARC_RPC_URL ?? "",
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID ?? "",
  usdc: process.env.NEXT_PUBLIC_USDC_ADDRESS ?? "",
  microBoostEngine: process.env.NEXT_PUBLIC_MICRO_BOOST_ENGINE_ADDRESS ?? "",
  liquidityPool: process.env.NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS ?? "",
  marketFactory: process.env.NEXT_PUBLIC_MARKET_FACTORY_ADDRESS ?? ""
};

export const microBoostEngineAbi = [
  "function quoteTicket(address market,uint8 outcome,uint256 riskAmount,uint256 boostBps) view returns ((uint256,uint256,uint256,uint256,uint256,uint256,bool,string))",
  "function buyTicket(address market,uint8 outcome,uint256 riskAmount,uint256 boostBps) returns (uint256)",
  "function settleTicket(uint256 ticketId)",
  "function settleBatch(uint256[] ticketIds)"
] as const;
