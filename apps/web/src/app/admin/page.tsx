import { OnchainAdminPanel } from "@/components/OnchainAdminPanel";
import { arcDeployment } from "@/lib/onchain";

export default function AdminPage() {
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const explorer = arcDeployment.explorerUrl || "https://testnet.arcscan.app";

  return (
    <main className="pageShell">
      <div className="adminHeaderRow">
        <h1>Admin</h1>
        <span className="operatorBadge">Operator only</span>
      </div>
      <p className="pageLead">Create test markets and manage resolution on Arc.</p>

      <section className="adminGrid">
        <OnchainAdminPanel />

        <div className="adminSideCol">
          <div className="adminPanel">
            <span className="adminCardTitle">Network</span>
            <div className="adminNetworkList">
              <div className="adminNetRow">
                <span>Network</span>
                <strong>Arc Testnet</strong>
              </div>
              <div className="adminNetRow">
                <span>Chain</span>
                <span className="mono">{arcDeployment.chainId}</span>
              </div>
              <div className="adminNetRow">
                <span>Factory</span>
                <a
                  className="mono adminNetLink"
                  href={`${explorer}/address/${arcDeployment.marketFactory}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(arcDeployment.marketFactory)} ↗
                </a>
              </div>
              <div className="adminNetRow">
                <span>Resolver</span>
                <a
                  className="mono adminNetLink"
                  href={`${explorer}/address/${arcDeployment.oracleAdapter}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {short(arcDeployment.oracleAdapter)} ↗
                </a>
              </div>
            </div>
          </div>

          <div className="adminPanel">
            <span className="adminCardTitle">Created this session</span>
            <p className="adminSessionEmpty">No markets created yet this session.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
