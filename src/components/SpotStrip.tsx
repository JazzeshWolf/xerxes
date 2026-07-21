import type { Snapshot } from "../lib/types";
import { fmt, fmtPct } from "../lib/format";
import { Card, Stat, Badge, ExpiryPicker } from "./ui";

export function SpotStrip({
  snap,
  selectedExpiry,
  onExpiryChange,
}: {
  snap: Snapshot;
  selectedExpiry: string;
  onExpiryChange: (e: string) => void;
}) {
  const chg = snap.spot.changePct;
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold tnum">{fmt(snap.spot.price, 2)}</span>
            <span className={`text-sm font-semibold tnum ${chg != null && chg < 0 ? "text-rose-400" : "text-emerald-400"}`}>
              {fmtPct(chg, 2)}
            </span>
          </div>
          <div className="text-[11px] text-white/40 mt-0.5">
            {snap.name} · {snap.expiryKind}
            {snap.lotSize != null && ` · lot ${snap.lotSize}`}
          </div>
        </div>
        <div className="text-right space-y-1">
          <Stat label="India VIX" value={fmt(snap.vix.value, 2)} />
          {snap.future?.basisPts != null && (
            <div className="text-[10px] text-white/40 tnum">
              basis {snap.future.basisPts > 0 ? "+" : ""}
              {fmt(snap.future.basisPts, 1)} pts
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/[0.06]">
        <div className="flex items-center gap-2 text-[11px] text-white/60">
          <span>Expiry</span>
          <ExpiryPicker snap={snap} value={selectedExpiry} onChange={onExpiryChange} />
        </div>
        <div className="flex gap-1">
          {snap.stale && <Badge tone="warn">stale</Badge>}
          {snap.source === "nse" && <Badge>NSE free</Badge>}
          {snap.source === "fixture" && <Badge tone="warn">demo data</Badge>}
        </div>
      </div>
    </Card>
  );
}
