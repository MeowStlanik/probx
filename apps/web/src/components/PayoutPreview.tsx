import { ShieldCheck, TrendingUp, WalletCards } from "lucide-react";
import { formatUsdc } from "@/lib/format";
import type { Quote } from "@/lib/quote";

interface PayoutPreviewProps {
  quote: Quote;
  riskAmount: number;
}

export function PayoutPreview({ quote, riskAmount }: PayoutPreviewProps) {
  return (
    <div className="previewGrid">
      <div>
        <span className="metricLabel">
          <ShieldCheck size={15} aria-hidden />
          Max loss
        </span>
        <strong>{formatUsdc(riskAmount)}</strong>
      </div>
      <div>
        <span className="metricLabel">
          <TrendingUp size={15} aria-hidden />
          Potential payout
        </span>
        <strong>{formatUsdc(quote.payout)}</strong>
      </div>
      <div>
        <span className="metricLabel">
          <WalletCards size={15} aria-hidden />
          LP reserve
        </span>
        <strong>{formatUsdc(quote.requiredReserve)}</strong>
      </div>
    </div>
  );
}
