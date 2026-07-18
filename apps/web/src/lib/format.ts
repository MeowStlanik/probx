export function formatUsdc(value: number, maximumFractionDigits = 2): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits
  }).format(value)} USDC`;
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

/** Show one decimal so 0.1 USDC impact (e.g. 51.5%) is visible, not rounded away. */
export function formatPercent(value: number): string {
  const pct = value * 100;
  if (!Number.isFinite(pct)) return "—";
  const rounded = Math.round(pct * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/**
 * On-chain / book prices include overround (YES+NO ≈ 1.08).
 * UI should show implied shares that sum to 100% so users don't see "108% market".
 * Trading math still uses raw yesPrice/noPrice from the market.
 */
export function normalizeDisplayOdds(yesPrice: number, noPrice: number): { yes: number; no: number } {
  const y = Number.isFinite(yesPrice) ? Math.max(0, yesPrice) : 0;
  const n = Number.isFinite(noPrice) ? Math.max(0, noPrice) : 0;
  const sum = y + n;
  if (sum <= 0) return { yes: 0.5, no: 0.5 };
  return { yes: y / sum, no: n / sum };
}

/** Format a side after normalizing the YES/NO pair to 100%. */
export function formatDisplayOdds(
  yesPrice: number,
  noPrice: number,
  side: "YES" | "NO"
): string {
  const { yes, no } = normalizeDisplayOdds(yesPrice, noPrice);
  return formatPercent(side === "YES" ? yes : no);
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function secondsUntil(isoDate: string): number {
  return Math.max(0, Math.ceil((new Date(isoDate).getTime() - Date.now()) / 1000));
}
