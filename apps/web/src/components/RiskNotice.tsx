import { ShieldAlert } from "lucide-react";

/** Compact footer disclaimer — keep short so it does not dominate demos. */
export function RiskNotice() {
  return (
    <aside className="riskNotice">
      <ShieldAlert size={16} aria-hidden />
      <p>Arc testnet demo. Tickets lock until resolve — claim in Portfolio.</p>
    </aside>
  );
}
