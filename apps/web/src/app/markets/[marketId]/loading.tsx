export default function MarketDetailLoading() {
  return (
    <main className="pageShell pageShellTight" aria-busy="true">
      <div className="marketsLoading marketsLoadingCompact" role="status" aria-live="polite">
        <div className="marketsLoadingHeader">
          <span className="marketsLoadingSpinner" aria-hidden />
          <div>
            <strong>Loading market…</strong>
            <p>Pulling live odds, lifecycle, and trade ticket.</p>
          </div>
        </div>
        <div className="marketCardSkeleton marketDetailSkeleton">
          <div className="marketCardSkeletonLine w40" />
          <div className="marketCardSkeletonLine w90" />
          <div className="marketCardSkeletonLine w70" />
          <div className="chartSkeletonShimmer" style={{ height: "12rem", marginTop: "0.75rem" }} />
        </div>
      </div>
    </main>
  );
}
