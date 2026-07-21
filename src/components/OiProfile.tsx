import type { Snapshot, ExpiryBlock } from "../lib/types";
import { fmt, fmtOi } from "../lib/format";
import { Card } from "./ui";

/**
 * OI-by-strike profile: horizontal mirrored bars (puts left, calls right)
 * around a vertical strike axis, with spot, max-pain and expected-move
 * markers. Hand-rolled SVG, ~ a screenful of strikes around ATM.
 */
export function OiProfile({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const { chain, metrics } = exp;
  const spot = snap.spot.price;
  const em = metrics.expectedMove ?? 0;

  // Window: strikes within ~2.2× expected move (fallback ±3%) of spot.
  const span = em > 0 ? em * 2.2 : spot * 0.03;
  const strikes = [...new Set(chain.map((o) => o.strike))]
    .filter((k) => Math.abs(k - spot) <= span)
    .sort((a, b) => b - a); // top = highest strike
  if (strikes.length < 5) return null;

  const byStrike = new Map<number, { ce: number; pe: number; ceChg: number; peChg: number }>();
  for (const k of strikes) byStrike.set(k, { ce: 0, pe: 0, ceChg: 0, peChg: 0 });
  for (const o of chain) {
    const e = byStrike.get(o.strike);
    if (!e) continue;
    const chg = o.prevOi != null ? o.oi - o.prevOi : 0;
    if (o.type === "CE") { e.ce += o.oi; e.ceChg += chg; }
    else { e.pe += o.oi; e.peChg += chg; }
  }
  const maxOi = Math.max(1, ...[...byStrike.values()].flatMap((e) => [e.ce, e.pe]));

  const W = 340, rowH = 13, PAD_T = 14, PAD_B = 6;
  const H = strikes.length * rowH + PAD_T + PAD_B;
  const CX = W / 2, axisW = 44, half = (W - axisW) / 2 - 4;
  const y = (i: number) => PAD_T + i * rowH;
  const bw = (oi: number) => (oi / maxOi) * half;

  // spot line position by interpolation between strike rows
  const spotY = (() => {
    for (let i = 0; i < strikes.length - 1; i++) {
      if (spot <= strikes[i] && spot >= strikes[i + 1]) {
        const f = (strikes[i] - spot) / (strikes[i] - strikes[i + 1]);
        return y(i) + f * rowH + rowH / 2;
      }
    }
    return null;
  })();

  return (
    <Card
      title="OI profile"
      right={
        <span className="text-[9px] text-white/40">
          <span className="text-rose-300/80">■ calls (resistance)</span> · <span className="text-emerald-300/80">■ puts (support)</span>
        </span>
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {strikes.map((k, i) => {
          const e = byStrike.get(k)!;
          const yy = y(i);
          const isMaxPain = k === metrics.maxPain;
          const isWall = k === metrics.callWall || k === metrics.putWall;
          return (
            <g key={k}>
              {/* puts: left */}
              <rect x={CX - axisW / 2 - bw(e.pe)} y={yy + 2} width={bw(e.pe)} height={rowH - 4} rx={1.5} fill="rgb(52 211 153 / 0.65)" />
              {e.peChg !== 0 && (
                <rect x={CX - axisW / 2 - bw(Math.abs(e.peChg))} y={yy + 2} width={bw(Math.abs(e.peChg))} height={rowH - 4} rx={1.5}
                  fill={e.peChg > 0 ? "rgb(52 211 153)" : "rgb(10 14 20 / 0.55)"} />
              )}
              {/* calls: right */}
              <rect x={CX + axisW / 2} y={yy + 2} width={bw(e.ce)} height={rowH - 4} rx={1.5} fill="rgb(251 113 133 / 0.65)" />
              {e.ceChg !== 0 && (
                <rect x={CX + axisW / 2} y={yy + 2} width={bw(Math.abs(e.ceChg))} height={rowH - 4} rx={1.5}
                  fill={e.ceChg > 0 ? "rgb(251 113 133)" : "rgb(10 14 20 / 0.55)"} />
              )}
              <text x={CX} y={yy + rowH - 3} textAnchor="middle" fontSize="8.5"
                fill={isMaxPain ? "#fbbf24" : isWall ? "#fff" : "rgb(255 255 255 / 0.55)"}
                fontWeight={isMaxPain || isWall ? 700 : 400} className="tnum">
                {fmt(k)}
              </text>
            </g>
          );
        })}
        {/* spot marker */}
        {spotY != null && (
          <g>
            <line x1={8} x2={W - 8} y1={spotY} y2={spotY} stroke="rgb(125 211 252)" strokeWidth="1" strokeDasharray="3 3" />
            <text x={10} y={spotY - 3} textAnchor="start" fontSize="8.5" fill="rgb(125 211 252)" className="tnum">
              spot {fmt(spot)}
            </text>
          </g>
        )}
      </svg>
      <div className="flex justify-between text-[9px] text-white/35 mt-1 tnum">
        <span>max put OI {fmtOi(maxOi)}</span>
        <span className="text-amber-300/80">gold = max pain</span>
        <span>solid tip = today's ΔOI</span>
      </div>
    </Card>
  );
}
