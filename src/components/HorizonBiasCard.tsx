import type { Snapshot, Verdict } from "../lib/types";
import { resolveHorizons } from "../lib/horizons";
import { C, blend } from "../lib/palette";
import { Card, Badge } from "./ui";

// Direction is a diverging polarity: bearish ← neutral → bullish. The dial arc
// is a fixed scale (rose → muted → emerald); the *value* is carried by the
// needle position, the numeric score AND the text label — never colour alone,
// so it survives colour-blind / greyscale reading.
// The blend is done in CSS rather than JS arithmetic so the arc re-derives
// itself from the live theme's accent ramp.
const tickColor = (f: number) =>
  f < 0.5 ? blend(C.bearDeep, C.mid, f / 0.5) : blend(C.mid, C.bull, (f - 0.5) / 0.5);
const verdictTone = (v: string) =>
  v === "BULLISH" ? "text-emerald-400" : v === "BEARISH" ? "text-rose-400" : v === "NEUTRAL" ? "text-sky-300" : "text-white/40";
const needleColor = (v: string) =>
  v === "BULLISH" ? C.bull : v === "BEARISH" ? C.bearDeep : C.info;

const CX = 50, CY = 48, R = 38;
const polar = (deg: number, r: number) => {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY - r * Math.sin(rad)];
};
const scoreAngle = (s: number) => (1 - (Math.max(-10, Math.min(10, s)) + 10) / 20) * 180;

function Gauge({ v, active, onClick, label, dte }: { v: Verdict; active: boolean; onClick: () => void; label: string; dte: number }) {
  const ticks = Array.from({ length: 19 }, (_, i) => i / 18);
  const theta = scoreAngle(v.score);
  const [nx, ny] = polar(theta, R - 9);
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center rounded-xl p-1.5 border transition-colors ${
        active ? "border-white/30 bg-white/[0.05]" : "border-transparent"
      }`}
    >
      <svg viewBox="0 0 100 56" className="w-full">
        {ticks.map((f, i) => {
          const [x1, y1] = polar((1 - f) * 180, R - 5);
          const [x2, y2] = polar((1 - f) * 180, R);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} style={{ stroke: tickColor(f) }} strokeWidth="2.4" strokeLinecap="round" />;
        })}
        <line x1={CX} y1={CY} x2={nx} y2={ny} style={{ stroke: needleColor(v.verdict) }} strokeWidth="2.2" strokeLinecap="round" />
        <circle cx={CX} cy={CY} r="3" style={{ fill: needleColor(v.verdict) }} />
      </svg>
      <div className={`-mt-1.5 text-base font-bold tnum ${verdictTone(v.verdict)}`}>
        {v.score > 0 ? "+" : ""}{v.score}
      </div>
      <div className={`text-[9px] font-semibold tracking-wide ${verdictTone(v.verdict)}`}>{v.verdict}</div>
      <div className="text-[10px] font-semibold text-white/70 mt-0.5">{label}<span className="text-white/50"> · {dte}d</span></div>
      <div className="text-[8.5px] text-white/50">conf {Math.round(v.confidence * 100)}%</div>
    </button>
  );
}

/** Direction bias across the 1W / 1M / 2M horizons — one dial each, tap to load
 *  that horizon into the rest of the tab. */
export function HorizonBiasCard({
  snap,
  selected,
  onSelect,
}: {
  snap: Snapshot;
  selected: string;
  onSelect: (date: string) => void;
}) {
  const horizons = Object.entries(resolveHorizons(snap));
  if (horizons.length < 2) return null;
  const vOf = (date: string): Verdict => snap.expiries[date]?.verdict ?? snap.verdict;

  const verdicts = horizons.map(([, h]) => vOf(h.date));
  const bull = verdicts.filter((v) => v.verdict === "BULLISH").length;
  const bear = verdicts.filter((v) => v.verdict === "BEARISH").length;
  const n = verdicts.length;
  const regime =
    bull === 0 && bear === 0 ? "Chop / range" :
    bull > 0 && bear > 0 ? "Mixed / two-sided" :
    bull === n ? "Trending up" : bear === n ? "Trending down" :
    bull > bear ? "Leaning bullish" : "Leaning bearish";
  const regimeTone = bull > bear ? "up" : bear > bull ? "down" : "neutral";

  const activeV = vOf(selected);

  return (
    <Card title="Direction across horizons" right={<Badge tone={regimeTone}>{regime}</Badge>}>
      <div className="grid grid-cols-3 gap-1">
        {horizons.map(([key, h]) => (
          <Gauge key={key} v={vOf(h.date)} active={h.date === selected} onClick={() => onSelect(h.date)} label={key + (h.fallback ? "*" : "")} dte={h.dte} />
        ))}
      </div>
      <div className="mt-2 pt-2 border-t border-white/[0.06] flex items-baseline justify-between gap-2">
        <div className="text-[12px]">
          <span className="text-white/45">Play</span> <span className="font-semibold text-white/90">{activeV.structure}</span>
        </div>
        <span className="text-[9px] text-white/50 shrink-0">needle ◀ bearish · bullish ▶</span>
      </div>
      <div className="text-[9px] text-white/45 mt-1">
        Tap a dial to load that horizon below. Shared trend/VIX core; each horizon shifts with its own positioning.
      </div>
    </Card>
  );
}
