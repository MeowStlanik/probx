export function MarketsLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={compact ? "marketsLoading marketsLoadingCompact" : "marketsLoading"}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="marketsLoadingHeader">
        <span className="marketsLoadingSpinner" aria-hidden />
        <div>
          <strong>Loading markets…</strong>
          <p>Fetching live BTC & London weather windows from Arc.</p>
        </div>
      </div>
      <div className="cardGrid marketsLoadingGrid" aria-hidden>
        {Array.from({ length: compact ? 2 : 3 }).map((_, i) => (
          <div key={i} className="marketCardSkeleton">
            <div className="marketCardSkeletonLine w40" />
            <div className="marketCardSkeletonLine w90" />
            <div className="marketCardSkeletonLine w70" />
            <div className="marketCardSkeletonRow">
              <div className="marketCardSkeletonPill" />
              <div className="marketCardSkeletonPill" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PageLoadingShell() {
  return (
    <main className="pageShell pageShellTight pageLoadingShell">
      <div className="sectionHeader sectionHeaderCompact">
        <div>
          <span className="eyebrow">Live</span>
          <h1>Markets</h1>
        </div>
      </div>
      <MarketsLoading />
    </main>
  );
}
