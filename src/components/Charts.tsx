import type { Snapshot, ExpiryBlock, Point } from "../lib/types";
import { fmt } from "../lib/format";
import { C } from "../lib/palette";
import { Card } from "./ui";

// Hand-rolled SVG charts for the Holistic tab — price vs the option-defined
// battlefield (walls, max pain, expected move) and the VIX fear gauge.

const W = 340, H = 130, PAD = { t: 10, r: 76, b: 14, l: 6 };

/** Stagger label y-positions so close-together levels never overlap. */
function layoutLabels<T extends { y: number }>(items: T[], minGap = 10, top = 8, bottom = H - 4): T[] {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < minGap) sorted[i].y = sorted[i - 1].y + minGap;
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].y > bottom) sorted[i].y = bottom;
    if (i < sorted.length - 1 && sorted[i + 1].y - sorted[i].y < minGap) sorted[i].y = sorted[i + 1].y - minGap;
  }
  for (const it of sorted) if (it.y < top) it.y = top;
  return sorted;
}

function scale(points: number[], lo: number, hi: number, outLo: number, outHi: number) {
  const span = hi - lo || 1;
  return points.map((v) => outLo + ((v - lo) / span) * (outHi - outLo));
}

function linePath(xs: number[], ys: number[]): string {
  return xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join("");
}

