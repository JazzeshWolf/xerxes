import { useState, useEffect, useMemo } from "preact/hooks";
import type { Snapshot, ExpiryBlock } from "../lib/types";
import type { Leg } from "../lib/position";
import { analyzePosition } from "../lib/position";
import { fmt } from "../lib/format";
import { Card, Stat, Badge } from "./ui";

let seq = 0;
const uid = () => `l${Date.now()}${seq++}`;
const rupee = (n: number | null) => (n == null ? "unlimited" : `${n < 0 ? "-" : ""}₹${fmt(Math.abs(n))}`);

/** Analyze a user's multi-leg option position against the live market. */
export function PositionTab({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const key = `xerxes.pos.${snap.index}`;
  const [legs, setLegs] = useState<Leg[]>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(legs));
  }, [legs, key]);

  const strikes = useMemo(
    () => [...new Set(exp.chain.map((o) => o.strike))].sort((a, b) => a - b),
    [exp.chain],
  );
  const spot = snap.spot.price;
  const em = exp.metrics.expectedMove ?? spot * 0.02;
  const nearest = (t: number) => strikes.reduce((b, s) => (Math.abs(s - t) < Math.abs(b - t) ? s : b), strikes[0] ?? t);

  const setTemplate = (t: string) => {
    const p1 = nearest(spot - em), c1 = nearest(spot + em);
    const p2 = nearest(spot - 2 * em), c2 = nearest(spot + 2 * em);
    const mk = (type: "CE" | "PE", side: "buy" | "sell", strike: number): Leg => ({ id: uid(), type, side, strike, lots: 1 });
    const map: Record<string, Leg[]> = {
      sellput: [mk("PE", "sell", p1)],
      sellcall: [mk("CE", "sell", c1)],
      strangle: [mk("PE", "sell", p1), mk("CE", "sell", c1)],
      condor: [mk("PE", "buy", p2), mk("PE", "sell", p1), mk("CE", "sell", c1), mk("CE", "buy", c2)],
      bullput: [mk("PE", "sell", p1), mk("PE", "buy", p2)],
      bearcall: [mk("CE", "sell", c1), mk("CE", "buy", c2)],
    };
    setLegs(map[t] ?? []);
  };

  const addLeg = () => setLegs((ls) => [...ls, { id: uid(), type: "PE", side: "sell", strike: nearest(spot), lots: 1 }]);
  const upd = (id: string, patch: Partial<Leg>) => setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const del = (id: string) => setLegs((ls) => ls.filter((l) => l.id !== id));
  // Slide every leg up/down one strike step — keeps the shape, moves the whole
  // position across the board so you can see how the payoff shifts.
  const shift = (dir: 1 | -1) =>
    setLegs((ls) =>
      ls.map((l) => {
        const i = strikes.indexOf(l.strike);
        if (i === -1) return l;
        const ni = Math.min(strikes.length - 1, Math.max(0, i + dir));
        return { ...l, strike: strikes[ni] };
      }),
    );

  const result = useMemo(() => analyzePosition(legs, snap, exp), [legs, snap, exp]);

  return (
    <div className="space-y-3">
      <Card title="Build a position" right={<span className="text-[9px] text-white/40">on {exp.label} expiry · {exp.dte}d</span>}>
        <div className="flex flex-wrap gap-1 mb-2">
          {[
            ["sellput", "Sell Put"], ["sellcall", "Sell Call"], ["strangle", "Strangle"],
            ["condor", "Iron Condor"], ["bullput", "Bull Put"], ["bearcall", "Bear Call"],
          ].map(([k, label]) => (
            <button key={k} onClick={() => setTemplate(k)} className="text-[10px] px-2 py-1 rounded-full border border-white/12 text-white/60 active:bg-white/[0.08]">
              {label}
            </button>
          ))}
          {legs.length > 0 && (
            <button onClick={() => setLegs([])} className="text-[10px] px-2 py-1 rounded-full border border-rose-400/25 text-rose-300/70 active:bg-white/[0.08]">
              Clear
            </button>
          )}
        </div>

        {result.legs.length === 0 && (
          <div className="text-[11px] text-white/45 py-2">
            Pick a template above or add legs manually — e.g. sell a 24,000 put. The app fetches the live premium and greeks and
            grades the trade against the current market.
          </div>
        )}

        <div className="space-y-1.5">
          {result.legs.map((l) => (
            <div key={l.id} className="flex items-center gap-1.5 text-[11px]">
              <button
                onClick={() => upd(l.id, { side: l.side === "sell" ? "buy" : "sell" })}
                className={`w-11 shrink-0 py-1 rounded font-semibold ${l.side === "sell" ? "bg-rose-500/20 text-rose-300" : "bg-emerald-500/20 text-emerald-300"}`}
              >
                {l.side === "sell" ? "SELL" : "BUY"}
              </button>
              <button
                onClick={() => upd(l.id, { type: l.type === "CE" ? "PE" : "CE" })}
                className="w-9 shrink-0 py-1 rounded bg-white/[0.06] text-white/80 font-semibold"
              >
                {l.type}
              </button>
              <select
                value={l.strike}
                onChange={(e) => upd(l.id, { strike: Number((e.target as HTMLSelectElement).value) })}
                className="flex-1 min-w-0 py-1 px-1 rounded bg-white/[0.06] border border-white/10 text-white/85 tnum"
              >
                {strikes.map((s) => (
                  <option key={s} value={s}>{fmt(s)}</option>
                ))}
              </select>
              <input
                type="number" min={1} value={l.lots}
                onChange={(e) => upd(l.id, { lots: Math.max(1, Number((e.target as HTMLInputElement).value) || 1) })}
                className="w-11 shrink-0 py-1 px-1 rounded bg-white/[0.06] border border-white/10 text-white/85 tnum text-center"
              />
              <span className="w-12 shrink-0 text-right tnum text-white/50">{l.premium != null ? fmt(l.premium, 1) : "—"}</span>
              <button onClick={() => del(l.id)} className="w-5 shrink-0 text-white/30 active:text-rose-300">✕</button>
            </div>
          ))}
        </div>
        {result.legs.length > 0 && (
          <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-white/[0.06]">
            <span className="text-[10px] text-white/45 shrink-0">Shift strikes</span>
            <button onClick={() => shift(-1)} aria-label="shift down a strike" className="w-8 h-7 grid place-items-center rounded-lg border border-white/15 text-white/80 active:bg-white/[0.08]">◀</button>
            <button onClick={() => shift(1)} aria-label="shift up a strike" className="w-8 h-7 grid place-items-center rounded-lg border border-white/15 text-white/80 active:bg-white/[0.08]">▶</button>
            <span className="text-[9px] text-white/30 leading-tight">slide the whole position up/down a strike and watch the payoff move</span>
          </div>
        )}
        <div className="flex items-center justify-between mt-2">
          <button onClick={addLeg} className="text-[11px] px-2.5 py-1 rounded-full border border-white/15 text-white/70 active:bg-white/[0.08]">+ add leg</button>
          <span className="text-[10px] text-white/40">lot size {snap.lotSize ?? "—"} · lots × premium = credit/leg</span>
        </div>
      </Card>

      {result.valid && (
        <>
          <PayoffChart result={result} />
          <StatsCard result={result} />
          <FitCard result={result} />
        </>
      )}
    </div>
  );
}

