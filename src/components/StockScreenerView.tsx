import { useMemo, useState } from "preact/hooks";
import { useStockScreener } from "../state/store";
import type { StockRow, LiquidityBucket, StockCandidate } from "../lib/types";
import { fmt, fmtPct, timeAgo } from "../lib/format";
import { Card, Badge } from "./ui";

const LIQ_TONE: Record<LiquidityBucket, string> = {
  High: "text-emerald-300 border-emerald-400/40 bg-emerald-400/10",
  "Medium-High": "text-teal-300 border-teal-400/35 bg-teal-400/10",
  Medium: "text-sky-300 border-sky-400/35 bg-sky-400/10",
  "Medium-Low": "text-amber-300 border-amber-400/35 bg-amber-400/10",
  Low: "text-orange-300 border-orange-400/35 bg-orange-400/10",
  None: "text-white/40 border-white/15 bg-white/[0.04]",
};
const biasTone = (bias?: string) => (bias === "bullish" ? "up" : bias === "bearish" ? "down" : "neutral");
const verdictTone = (v: string) => (v === "BULLISH" ? "text-emerald-400" : v === "BEARISH" ? "text-rose-400" : "text-sky-300");

type Sort = "liquidity" | "conviction" | "name";

/** Stocks landing: search, the liquidity + market-structure list, and the
 *  cross-universe top premium-selling candidates. Tapping a row opens the stock. */
export function StockScreenerView({ onOpen, onBack }: { onOpen: (file: string, name: string) => void; onBack: () => void }) {
  const { screener, candidates, loading, error, refresh } = useStockScreener();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("liquidity");

  const rows = useMemo(() => {
    const list = screener?.stocks ?? [];
    const needle = q.trim().toUpperCase();
    const filtered = needle
      ? list.filter((r) => r.symbol.includes(needle) || r.name.toUpperCase().includes(needle))
      : list;
    const sorted = [...filtered];
    if (sort === "name") sorted.sort((a, b) => a.symbol.localeCompare(b.symbol));
    else if (sort === "conviction") sorted.sort((a, b) => Math.abs(b.verdict.score) - Math.abs(a.verdict.score));
    else sorted.sort((a, b) => b.liquidity.score - a.liquidity.score);
    return sorted;
  }, [screener, q, sort]);

  return (
    <div className="flex flex-col min-h-[100dvh]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <button onClick={onBack} className="flex items-center gap-1.5 active:opacity-70">
          <span className="text-white/40 text-sm">←</span>
          <span className="text-base font-semibold">Stocks</span>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-white/30 tnum">
            {screener ? `${screener.count} names · ${timeAgo(screener.asOf)}` : ""}
          </span>
          <button
            onClick={refresh}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-white/15 text-white/70 active:bg-white/[0.08] disabled:opacity-50"
            disabled={loading}
            aria-label="Refresh screener"
          >
            <span className={loading ? "animate-spin" : ""}>⟳</span>
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </header>

      <main className="flex-1 px-3 space-y-3 pb-6">
        <input
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder="Search stock by name or ticker…"
          className="w-full px-3 py-2.5 rounded-xl bg-white/[0.05] border border-white/10 text-sm text-white/90 placeholder:text-white/30"
        />

        {loading && !screener && <div className="text-center text-white/40 py-16">Loading stock universe…</div>}
        {error && !screener && (
          <div className="text-center text-white/40 py-16 text-sm">
            Stock data not available yet.
            <div className="text-[10px] mt-2 text-white/25">The screener populates after the first stock data run.</div>
          </div>
        )}

        {candidates?.candidates?.length ? (
          <Card title="Top premium-selling candidates" right={<span className="text-[9px] text-white/40">liquid names</span>}>
            <div className="space-y-1">
              {candidates.candidates.slice(0, 10).map((c) => (
                <CandidateRow key={`${c.symbol}-${c.type}-${c.strike}`} c={c} onOpen={onOpen} />
              ))}
            </div>
          </Card>
        ) : null}

        {screener && (
          <Card
            title="Liquidity & structure"
            right={
              <div className="flex gap-1">
                {(["liquidity", "conviction", "name"] as Sort[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setSort(s)}
                    className={`text-[9px] px-1.5 py-0.5 rounded-full border ${sort === s ? "border-white/40 text-white/90" : "border-white/12 text-white/45"}`}
                  >
                    {s === "conviction" ? "conviction" : s}
                  </button>
                ))}
              </div>
            }
          >
            <div className="space-y-0.5">
              {rows.map((r) => (
                <StockRowItem key={r.symbol} r={r} onOpen={onOpen} />
              ))}
              {!rows.length && <div className="text-[11px] text-white/40 py-3 text-center">No match.</div>}
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}

function StockRowItem({ r, onOpen }: { r: StockRow; onOpen: (file: string, name: string) => void }) {
  return (
    <button
      onClick={() => onOpen(r.file, r.name)}
      className="w-full flex items-center gap-2 py-1.5 px-1 rounded-lg active:bg-white/[0.05] text-left"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold text-white/90 truncate">{r.symbol}</span>
          <span className={`text-[11px] tnum ${r.changePct != null && r.changePct < 0 ? "text-rose-400" : "text-emerald-400"}`}>
            {fmtPct(r.changePct, 1)}
          </span>
        </div>
        <div className="text-[10px] text-white/40 truncate">{r.name}</div>
      </div>
      <span className={`shrink-0 text-[9px] uppercase tracking-wide border rounded px-1 py-0.5 ${LIQ_TONE[r.liquidity.bucket]}`}>
        {r.liquidity.bucket}
      </span>
      <div className="shrink-0 w-[92px] text-right">
        {r.structure && r.structure.label !== "Indecisive" ? (
          <Badge tone={biasTone(r.structure.bias)}>{r.structure.label}</Badge>
        ) : (
          <span className="text-[9px] text-white/30">indecisive</span>
        )}
        <div className={`text-[9px] mt-0.5 ${verdictTone(r.verdict.verdict)}`}>
          {r.verdict.verdict} {r.verdict.score > 0 ? "+" : ""}{r.verdict.score}
        </div>
      </div>
    </button>
  );
}

function CandidateRow({ c, onOpen }: { c: StockCandidate; onOpen: (file: string, name: string) => void }) {
  return (
    <button
      onClick={() => onOpen(c.file, c.name)}
      className="w-full flex items-center gap-2 py-1 text-[11px] active:bg-white/[0.05] rounded-lg px-1 text-left"
    >
      <span className="w-20 shrink-0 font-semibold text-white/90 truncate">{c.symbol}</span>
      <span className={`w-16 shrink-0 tnum ${c.type === "PE" ? "text-emerald-300/90" : "text-rose-300/90"}`}>
        {c.type === "PE" ? "Sell PE" : "Sell CE"}
      </span>
      <span className="w-14 shrink-0 tnum text-white/80">{fmt(c.strike)}</span>
      <span className="flex-1 tnum text-white/50 text-right">
        {Math.round(c.probProfit * 100)}% OTM · {c.cushionSigma != null ? `${c.cushionSigma.toFixed(1)}σ` : "—"}
      </span>
      <span className="w-16 shrink-0 tnum text-white/70 text-right">₹{fmt(c.creditPerLot)}</span>
    </button>
  );
}
