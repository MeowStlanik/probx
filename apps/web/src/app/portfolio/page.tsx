import { PortfolioClient } from "@/components/PortfolioClient";

export default async function PortfolioPage() {
  return (
    <main className="pageShell">
      <div className="sectionHeader">
        <div>
          <span className="eyebrow">Positions</span>
          <h1>Portfolio</h1>
        </div>
      </div>

      <PortfolioClient />
    </main>
  );
}
