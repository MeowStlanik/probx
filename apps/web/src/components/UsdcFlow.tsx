import { arcDeployment } from "@/lib/onchain";

type Node = {
  label: string;
  sub: string;
  href?: string;
  addr?: string;
};

/** Flow of USDC strip — design Home section. */
export function UsdcFlow() {
  const explorer = arcDeployment.explorerUrl || "https://testnet.arcscan.app";
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  const nodes: Node[] = [
    { label: "Email", sub: "OTP login · Circle" },
    {
      label: "Wallet",
      sub: "EOA on Arc",
      href: `${explorer}/address/${arcDeployment.deployer}`,
      addr: short(arcDeployment.deployer)
    },
    {
      label: "USDC",
      sub: "Native gas token",
      href: `${explorer}/address/${arcDeployment.usdc}`,
      addr: short(arcDeployment.usdc)
    },
    {
      label: "Trade",
      sub: "Micro Boost ticket",
      href: `${explorer}/address/${arcDeployment.microBoostEngine}`,
      addr: short(arcDeployment.microBoostEngine)
    },
    {
      label: "LP vault",
      sub: "Reserve payouts",
      href: `${explorer}/address/${arcDeployment.liquidityPool}`,
      addr: short(arcDeployment.liquidityPool)
    },
    {
      label: "Settle",
      sub: "Claim on Arc",
      href: explorer,
      addr: "Arcscan ↗"
    }
  ];

  return (
    <section className="usdcFlow">
      <div className="usdcFlowInner">
        <div className="usdcFlowHead">
          <div>
            <h2>Flow of USDC</h2>
            <p>The dollar&apos;s path through the app — every node is a real address on Arc.</p>
          </div>
          <span className="usdcFlowChain">chain {arcDeployment.chainId}</span>
        </div>

        <div className="usdcFlowTrack">
          <svg
            className="usdcFlowLine"
            viewBox="0 0 1000 8"
            preserveAspectRatio="none"
            aria-hidden
          >
            <line
              x1="0"
              y1="4"
              x2="1000"
              y2="4"
              stroke="#D3DCE7"
              strokeWidth="2"
              strokeDasharray="2 5"
              strokeLinecap="round"
            />
          </svg>
          <span className="usdcFlowDotWrap" aria-hidden>
            <span className="usdcFlowDot" />
          </span>
          <div className="usdcFlowNodes">
            {nodes.map((node) => (
              <div className="usdcFlowNode" key={node.label}>
                <div className="usdcFlowNodeDot" />
                <div className="usdcFlowNodeLabel">{node.label}</div>
                <div className="usdcFlowNodeSub">{node.sub}</div>
                {node.href ? (
                  <a href={node.href} target="_blank" rel="noreferrer" className="usdcFlowNodeLink">
                    {node.addr}
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
