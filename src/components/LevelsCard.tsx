import type { Snapshot, ExpiryBlock } from "../lib/types";
import { fmt, fmtOi } from "../lib/format";
import { Card, Stat } from "./ui";

/** Key OI-derived levels: walls, max pain, ranked supports/resistances, GEX. */
export function LevelsCard({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const m = exp.metrics;
  const spot = snap.spot.price;
  const gexLabel =
    m.gex?.regime === "pinning" ? "pinning — expiry likely magnets to big strikes" :
    m.gex?.regime === "volatile" ? "short gamma — moves can run" :
    m.gex ? "balanced" : null;
  return (
    <Card title="Key levels (OI)">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Put wall" value={fmt(m.putWall)} sub="support magnet" tone={m.putWall != null && spot > m.putWall ? "up" : "down"} />
        <Stat label="Max pain" value={<span className="text-amber-300">{fmt(m.maxPain)}</span>} sub={m.maxPain != null ? `${fmt(((m.maxPain - spot) / spot) * 100, 1)}% away` : undefined} />
        <Stat label="Call wall" value={fmt(m.callWall)} sub="resistance magnet" tone={m.callWall != null && spot < m.callWall ? "down" : "up"} />
      </div>

      <div className="grid grid-cols-2 gap-3 mt-3 pt-2 border-t border-white/[0.06]">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-emerald-300/70 mb-1">Supports (put OI)</div>
          {m.supports.map((l) => (
            <div key={l.strike} className="flex justify-between text-xs tnum">
              <span className="text-white/85">{fmt(l.strike)}</span>
              <span className="text-white/40">{fmtOi(l.oi)}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-rose-300/70 mb-1">Resistances (call OI)</div>
          {m.resistances.map((l) => (
            <div key={l.strike} className="flex justify-between text-xs tnum">
              <span className="text-white/85">{fmt(l.strike)}</span>
              <span className="text-white/40">{fmtOi(l.oi)}</span>
            </div>
          ))}
        </div>
      </div>

      {gexLabel && (
        <div className="mt-2 pt-2 border-t border-white/[0.06] text-[10px] text-white/50">
          GEX: <span className="text-white/80">{gexLabel}</span>
          {m.gex?.pinStrike != null && <span className="tnum"> · pin {fmt(m.gex.pinStrike)}</span>}
        </div>
      )}
    </Card>
  );
}