/** Price line (≈60 sessions) + put/call walls, max pain, and the expected-move band into expiry. */
export function PriceLevelsChart({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const hist: Point[] = snap.spot.history.slice(-60);
  if (hist.length < 10) return null;
  const m = exp.metrics;
  const spot = snap.spot.price;
  const em = m.expectedMove ?? 0;

  const values = hist.map((p) => p.v);
  const levels = [m.putWall, m.callWall, m.maxPain, em > 0 ? spot - em : null, em > 0 ? spot + em : null]
    .filter((v): v is number => v != null);
  const lo = Math.min(...values, ...levels) * 0.998;
  const hi = Math.max(...values, ...levels) * 1.002;
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const xs = scale(hist.map((_, i) => i), 0, hist.length - 1, PAD.l, W - PAD.r);
  const ys = values.map(y);
  const xEnd = W - PAD.r;

  // Right-edge labels: staggered so nearby levels never overlap.
  type Lbl = { y: number; lineY: number; color: string; text: string; bold?: boolean };
  const lbls: Lbl[] = [];
  if (m.callWall != null) lbls.push({ y: y(m.callWall), lineY: y(m.callWall), color: C.bear, text: `CW ${fmt(m.callWall)}` });
  if (m.putWall != null) lbls.push({ y: y(m.putWall), lineY: y(m.putWall), color: C.bull, text: `PW ${fmt(m.putWall)}` });
  if (m.maxPain != null) lbls.push({ y: y(m.maxPain), lineY: y(m.maxPain), color: C.warn, text: `MP ${fmt(m.maxPain)}` });
  lbls.push({ y: y(spot), lineY: y(spot), color: C.info, text: `spot ${fmt(spot)}`, bold: true });
  const placed = layoutLabels(lbls);

  return (
    <Card title="Price vs the battlefield">
      <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {/* expected-move band into expiry (right edge) */}
        {em > 0 && (
          <rect x={xEnd - 26} y={y(spot + em)} width={26} height={Math.max(2, y(spot - em) - y(spot + em))} style={{ fill: C.infoWash }} rx={2} />
        )}
        {m.callWall != null && (
          <line x1={PAD.l} x2={xEnd} y1={y(m.callWall)} y2={y(m.callWall)} style={{ stroke: C.bear }} strokeWidth="1" strokeDasharray="4 3" opacity="0.75" />
        )}
        {m.putWall != null && (
          <line x1={PAD.l} x2={xEnd} y1={y(m.putWall)} y2={y(m.putWall)} style={{ stroke: C.bull }} strokeWidth="1" strokeDasharray="4 3" opacity="0.75" />
        )}
        {m.maxPain != null && (
          <line x1={PAD.l} x2={xEnd} y1={y(m.maxPain)} y2={y(m.maxPain)} style={{ stroke: C.warn }} strokeWidth="1" strokeDasharray="1 3" opacity="0.8" />
        )}
        {/* price line */}
        <path d={linePath(xs, ys)} fill="none" style={{ stroke: C.info }} strokeWidth="1.6" />
        <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="2.5" style={{ fill: C.info }} />
        {/* leader ticks from each level line to its staggered label */}
        {placed.map((l) => (
          <line key={l.text} x1={xEnd} x2={xEnd + 4} y1={l.lineY} y2={l.y} style={{ stroke: l.color }} strokeWidth="0.75" opacity="0.6" />
        ))}
      </svg>
      {/* HTML labels overlaid on the SVG — predictable size, never clipped */}
      {placed.map((l) => (
        <span
          key={l.text}
          className={`absolute right-0 tnum text-[9px] leading-none ${l.bold ? "font-bold" : ""}`}
          style={{ top: `${(l.y / H) * 100}%`, transform: "translateY(-50%)", color: l.color, textShadow: C.glow }}
        >
          {l.text}
        </span>
      ))}
      </div>
      <div className="flex gap-3 text-[9px] text-white/40 mt-1">
        <span><span className="text-rose-300/90">CW</span> call wall</span>
        <span><span className="text-emerald-300/90">PW</span> put wall</span>
        <span><span className="text-amber-300/90">MP</span> max pain</span>
        <span className="text-sky-300/70">▮ priced move</span>
      </div>
      <div className="text-[10px] text-white/45 mt-1 leading-relaxed">
        The last ~3 months of price against the option-defined levels for this expiry. The faint blue box at the
        right edge is the ±{fmt(em)}-pt move the market itself is pricing by {exp.dte === 0 ? "today's close" : `expiry (${exp.dte}d)`} —
        price is expected to stay inside it; the walls are where writers defend.
      </div>
    </Card>
  );
}

/** VIX sparkline — the fear gauge with a plain-English read. */
export function VixChart({ snap }: { snap: Snapshot }) {
  const hist: Point[] = snap.vix.history.slice(-60);
  if (hist.length < 10 || snap.vix.value == null) return null;
  const values = hist.map((p) => p.v);
  const lo = Math.min(...values) * 0.97;
  const hi = Math.max(...values) * 1.03;
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H * 0.62 - PAD.t - 8);
  const xs = scale(hist.map((_, i) => i), 0, hist.length - 1, PAD.l, W - PAD.r);
  const ys = values.map(y);
  const cur = snap.vix.value;
  const prev5 = values.length > 5 ? values[values.length - 6] : values[0];
  const chg5 = prev5 > 0 ? ((cur - prev5) / prev5) * 100 : 0;
  const calm = cur < 13, elevated = cur > 17;

  return (
    <Card title="India VIX — the fear gauge">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H * 0.62}`} className="w-full">
          <path d={linePath(xs, ys)} fill="none" style={{ stroke: C.warn }} strokeWidth="1.6" />
          <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r="2.5" style={{ fill: C.warn }} />
        </svg>
        <span
          className="absolute right-0 tnum text-[10px] font-bold leading-none"
          style={{ top: `${(ys[ys.length - 1] / (H * 0.62)) * 100}%`, transform: "translateY(-50%)", color: C.warn }}
        >
          {fmt(cur, 2)}
        </span>
      </div>
      <div className="text-[10px] text-white/45 mt-1 leading-relaxed">
        VIX {fmt(cur, 2)} is {calm ? "low — a calm market where option premiums are thin but moves tend to stay contained" : elevated ? "elevated — nervousness is priced in; premiums are fat but swings can be violent" : "middling — neither calm nor stressed"}.
        {" "}It has moved {chg5 >= 0 ? "up" : "down"} {fmt(Math.abs(chg5), 1)}% over 5 sessions — {chg5 <= -3 ? "falling fear usually supports the index" : chg5 >= 3 ? "rising fear is a headwind for the index" : "roughly stable"}.
      </div>
    </Card>
  );
}
