import type { Snapshot, ExpiryBlock } from "../lib/types";
import { fmt, fmtOi, fmtPct } from "../lib/format";
import { Card, Stat } from "./ui";

/** PCR, OI flow, IV state and the expected move band. */
export function MetricsCard({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const m = exp.metrics;
  const spot = snap.spot.price;
  const em = m.expectedMove;
  const flow = m.oiFlow;
  return (
    <Card title="Positioning & vol">
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="PCR (OI)"
          value={fmt(m.pcrOi, 2)}
          sub={m.pcrVolume != null ? `vol ${fmt(m.pcrVolume, 2)}` : undefined}
          tone={m.pcrOi != null ? (m.pcrOi > 1.1 ? "up" : m.pcrOi < 0.8 ? "down" : null) : null}
        />
        <Stat
          label="ATM IV"
          value={m.atmIv != null ? fmtPct(m.atmIv * 100, 1, false) : "—"}
          sub={m.ivRank != null ? `IV rank ${fmt(m.ivRank)}` : m.rv20 != null ? `RV20 ${fmtPct(m.rv20 * 100, 1, false)}` : undefined}
        />
        <Stat
          label="Straddle"
          value={m.straddle != null ? fmt(m.straddle) : "—"}
          sub="ATM CE+PE"
        />
      </div>

      {flow && (
        <div className="grid grid-cols-2 gap-2 mt-3 pt-2 border-t border-white/[0.06]">
          <Stat label="Put OI today" value={fmtOi(flow.putOiChg, true)} sub="writing = support" tone={flow.putOiChg > 0 ? "up" : "down"} />
          <Stat label="Call OI today" value={fmtOi(flow.callOiChg, true)} sub="writing = ceiling" tone={flow.callOiChg > 0 ? "down" : "up"} />
        </div>
      )}

      {em != null && em > 0 && (
        <div className="mt-3 pt-2 border-t border-white/[0.06]">
          <div className="flex justify-between text-[10px] text-white/40 mb-1">
            <span>Expected move to expiry (±1σ)</span>
            <span className="tnum">±{fmt(em)} pts</span>
          </div>
          <div className="relative h-5 rounded bg-white/[0.05]">
            <div className="absolute inset-y-0 rounded bg-sky-400/20" style={{ left: "15%", right: "15%" }} />
            <div className="absolute inset-y-0 w-px bg-sky-300" style={{ left: "50%" }} />
            <span className="absolute text-[9px] text-white/60 tnum top-1/2 -translate-y-1/2" style={{ left: "16%" }}>
              {fmt(spot - em)}
            </span>
            <span className="absolute text-[9px] text-white/60 tnum top-1/2 -translate-y-1/2 right-[16%]">
              {fmt(spot + em)}
            </span>
          </div>
          {m.skew != null && (
            <div className="text-[10px] text-white/45 mt-1.5">
              Skew: {m.skew > 0.005 ? "puts bid — downside fear priced" : m.skew < -0.005 ? "calls bid — upside chase" : "flat"}
              <span className="tnum"> ({fmt(m.skew * 100, 1)} vol pts)</span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
