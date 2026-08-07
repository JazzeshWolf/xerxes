import { useState } from "preact/hooks";
import type { Snapshot, ExpiryBlock, ChainRow } from "../lib/types";
import { fmt, fmtOi } from "../lib/format";
import { C, mix } from "../lib/palette";
import { Card } from "./ui";

// Broker-style option chain: CALLS | strike·IV | PUTS, compact rows with a
// subtle OI bar inside each side, ITM shading, spot divider, max-pain row in
// gold, walls at full brightness. Toggle switches the bars between total OI
// and today's ΔOI.

type View = "total" | "delta";
type Side = { ltp: number | null; oi: number; chg: number; iv: number | null };
type Row = { strike: number; ce: Side; pe: Side };

export function OiProfile({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const [view, setView] = useState<View>("total");
  const { chain, metrics } = exp;
  const spot = snap.spot.price;
  const em = metrics.expectedMove ?? 0;
  const total = view === "total";

  // Window: strikes within ~1.9× expected move (fallback ±2.5%), max 22 rows.
  const span = em > 0 ? em * 1.9 : spot * 0.025;
  let strikes = [...new Set(chain.map((o) => o.strike))].filter((k) => Math.abs(k - spot) <= span);
  if (strikes.length > 22) strikes = strikes.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot)).slice(0, 22);
  strikes.sort((a, b) => b - a); // top = highest strike
  if (strikes.length < 5) return null;

  const empty = (): Side => ({ ltp: null, oi: 0, chg: 0, iv: null });
  const byStrike = new Map<number, Row>(strikes.map((k) => [k, { strike: k, ce: empty(), pe: empty() }]));
  for (const o of chain as ChainRow[]) {
    const r = byStrike.get(o.strike);
    if (!r) continue;
    const side = o.type === "CE" ? r.ce : r.pe;
    side.ltp = o.ltp;
    side.oi += o.oi;
    side.chg += o.prevOi != null ? o.oi - o.prevOi : 0;
    if (o.iv != null) side.iv = o.iv;
  }
  const rows = strikes.map((k) => byStrike.get(k)!);

  const val = (s: Side) => (total ? s.oi : Math.abs(s.chg));
  const maxV = Math.max(1, ...rows.flatMap((r) => [val(r.ce), val(r.pe)]));
  const ceWall = rows.reduce((b, r) => (r.ce.oi > b.ce.oi ? r : b), rows[0]).strike;
  const peWall = rows.reduce((b, r) => (r.pe.oi > b.pe.oi ? r : b), rows[0]).strike;

  // Spot sits between two strikes — find the row index it belongs above.
  const spotAfterIdx = rows.findIndex((r) => r.strike < spot); // first strike below spot

  return (
    <Card
      title="Option chain"
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
      {/* header */}
      <div className="grid grid-cols-[1fr_74px_1fr] items-center text-[8.5px] uppercase tracking-wider text-white/35 pb-1 border-b border-white/[0.08]">
        <div className="flex justify-between pr-1">
          <span>{total ? "OI" : "ΔOI"}</span>
          <span>LTP</span>
        </div>
        <div className="text-center">Strike · IV</div>
        <div className="flex justify-between pl-1">
          <span>LTP</span>
          <span>{total ? "OI" : "ΔOI"}</span>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_74px_1fr] text-[8px] text-white/25 pb-0.5">
        <div className="text-left">CALLS · resistance</div>
        <div />
        <div className="text-right">PUTS · support</div>
      </div>

      <div>
        {rows.map((r, i) => {
          const isMaxPain = r.strike === metrics.maxPain;
          const isCeWall = r.strike === ceWall;
          const isPeWall = r.strike === peWall;
          const ceItm = r.strike < spot; // calls in-the-money below spot
          const peItm = r.strike > spot;
          return (
            <div key={r.strike}>
              {i === spotAfterIdx && spotAfterIdx > 0 && <SpotDivider spot={spot} />}
              <div
                className={`grid grid-cols-[1fr_74px_1fr] items-center rounded ${
                  isMaxPain ? "bg-amber-400/[0.10] outline outline-1 outline-amber-400/30" : ""
                }`}
              >
                <SideCell side={r.ce} kind="ce" total={total} maxV={maxV} wall={isCeWall} itm={ceItm} />
                <div className="text-center py-[3px] leading-tight">
                  <div
                    className={`tnum text-[11px] ${
                      isMaxPain ? "text-amber-300 font-bold" : isCeWall || isPeWall ? "text-white font-semibold" : "text-white/60"
                    }`}
                  >
                    {fmt(r.strike)}
                  </div>
                  <div className="text-[8px] text-white/30 tnum">
                    {avgIv(r) != null ? `${(avgIv(r)! * 100).toFixed(1)}` : "—"}
                  </div>
                </div>
                <SideCell side={r.pe} kind="pe" total={total} maxV={maxV} wall={isPeWall} itm={peItm} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex justify-between text-[9px] text-white/35">
        <span><span className="text-rose-300/80">■</span> call OI bar</span>
        <span className="text-amber-300/80">gold row = max pain</span>
        <span>shaded = ITM</span>
        <span><span className="text-emerald-300/80">■</span> put OI bar</span>
      </div>
      <div className="mt-0.5 text-center text-[9px] text-white/30">
        brightest bar = wall (largest OI) · {total ? "" : "Δ view: solid = build, outline = unwind · "}max {fmtOi(maxV)}
      </div>
    </Card>
  );
}

function avgIv(r: Row): number | null {
  const ivs = [r.ce.iv, r.pe.iv].filter((v): v is number => v != null && v > 0);
  return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
}

/**
 * One side of a row: an OI bar growing from the strike column outward with the
 * OI value on the bar's far end and the LTP next to the strike. Mirrored for
 * calls (left) and puts (right).
 */
function SideCell({ side, kind, total, maxV, wall, itm }: { side: Side; kind: "ce" | "pe"; total: boolean; maxV: number; wall: boolean; itm: boolean }) {
  const v = total ? side.oi : Math.abs(side.chg);
  const pct = Math.max(v > 0 ? 4 : 0, (v / maxV) * 100);
  const unwind = !total && side.chg < 0;
  const color = kind === "ce" ? C.oiCall : C.oiPut;
  const alpha = wall ? 0.85 : 0.25 + 0.45 * (v / maxV);
  const isCe = kind === "ce";
  return (
    <div className={`relative h-[22px] ${itm ? (isCe ? "bg-rose-400/[0.05]" : "bg-emerald-400/[0.05]") : ""} ${isCe ? "pr-1" : "pl-1"}`}>
      {/* bar grows from the centre (strike column) outward */}
      {pct > 0 && (
        <div
          className="absolute top-[4px] bottom-[4px] rounded"
          style={{
            [isCe ? "right" : "left"]: "2px",
            width: `${pct * 0.62}%`,
            background: unwind ? "transparent" : mix(color, alpha),
            border: unwind || wall ? `1px solid ${wall ? color : mix(color, 0.6)}` : "none",
          }}
        />
      )}
      {/* LTP near the strike column */}
      <span
        className={`absolute top-1/2 -translate-y-1/2 tnum text-[10px] text-white/80 ${isCe ? "right-[4px]" : "left-[4px]"}`}
        style={{ textShadow: C.glow }}
      >
        {side.ltp != null ? fmt(side.ltp, side.ltp < 100 ? 1 : 0) : "—"}
      </span>
      {/* OI value at the outer edge */}
      <span
        className={`absolute top-1/2 -translate-y-1/2 tnum text-[9px] ${wall ? "font-bold" : ""} ${isCe ? "left-0 text-rose-300/90" : "right-0 text-emerald-300/90"}`}
        style={{ textShadow: C.glowStrong }}
      >
        {v > 0 ? (total ? fmtOi(v) : fmtOi(side.chg, true)) : ""}
      </span>
    </div>
  );
}

function SpotDivider({ spot }: { spot: number }) {
  return (
    <div className="relative my-[3px]">
      <div className="border-t-2 border-dashed border-sky-400/80" />
      <span className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 top-0 px-1.5 py-[1px] rounded bg-sky-400 text-[8.5px] font-bold text-[color:var(--x-on-accent)] tnum">
        SPOT {fmt(spot)}
      </span>
    </div>
  );
}
