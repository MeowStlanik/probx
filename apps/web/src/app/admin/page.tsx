import { ExternalLink, ShieldCheck } from "lucide-react";
import { LiveReferencePanel } from "@/components/LiveReferencePanel";
import { OnchainAdminPanel } from "@/components/OnchainAdminPanel";
import { arcDeployment } from "@/lib/onchain";

export default function AdminPage() {
  return (
    <main className="pageShell">
      <div className="sectionHeader">
        <div>
          <span className="eyebrow">Controls</span>
          <h1>Admin</h1>
        </div>
      </div>

      <section className="adminGrid">
        <OnchainAdminPanel />
        <div className="adminPanel">
          <h2>Network</h2>
          <div className="adminStatusRow">
            <span>Network</span>
            <strong>Arc Testnet</strong>
            <span>{arcDeployment.chainId}</span>
          </div>
          <div className="adminStatusRow">
            <span>Factory</span>
            <strong>{shortHex(arcDeployment.marketFactory)}</strong>
            <a className="miniLinkButton" href={`${arcDeployment.explorerUrl}/address/${arcDeployment.marketFactory}`} target="_blank">
              View
            </a>
          </div>
          <div className="adminStatusRow">
            <span>Resolver</span>
            <strong>{shortHex(arcDeployment.oracleAdapter)}</strong>
            <a className="miniLinkButton" href={`${arcDeployment.explorerUrl}/address/${arcDeployment.oracleAdapter}`} target="_blank">
              View
            </a>
          </div>
          <div className="adminInfoList">
            <span>
              <ShieldCheck size={16} aria-hidden />
              Create test market is the main demo control — opens a live MicroMarket on Arc.
            </span>
            <span>
              <ExternalLink size={16} aria-hidden />
              Resolver tools stay collapsed below for manual override if needed.
            </span>
          </div>
        </div>
        <LiveReferencePanel compact />
      </section>
    </main>
  );
}

function shortHex(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
