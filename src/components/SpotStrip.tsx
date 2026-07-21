import type { Snapshot } from "../lib/types";
import { fmt, fmtPct } from "../lib/format";
import { resolveHorizons } from "../lib/horizons";
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
      <HorizonChips snap={snap} selectedExpiry={selectedExpiry} onExpiryChange={onExpiryChange} />
    </Card>
  );
}

/** 1W / 1M / 2M quick-select chips — presets over the same expiry selection. */
function HorizonChips({
  snap,
  selectedExpiry,
  onExpiryChange,
}: {
  snap: Snapshot;
  selectedExpiry: string;
  onExpiryChange: (e: string) => void;
}) {
  const horizons = resolveHorizons(snap);
  const entries = Object.entries(horizons);
  if (entries.length < 2) return null;
  const anyFallback = entries.some(([, h]) => h.fallback);
  return (
    <div className="mt-2 flex items-center gap-1.5 flex-wrap">
      <span className="text-[10px] text-white/40">Horizon</span>
      {entries.map(([key, h]) => {
        const active = h.date === selectedExpiry;
        return (
          <button
            key={key}
            onClick={() => onExpiryChange(h.date)}
            className={`text-[10px] px-2 py-0.5 rounded-full border tnum ${
              active ? "border-white/45 text-white bg-white/[0.08]" : "border-white/12 text-white/55"
            }`}
          >
            {key}{h.fallback ? "*" : ""} <span className="text-white/35">· {h.dte}d</span>
          </button>
        );
      })}
      {anyFallback && <span className="text-[9px] text-white/30">* nearest available</span>}
    </div>
  );
}
