import type { Verdict } from "../lib/types";
import { Card } from "./ui";

/** Direction verdict: score gauge (-10..+10), confidence, structure to sell. */
export function VerdictCard({ v, dte }: { v: Verdict; dte: number }) {
  const pct = ((v.score + 10) / 20) * 100;
  const tone =
    v.verdict === "BULLISH" ? "text-emerald-400" :
    v.verdict === "BEARISH" ? "text-rose-400" :
    v.verdict === "NEUTRAL" ? "text-sky-300" : "text-white/40";
  return (
    <Card title="Direction verdict">
      <div className="flex items-center justify-between">
        <div>
          <div className={`text-xl font-bold ${tone}`}>{v.verdict}</div>
          <div className="text-[11px] text-white/50 tnum">
            score {v.score > 0 ? "+" : ""}{v.score} · confidence {Math.round(v.confidence * 100)}%
          </div>
        </div>
        <div className="text-right text-xs text-white/80 max-w-[55%]">{v.structure}</div>
      </div>

      {/* score gauge */}
      <div className="relative h-2 rounded-full mt-3 bg-gradient-to-r from-rose-500/60 via-white/15 to-emerald-500/60">
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow -translate-x-1/2"
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-white/30 mt-1">
        <span>bearish −10</span>
        <span>0</span>
        <span>+10 bullish</span>
      </div>

      {dte <= 1 && v.verdict !== "NO DATA" && (
        <div className="mt-2 text-[10px] text-amber-300/80">
          ⚠ Expiry {dte === 0 ? "today" : "tomorrow"} — gamma risk is extreme; size down or sit out.
        </div>
      )}
      <div className="mt-2 text-[9px] text-white/25">
        Hand-set priors, not backtested — trust the band + confidence, not the decimal.
      </div>
    </Card>
  );
}
