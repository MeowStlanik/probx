import { MarketsLoading } from "@/components/MarketsLoading";

export default function RootLoading() {
  return (
    <main className="pageLoadingRoot">
      <section className="heroAurora homeHero pageLoadingHero" aria-busy="true">
        <div className="heroCopy">
          <span className="eyebrow">ProbX Arc</span>
          <h1>Short YES/NO markets</h1>
          <p className="pageLoadingHint">
            <span className="marketsLoadingSpinner" aria-hidden />
            Loading markets & vault stats…
          </p>
        </div>
        <div className="heroDashboard homeDashboard pageLoadingDash">
          <div className="chartSkeletonShimmer pageLoadingBlock" />
          <div className="chartSkeletonShimmer pageLoadingBlock short" />
        </div>
      </section>
      <div className="pageShell homeBody">
        <MarketsLoading />
      </div>
    </main>
  );
}
