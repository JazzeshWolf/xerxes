import { useState } from "preact/hooks";
import type { Snapshot, ExpiryBlock } from "../lib/types";
import { fmt, fmtOi } from "../lib/format";
import { Card } from "./ui";

// Domain-standard semantic (disambiguated by left/right position + labels, so
// identity is never colour-alone): calls = resistance (rose), puts = support
// (emerald). Magnitude is carried by bar length AND an opacity ramp so minor
// strikes recede and the walls pop. Status markers: max pain (gold band),
// spot (cyan line + pill).
const ROSE = "244 63 94";
const EMER = "16 185 129";
const GOLD = "251 191 36";
const CYAN = "56 189 248";

type Row = { strike: number; ce: number; pe: number; ceChg: number; peChg: number };
type View = "total" | "delta";

export function OiProfile({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const [view, setView] = useState<View>("total");
  const { chain, metrics } = exp;
  const spot = snap.spot.price;
  const em = metrics.expectedMove ?? 0;

  // Window: strikes within ~1.9× expected move (fallback ±2.5%), capped to the
  // 24 nearest so the profile stays legible.
  const span = em > 0 ? em * 1.9 : spot * 0.025;
  let strikes = [...new Set(chain.map((o) => o.strike))].filter((k) => Math.abs(k - spot) <= span);
  if (strikes.length > 24) {
    strikes = strikes.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, 24);
  }
  strikes.sort((a, b) => b - a); // top = highest strike
  if (strikes.length < 5) return null;

  const rows: Row[] = strikes.map((k) => ({ strike: k, ce: 0, pe: 0, ceChg: 0, peChg: 0 }));
  const byStrike = new Map(rows.map((r) => [r.strike, r]));
  for (const o of chain) {
    const r = byStrike.get(o.strike);
    if (!r) continue;
    const chg = o.prevOi != null ? o.oi - o.prevOi : 0;
    if (o.type === "CE") { r.ce += o.oi; r.ceChg += chg; }
    else { r.pe += o.oi; r.peChg += chg; }
  }

  // Wall = biggest OI strike per side (prefer the analytics value, which is
  // computed on the full chain, when it falls inside the window).
  const callWall = inWindow(metrics.callWall, byStrike) ?? maxBy(rows, (r) => r.ce)?.strike ?? null;
  const putWall = inWindow(metrics.putWall, byStrike) ?? maxBy(rows, (r) => r.pe)?.strike ?? null;
  // Rank each side so we can label only the top few (mute the rest).
  const ceTop = [...rows].sort((a, b) => b.ce - a.ce).slice(0, 2).map((r) => r.strike);
  const peTop = [...rows].sort((a, b) => b.pe - a.pe).slice(0, 2).map((r) => r.strike);
  const chgTop = (sel: (r: Row) => number) =>
    [...rows].filter((r) => Math.abs(sel(r)) > 0).sort((a, b) => Math.abs(sel(b)) - Math.abs(sel(a))).slice(0, 2).map((r) => r.strike);
  const ceChgTop = chgTop((r) => r.ceChg);
  const peChgTop = chgTop((r) => r.peChg);

  const total = view === "total";
  const ceVal = (r: Row) => (total ? r.ce : Math.abs(r.ceChg));
  const peVal = (r: Row) => (total ? r.pe : Math.abs(r.peChg));
  const maxV = Math.max(1, ...rows.flatMap((r) => [ceVal(r), peVal(r)]));

  // Geometry (SVG user units; the panel scales it to full width). Wider viewBox
  // keeps the fixed-size text small relative to the bars.
  const W = 392, rowH = 15, PAD_T = 8, PAD_B = 8;
  const H = rows.length * rowH + PAD_T + PAD_B;
  const CX = W / 2, GUTTER = 66, MARGIN = 46;
  const innerL = CX - GUTTER / 2, innerR = CX + GUTTER / 2;
  const maxBar = innerL - MARGIN; // longest bar leaves MARGIN for the tip value
  const y = (i: number) => PAD_T + i * rowH;
  const barW = (v: number) => (v / maxV) * maxBar;
  const alpha = (v: number) => 0.2 + 0.65 * (v / maxV);

  const spotText = `SPOT ${fmt(spot)}`;
  const spotY = interpY(rows, spot, y, rowH);
  const rowIndex = (k: number | null) => (k == null ? -1 : rows.findIndex((r) => r.strike === k));
  const mpIdx = rowIndex(metrics.maxPain);

  return (
    <Card
      title="OI profile"
      right={
        <div className="flex gap-1">
          {(["total", "delta"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${
                view === v ? "border-white/40 text-white" : "border-white/10 text-white/40"
              }`}
            >
              {v === "total" ? "Total OI" : "Δ today"}
            </button>
          ))}
        </div>
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ fontVariantNumeric: "tabular-nums" }}>
        {/* max-pain horizontal band (behind bars) */}
        {mpIdx >= 0 && (
          <g>
            <rect x={4} y={y(mpIdx)} width={W - 8} height={rowH} fill={`rgb(${GOLD} / 0.12)`} rx={2} />
            <line x1={4} x2={W - 4} y1={y(mpIdx)} y2={y(mpIdx)} stroke={`rgb(${GOLD} / 0.45)`} strokeWidth="0.75" />
            <line x1={4} x2={W - 4} y1={y(mpIdx) + rowH} y2={y(mpIdx) + rowH} stroke={`rgb(${GOLD} / 0.45)`} strokeWidth="0.75" />
          </g>
        )}

        {rows.map((r, i) => {
          const yy = y(i);
          const bh = rowH - 4;
          const pv = peVal(r), cv = ceVal(r);
          const pW = barW(pv), cW = barW(cv);
          const isPutWall = r.strike === putWall;
          const isCallWall = r.strike === callWall;
          const showPe = total ? peTop.includes(r.strike) : peChgTop.includes(r.strike);
          const showCe = total ? ceTop.includes(r.strike) : ceChgTop.includes(r.strike);
          // delta view: dim the "unwind" (OI fell) direction
          const peDim = !total && r.peChg < 0;
          const ceDim = !total && r.ceChg < 0;
          return (
            <g key={r.strike}>
              {/* puts — grow left */}
              {pW > 0.5 && (
                <rect
                  x={innerL - pW} y={yy + 2} width={pW} height={bh} rx={2}
                  fill={peDim ? "none" : `rgb(${EMER} / ${isPutWall ? 0.95 : alpha(pv)})`}
                  stroke={isPutWall ? `rgb(${EMER})` : peDim ? `rgb(${EMER} / 0.5)` : "none"}
                  strokeWidth={isPutWall ? 1 : peDim ? 0.75 : 0}
                />
              )}
              {/* total view: bright ΔOI cap at the put bar tip when material */}
              {total && Math.abs(r.peChg) > maxV * 0.06 && barW(Math.abs(r.peChg)) > 1 && (
                <rect x={innerL - pW} y={yy + 2} width={Math.min(barW(Math.abs(r.peChg)), pW)} height={bh} rx={2}
                  fill={r.peChg > 0 ? `rgb(${EMER})` : `rgb(10 14 20 / 0.5)`} />
              )}
              {/* calls — grow right */}
              {cW > 0.5 && (
                <rect
                  x={innerR} y={yy + 2} width={cW} height={bh} rx={2}
                  fill={ceDim ? "none" : `rgb(${ROSE} / ${isCallWall ? 0.95 : alpha(cv)})`}
                  stroke={isCallWall ? `rgb(${ROSE})` : ceDim ? `rgb(${ROSE} / 0.5)` : "none"}
                  strokeWidth={isCallWall ? 1 : ceDim ? 0.75 : 0}
                />
              )}
              {total && Math.abs(r.ceChg) > maxV * 0.06 && barW(Math.abs(r.ceChg)) > 1 && (
                <rect x={innerR} y={yy + 2} width={Math.min(barW(Math.abs(r.ceChg)), cW)} height={bh} rx={2}
                  fill={r.ceChg > 0 ? `rgb(${ROSE})` : `rgb(10 14 20 / 0.5)`} />
              )}

              {/* tip value labels — only the ranked strikes, mute the rest */}
              {showPe && pv > 0 && (
                <text x={innerL - pW - 4} y={yy + rowH - 4.5} textAnchor="end" fontSize="7.5"
                  fontWeight={isPutWall ? 700 : 400} fill={`rgb(${EMER} / ${isPutWall ? 1 : 0.75})`}
                  stroke="#0a0e14" strokeWidth={2.2} style={{ paintOrder: "stroke" }}>
                  {signed(total ? pv : r.peChg, total)}
                </text>
              )}
              {showCe && cv > 0 && (
                <text x={innerR + cW + 4} y={yy + rowH - 4.5} textAnchor="start" fontSize="7.5"
                  fontWeight={isCallWall ? 700 : 400} fill={`rgb(${ROSE} / ${isCallWall ? 1 : 0.75})`}
                  stroke="#0a0e14" strokeWidth={2.2} style={{ paintOrder: "stroke" }}>
                  {signed(total ? cv : r.ceChg, total)}
                </text>
              )}
              {/* centre strike label — colour-coded for key levels, muted for minors */}
              <text x={CX} y={yy + rowH - 4.5} textAnchor="middle" fontSize="7.5"
                fontWeight={isCallWall || isPutWall || r.strike === metrics.maxPain ? 700 : 400}
                fill={
                  r.strike === metrics.maxPain ? `rgb(${GOLD})` :
                  isCallWall ? `rgb(${ROSE})` :
                  isPutWall ? `rgb(${EMER})` :
                  "rgb(255 255 255 / 0.5)"
                }>
                {fmt(r.strike)}
              </text>
            </g>
          );
        })}

        {/* spot line + label (on top) — dark halo so it reads over any bar */}
        {spotY != null && (
          <g>
            <line x1={4} x2={W - 4} y1={spotY} y2={spotY} stroke={`rgb(${CYAN})`} strokeWidth="2" strokeDasharray="1 3" />
            <text x={5} y={spotY + 3} textAnchor="start" fontSize="8" fontWeight={700}
              fill={`rgb(${CYAN})`} stroke="#0a0e14" strokeWidth={2.6} style={{ paintOrder: "stroke" }}>
              {spotText}
            </text>
          </g>
        )}
      </svg>

      <div className="mt-1.5 space-y-1">
        <div className="flex justify-between text-[9px] text-white/35">
          <span><span className="text-emerald-300/80">■</span> puts / support</span>
          <span>{total ? "bright tip = today's Δ OI" : "solid = writing · outline = unwind"}</span>
          <span><span className="text-rose-300/80">■</span> calls / resistance</span>
        </div>
        <div className="flex justify-center gap-3 text-[9px] text-white/40">
          <span><span className="text-sky-400">▬</span> spot</span>
          <span><span className="text-amber-400">▬</span> max pain</span>
          <span>brightest bar = wall (largest OI)</span>
        </div>
      </div>
    </Card>
  );
}

// ---- helpers ----
function maxBy<T>(xs: T[], f: (x: T) => number): T | null {
  let best: T | null = null, bv = -Infinity;
  for (const x of xs) { const v = f(x); if (v > bv) { bv = v; best = x; } }
  return best;
}
function inWindow(k: number | null, m: Map<number, unknown>): number | null {
  return k != null && m.has(k) ? k : null;
}
function interpY(rows: { strike: number }[], spot: number, y: (i: number) => number, rowH: number): number | null {
  for (let i = 0; i < rows.length - 1; i++) {
    if (spot <= rows[i].strike && spot >= rows[i + 1].strike) {
      const f = (rows[i].strike - spot) / (rows[i].strike - rows[i + 1].strike);
      return y(i) + f * rowH + rowH / 2;
    }
  }
  return null;
}
/** Format an OI or ΔOI value; ΔOI carries a sign. */
function signed(v: number, total: boolean): string {
  return total ? fmtOi(v) : fmtOi(v, true);
}
