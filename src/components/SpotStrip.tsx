import type { Snapshot } from "../lib/types";
import { fmt, fmtPct, fmtExpiry } from "../lib/format";
import { Card, Stat, Badge } from "./ui";

export function SpotStrip({ snap }: { snap: Snapshot }) {
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
        <div className="text-[11px] text-white/60">
          Expiry <span className="font-semibold text-white/85">{fmtExpiry(snap.expiry.date)}</span>
          <span className="text-white/40"> · {snap.expiry.dte === 0 ? "today" : `${snap.expiry.dte}d left`}</span>
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