function PayoffChart({ result }: { result: ReturnType<typeof analyzePosition> }) {
  const { curve, spot, expectedMove: em, breakevens, maxProfit, maxLoss, callWall, putWall } = result;
  if (!curve.length) return null;
  const W = 340, H = 150, PADX = 6, PADT = 12, PADB = 16;
  const xs = curve.map((p) => p.s);
  const ys = curve.map((p) => p.pnl);
  const sLo = xs[0], sHi = xs[xs.length - 1];
  const pMax = Math.max(1, ...ys), pMin = Math.min(-1, ...ys);
  const x = (s: number) => PADX + ((s - sLo) / (sHi - sLo)) * (W - 2 * PADX);
  const y = (p: number) => PADT + (1 - (p - pMin) / (pMax - pMin)) * (H - PADT - PADB);
  const y0 = y(0);
  const inWin = (s: number | null): s is number => s != null && s >= sLo && s <= sHi;
  const line = curve.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.s).toFixed(1)},${y(p.pnl).toFixed(1)}`).join("");
  // Close the curve down to the zero line, then clip above/below to split the
  // profit (green) and loss (red) shading.
  const areaTop = `${line} L${x(sHi)},${y0} L${x(sLo)},${y0} Z`;

  return (
    <Card title="Payoff at expiry">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <clipPath id="above"><rect x={0} y={0} width={W} height={y0} /></clipPath>
          <clipPath id="below"><rect x={0} y={y0} width={W} height={H - y0} /></clipPath>
          <linearGradient id="pgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgb(52 211 153)" stop-opacity="0.55" />
            <stop offset="100%" stop-color="rgb(52 211 153)" stop-opacity="0.08" />
          </linearGradient>
          <linearGradient id="lgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgb(244 63 94)" stop-opacity="0.08" />
            <stop offset="100%" stop-color="rgb(244 63 94)" stop-opacity="0.55" />
          </linearGradient>
        </defs>
        {/* expected-move band */}
        <rect x={x(spot - em)} y={PADT} width={Math.max(0, x(spot + em) - x(spot - em))} height={H - PADT - PADB} fill="rgb(56 189 248 / 0.06)" />
        {/* profit / loss shading */}
        <path d={areaTop} fill="url(#pgrad)" clipPath="url(#above)" />
        <path d={areaTop} fill="url(#lgrad)" clipPath="url(#below)" />
        {/* zero line */}
        <line x1={PADX} x2={W - PADX} y1={y0} y2={y0} stroke="rgb(255 255 255 / 0.3)" strokeWidth="0.75" strokeDasharray="3 3" />
        {/* OI walls (biggest call/put OI for this expiry) */}
        {inWin(putWall) && (
          <line x1={x(putWall)} x2={x(putWall)} y1={PADT} y2={H - PADB} stroke="rgb(167 139 250 / 0.6)" strokeWidth="1" strokeDasharray="1 2" />
        )}
        {inWin(callWall) && (
          <line x1={x(callWall)} x2={x(callWall)} y1={PADT} y2={H - PADB} stroke="rgb(167 139 250 / 0.6)" strokeWidth="1" strokeDasharray="1 2" />
        )}
        {inWin(putWall) && <text x={x(putWall)} y={PADT - 3} textAnchor="middle" fontSize="6.5" fill="rgb(196 181 253)" className="tnum">P {fmt(putWall)}</text>}
        {inWin(callWall) && <text x={x(callWall)} y={PADT - 3} textAnchor="middle" fontSize="6.5" fill="rgb(196 181 253)" className="tnum">C {fmt(callWall)}</text>}
        {/* payoff line */}
        <path d={line} fill="none" stroke="rgb(241 245 249)" strokeWidth="1.8" />
        {/* spot */}
        <line x1={x(spot)} x2={x(spot)} y1={PADT} y2={H - PADB} stroke="rgb(125 211 252)" strokeWidth="1" strokeDasharray="2 2" />
        <text x={x(spot)} y={H - 5} textAnchor="middle" fontSize="7.5" fill="rgb(125 211 252)" className="tnum">{fmt(spot)}</text>
        {/* breakevens */}
        {breakevens.map((b) => (
          <g key={b}>
            <line x1={x(b)} x2={x(b)} y1={y0 - 4} y2={y0 + 4} stroke="rgb(251 191 36)" strokeWidth="1.5" />
            <text x={x(b)} y={PADT + 7} textAnchor="middle" fontSize="7" fill="rgb(251 191 36)" className="tnum">{fmt(b)}</text>
          </g>
        ))}
      </svg>
      <div className="flex justify-between text-[9px] text-white/40 mt-1">
        <span className="text-emerald-300/80">max profit {rupee(maxProfit)}</span>
        <span className="text-amber-300/80">◆ breakeven</span>
        <span className="text-rose-300/80">max loss {rupee(maxLoss)}</span>
      </div>
      {(callWall != null || putWall != null) && (
        <div className="flex justify-center gap-4 text-[9px] text-violet-300/70 mt-0.5">
          <span>▏ put wall {putWall != null ? fmt(putWall) : "—"} (support)</span>
          <span>▏ call wall {callWall != null ? fmt(callWall) : "—"} (resistance)</span>
        </div>
      )}
    </Card>
  );
}

function StatsCard({ result }: { result: ReturnType<typeof analyzePosition> }) {
  const { netCredit, maxProfit, maxLoss, pop, expectedPnl, netDelta, netTheta, breakevens } = result;
  const rr = maxLoss != null && maxProfit != null && maxProfit > 0 ? Math.abs(maxLoss) / maxProfit : null;
  return (
    <Card title="The numbers">
      <div className="grid grid-cols-3 gap-2">
        <Stat label={netCredit >= 0 ? "Net credit" : "Net debit"} value={rupee(Math.abs(netCredit))} tone={netCredit >= 0 ? "up" : "down"} />
        <Stat label="Prob. of profit" value={pop != null ? `${Math.round(pop * 100)}%` : "—"} tone={pop != null ? (pop >= 0.6 ? "up" : pop <= 0.4 ? "down" : null) : null} />
        <Stat label="Expected P&L" value={expectedPnl != null ? rupee(expectedPnl) : "—"} tone={expectedPnl != null ? (expectedPnl >= 0 ? "up" : "down") : null} sub="prob-weighted" />
        <Stat label="Max profit" value={rupee(maxProfit)} tone="up" />
        <Stat label="Max loss" value={rupee(maxLoss)} tone="down" />
        <Stat label="Risk : reward" value={rr != null ? `${rr.toFixed(1)} : 1` : "—"} />
        <Stat label="Net delta" value={fmt(netDelta)} sub={netDelta > 0 ? "long-biased" : netDelta < 0 ? "short-biased" : "neutral"} />
        <Stat label="Net theta" value={`${netTheta >= 0 ? "+" : ""}${rupee(netTheta)}/day`} tone={netTheta >= 0 ? "up" : "down"} sub="time decay" />
        <Stat label="Breakevens" value={breakevens.length ? breakevens.map((b) => fmt(b)).join(" / ") : "—"} />
      </div>
    </Card>
  );
}

function FitCard({ result }: { result: ReturnType<typeof analyzePosition> }) {
  const a = result.assessment;
  const tone = a.grade === "Good fit" ? "text-emerald-400" : a.grade === "Poor fit" ? "text-rose-400" : "text-amber-300";
  return (
    <Card title="Does this trade fit the market?">
      <div className="flex items-center justify-between">
        <span className={`text-lg font-bold ${tone}`}>{a.grade}</span>
        <div className="flex items-center gap-2">
          <Badge tone={a.bias === "bullish" ? "up" : a.bias === "bearish" ? "down" : "neutral"}>{a.bias}</Badge>
          <span className="text-[11px] text-white/50 tnum">{a.score}/100</span>
        </div>
      </div>
      <div className="relative h-2 rounded-full mt-2 bg-gradient-to-r from-rose-500/60 via-amber-400/40 to-emerald-500/60">
        <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow -translate-x-1/2" style={{ left: `${a.score}%` }} />
      </div>

      {a.pros.length > 0 && (
        <div className="mt-3">
          <div className="text-[9px] uppercase tracking-wider text-emerald-300/70 mb-1">What works for it</div>
          {a.pros.map((p, i) => <Line key={i} icon="＋" color="text-emerald-300/90" text={p} />)}
        </div>
      )}
      {a.cons.length > 0 && (
        <div className="mt-2">
          <div className="text-[9px] uppercase tracking-wider text-rose-300/70 mb-1">What works against it</div>
          {a.cons.map((c, i) => <Line key={i} icon="－" color="text-rose-300/90" text={c} />)}
        </div>
      )}
      {a.suggestions.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/[0.06]">
          <div className="text-[9px] uppercase tracking-wider text-sky-300/70 mb-1">Ideas</div>
          {a.suggestions.map((s, i) => <Line key={i} icon="→" color="text-sky-300/90" text={s} />)}
        </div>
      )}
      <div className="text-[9px] text-white/25 mt-2">
        A hand-set rule engine, not backtested advice. Probability uses the market's own IV; real fills, slippage and gap risk aren't modelled.
      </div>
    </Card>
  );
}

function Line({ icon, color, text }: { icon: string; color: string; text: string }) {
  return (
    <div className="flex gap-1.5 text-[11px] leading-relaxed text-white/75 mb-0.5">
      <span className={`${color} shrink-0`}>{icon}</span>
      <span>{text}</span>
    </div>
  );
}
