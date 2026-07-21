import type { Structure, ExpiryBlock } from "../lib/types";
import { fmt, fmtPct } from "../lib/format";
import { Card } from "./ui";

/**
 * Market structure (price × futures OI): long/short buildup, short covering,
 * long unwinding — with the why and how a seller trades it. Also carries the
 * demoted pinning read (max pain + GEX regime as a secondary line).
 */
export function MarketStructureCard({ structure, exp }: { structure: Structure | null; exp: ExpiryBlock }) {
  const m = exp.metrics;
  const pinning = pinningLine(m.maxPain, m.gex);

  if (!structure) {
    return (
      <Card title="Market structure">
        <div className="text-xs text-white/45">Structure unavailable — no futures OI history for this index right now.</div>
        {pinning && <div className="text-[11px] text-white/50 mt-2">{pinning}</div>}
      </Card>
    );
  }

  const tone =
    structure.bias === "bullish" ? "text-emerald-400" :
    structure.bias === "bearish" ? "text-rose-400" : "text-sky-300";
  const dim = structure.strength === "weak" ? "opacity-80" : "";
  const p = structure.priceChgPct * 100;
  const o = structure.oiChgPct * 100;

  return (
    <Card title="Market structure">
      <div className="flex items-baseline justify-between">
        <div className={`text-lg font-bold ${tone} ${dim}`}>{structure.label}</div>
        <div className="text-[10px] uppercase tracking-wide text-white/40">
          {structure.strength === "strong" ? "conviction" : "low conviction"}
        </div>
      </div>

      <div className="flex gap-4 mt-1 text-[11px] tnum">
        <span className="text-white/50">
          Price <span className={p >= 0 ? "text-emerald-400" : "text-rose-400"}>{p >= 0 ? "▲" : "▼"} {fmtPct(p, 2, false)}</span>
        </span>
        <span className="text-white/50">
          Futures OI <span className={o >= 0 ? "text-emerald-300" : "text-rose-300"}>{o >= 0 ? "▲" : "▼"} {fmtPct(o, 1, false)}</span>
        </span>
      </div>

      <p className="text-[11px] text-white/60 mt-2 leading-relaxed">{structure.why}</p>
      <div className="mt-2 rounded-lg bg-white/[0.04] border border-white/[0.06] px-2.5 py-1.5 text-[11px] text-white/80">
        <span className="text-white/40 uppercase text-[9px] tracking-wide mr-1">Seller</span>
        {structure.howToTrade}
      </div>

      {pinning && (
        <div className="text-[10px] text-white/45 mt-2 pt-2 border-t border-white/[0.06]">{pinning}</div>
      )}
    </Card>
  );
}

function pinningLine(maxPain: number | null, gex: ExpiryBlock["metrics"]["gex"]): string | null {
  if (maxPain == null && !gex) return null;
  const parts: string[] = [];
  if (maxPain != null) parts.push(`max pain ${fmt(maxPain)}`);
  if (gex) {
    const regime =
      gex.regime === "pinning" ? "dealer gamma pins toward big strikes" :
      gex.regime === "volatile" ? "short gamma — moves can run" : "gamma balanced";
    parts.push(`${regime}${gex.pinStrike != null ? ` (pin ${fmt(gex.pinStrike)})` : ""}`);
  }
  return `Pinning: ${parts.join(" · ")}`;
}
