import { useMemo, useState } from "preact/hooks";
import { useStockScreener } from "../state/store";
import type {
  StockRow,
  LiquidityBucket,
  StockCandidate,
  CandidateExpiry,
  ConvictionBand,
} from "../lib/types";
import { fmt, fmtPct, fmtExpiry, timeAgo } from "../lib/format";
import { Card, Badge } from "./ui";
import { ThemeToggle } from "./ThemeToggle";

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

const BAND_TONE: Record<ConvictionBand, string> = {
  HIGH: "text-emerald-300 border-emerald-400/40 bg-emerald-400/10",
  MEDIUM: "text-sky-300 border-sky-400/35 bg-sky-400/10",
  LOW: "text-white/45 border-white/15 bg-white/[0.04]",
};

// "conviction" used to mean |direction score| — the strength of the directional
// read. It now means the sell-conviction the builder computes; "signal" keeps the
// old meaning so nothing was lost from the list.
type SortField = "conviction" | "liquidity" | "change" | "verdict" | "signal" | "price" | "name";
const SORT_FIELDS: SortField[] = ["conviction", "liquidity", "change", "verdict", "signal", "price", "name"];
const SORT_LABELS: Record<SortField, string> = {
  conviction: "Sell conviction",
  liquidity: "Liquidity",
  change: "Day %",
  verdict: "Direction",
  signal: "Signal strength",
  price: "Price",
  name: "Name",
};
const sortVal = (r: StockRow, f: SortField): number =>
  f === "liquidity" ? r.liquidity.score
    : f === "change" ? r.changePct ?? 0
    : f === "verdict" ? r.verdict.score
    : f === "signal" ? Math.abs(r.verdict.score)
    : f === "conviction" ? r.conviction ?? -1
    : f === "price" ? r.spot
    : 0;

/** Stocks landing: search, the liquidity + market-structure list, and the
 *  cross-universe top premium-selling candidates. Tapping a row opens the stock. */
export function StockScreenerView({ onOpen, onBack }: { onOpen: (file: string, name: string) => void; onBack: () => void }) {
  const { screener, candidates, loading, error, hardRefresh, refreshing, refreshError } = useStockScreener();
  const [q, setQ] = useState("");
  const [field, setField] = useState<SortField>("conviction");
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const [slot, setSlot] = useState<"current" | "next">("current");

  // Older published candidates.json has only the flat list — wrap it so the UI
  // has one shape to render either way.
  const expiryBlocks: CandidateExpiry[] = useMemo(() => {
    if (candidates?.expiries?.length) return candidates.expiries;
    if (candidates?.candidates?.length) {
      const list = candidates.candidates;
      return [{
        slot: "current", label: "Current expiry",
        date: list[0]?.expiry ?? null, dte: list[0]?.dte ?? null,
        liquidNames: 0, candidateCount: list.length, thin: false, candidates: list,
      }];
    }
    return [];
  }, [candidates]);
  const active = expiryBlocks.find((b) => b.slot === slot) ?? expiryBlocks[0] ?? null;
  // Switching field resets to its most-useful default direction (A→Z for names,
  // highest-first for everything else); the toggle then flips it either way.
  const onField = (f: SortField) => {
    setField(f);
    setDir(f === "name" ? "asc" : "desc");
  };

  const rows = useMemo(() => {
    const list = screener?.stocks ?? [];
    const needle = q.trim().toUpperCase();
    const filtered = needle
      ? list.filter((r) => r.symbol.includes(needle) || r.name.toUpperCase().includes(needle))
      : list;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (field === "name") {
        const c = a.symbol.localeCompare(b.symbol);
        return dir === "asc" ? c : -c;
      }
      const d = sortVal(a, field) - sortVal(b, field);
      return dir === "desc" ? -d : d;
    });
    return sorted;
  }, [screener, q, field, dir]);

  const dirLabel = field === "name" ? (dir === "asc" ? "A → Z" : "Z → A") : dir === "desc" ? "High → Low" : "Low → High";

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
            onClick={hardRefresh}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-white/15 text-white/70 active:bg-white/[0.08] disabled:opacity-50"
            disabled={loading || refreshing}
            aria-label="Refresh screener"
          >
            <span className={loading || refreshing ? "animate-spin" : ""}>⟳</span>
            {refreshing ? "Rebuilding…" : loading ? "…" : "Refresh"}
          </button>
          <ThemeToggle />
        </div>
      </header>
      {refreshing && (
        <div className="px-4 pb-1 text-[10px] text-sky-300/70">Rebuilding the whole universe — this takes ~1–2 min…</div>
      )}
      {refreshError && !refreshing && <div className="px-4 pb-1 text-[10px] text-amber-300/70">{refreshError}</div>}

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

        {active ? (
          <Card
            title="Top premium-selling candidates"
            right={<span className="text-[9px] text-white/40">ranked by conviction</span>}
          >
            {expiryBlocks.length > 1 && (
              <div className="flex gap-1 mb-2">
                {expiryBlocks.map((b) => (
                  <button
                    key={b.slot}
                    onClick={() => setSlot(b.slot)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-left ${
                      b.slot === active.slot
                        ? "border-white/25 bg-white/[0.08]"
                        : "border-white/10 bg-white/[0.02] opacity-60"
                    }`}
                  >
                    <div className="text-[10px] font-semibold text-white/85">{b.label}</div>
                    <div className="text-[9px] text-white/40 tnum">
                      {fmtExpiry(b.date)} · {b.dte ?? "—"}d · {b.candidates.length} ideas
                    </div>
                  </button>
                ))}
              </div>
            )}

            {active.thin && (
              <div className="mb-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-200/80">
                Thin expiry — only {active.candidates.length} strike
                {active.candidates.length === 1 ? "" : "s"} across {active.liquidNames} name
                {active.liquidNames === 1 ? "" : "s"} cleared the liquidity floor for this expiry.
                Far-month NSE single-stock options are genuinely illiquid; expect wide spreads and
                check the book before working an order.
              </div>
            )}

            <div className="text-[9px] text-white/30 mb-1.5">
              score · name · side · strike · P(keep) · edge · credit/lot — tap a row for the breakdown
            </div>
            <div className="space-y-1">
              {active.candidates.slice(0, 12).map((c) => (
                <CandidateRow key={`${c.symbol}-${c.type}-${c.strike}`} c={c} onOpen={onOpen} />
              ))}
              {!active.candidates.length && (
                <div className="text-[11px] text-white/40 py-3 text-center">
                  No candidate cleared the liquidity floor for this expiry.
                </div>
              )}
            </div>
          </Card>
        ) : null}

        {screener && (
          <Card
            title="Liquidity & structure"
            right={
              <div className="flex items-center gap-1">
                <span className="text-[9px] text-white/35">sort</span>
                <select
                  value={field}
                  onChange={(e) => onField((e.target as HTMLSelectElement).value as SortField)}
                  className="text-[10px] bg-white/[0.06] border border-white/15 rounded px-1 py-0.5 text-white/85"
                >
                  {SORT_FIELDS.map((f) => (
                    <option key={f} value={f}>{SORT_LABELS[f]}</option>
                  ))}
                </select>
                <button
                  onClick={() => setDir((d) => (d === "desc" ? "asc" : "desc"))}
                  className="text-[9px] px-1.5 py-0.5 rounded-full border border-white/20 text-white/70 whitespace-nowrap tnum"
                  aria-label="Toggle sort direction"
                >
                  {dirLabel}
                </button>
              </div>
            }
          >
            <div className="space-y-0.5">
              {rows.map((r) => (
                <StockRowItem key={r.symbol} r={r} field={field} onOpen={onOpen} />
              ))}
              {!rows.length && <div className="text-[11px] text-white/40 py-3 text-center">No match.</div>}
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}

function StockRowItem({ r, field, onOpen }: { r: StockRow; field: SortField; onOpen: (file: string, name: string) => void }) {
  const chgNeg = r.changePct != null && r.changePct < 0;
  // The field being sorted is made prominent; the rest recede, so the ordering
  // reads correctly (e.g. sorting by conviction pops the verdict score, not the
  // liquidity badge).
  const liqActive = field === "liquidity";
  const verdictActive = field === "verdict" || field === "signal";
  const changeActive = field === "change";
  const priceActive = field === "price";
  const convActive = field === "conviction";
  const band = r.topCandidate?.band ?? null;
  return (
    <button
      onClick={() => onOpen(r.file, r.name)}
      className="w-full flex items-center gap-2 py-1.5 px-1 rounded-lg active:bg-white/[0.05] text-left"
    >
      {r.conviction != null && (
        <span
          className={`shrink-0 w-8 text-center tnum border rounded px-1 py-0.5 ${
            band ? BAND_TONE[band] : "text-white/45 border-white/15"
          } ${convActive ? "text-[11px] font-bold ring-1 ring-white/40" : "text-[9px] opacity-55"}`}
        >
          {r.conviction}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[13px] font-semibold text-white/90 truncate">{r.symbol}</span>
          <span className={`tnum ${chgNeg ? "text-rose-400" : "text-emerald-400"} ${changeActive ? "text-[13px] font-bold" : "text-[11px]"}`}>
            {fmtPct(r.changePct, 1)}
          </span>
          {priceActive && <span className="text-[12px] font-bold tnum text-white/85">₹{fmt(r.spot)}</span>}
          {convActive && r.vrp != null && <span className="text-[10px] tnum text-white/50">IV/RV {r.vrp}×</span>}
        </div>
        <div className="text-[10px] text-white/40 truncate">{r.name}</div>
      </div>
      <span
        className={`shrink-0 text-[9px] uppercase tracking-wide border rounded px-1 py-0.5 ${LIQ_TONE[r.liquidity.bucket]} ${
          liqActive ? "ring-1 ring-white/40" : "opacity-55"
        }`}
      >
        {r.liquidity.bucket}
      </span>
      <div className="shrink-0 w-[96px] text-right">
        <div className={verdictActive ? "opacity-55" : ""}>
          {r.structure && r.structure.label !== "Indecisive" ? (
            <Badge tone={biasTone(r.structure.bias)}>{r.structure.label}</Badge>
          ) : (
            <span className="text-[9px] text-white/30">indecisive</span>
          )}
        </div>
        <div className={`mt-0.5 tnum ${verdictTone(r.verdict.verdict)} ${verdictActive ? "text-[12px] font-bold" : "text-[9px]"}`}>
          {r.verdict.verdict} {r.verdict.score > 0 ? "+" : ""}{r.verdict.score}
        </div>
      </div>
    </button>
  );
}

function CandidateRow({ c, onOpen }: { c: StockCandidate; onOpen: (file: string, name: string) => void }) {
  const [open, setOpen] = useState(false);
  const band = c.band ?? null;
  // Real-world P(expire OTM) when the builder computed one; otherwise the old
  // risk-neutral 1−|delta|, so pre-upgrade files still render something honest.
  const pKeep = c.pProfit ?? c.probProfit;
  const cushion = c.cushionSigmaF ?? c.cushionSigma;
  const factors = (c.factors ?? []).filter((f) => f.present);

  return (
    <div className={open ? "rounded-lg bg-white/[0.03] border border-white/[0.07]" : ""}>
      <div className="flex items-center gap-1.5 py-1 px-1 text-[11px]">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center gap-1.5 text-left min-w-0 active:opacity-70"
          aria-label={`Why ${c.symbol} ${c.type} ${c.strike}`}
        >
          {band && (
            <span className={`shrink-0 w-8 text-center text-[10px] font-bold tnum border rounded px-0.5 py-0.5 ${BAND_TONE[band]}`}>
              {c.conviction}
            </span>
          )}
          <span className="w-[62px] shrink-0 font-semibold text-white/90 truncate">{c.symbol}</span>
          <span className={`shrink-0 tnum ${c.type === "PE" ? "text-emerald-300/90" : "text-rose-300/90"}`}>
            {c.type}
          </span>
          <span className="w-11 shrink-0 tnum text-white/80">{fmt(c.strike)}</span>
          <span className="flex-1 min-w-0 tnum text-white/45 text-right truncate">
            {Math.round(pKeep * 100)}%
            {c.edgePct != null ? ` · ${fmtPct(c.edgePct * 100, 1)}` : cushion != null ? ` · ${cushion.toFixed(1)}σ` : ""}
            {c.deliveryRisk ? " ⚠" : ""}
          </span>
        </button>
        <button
          onClick={() => onOpen(c.file, c.name)}
          className="w-[56px] shrink-0 tnum text-white/70 text-right truncate active:opacity-70"
          aria-label={`Open ${c.symbol}`}
        >
          ₹{fmt(c.creditPerLot)}
        </button>
      </div>

      {open && (
        <div className="px-2.5 pb-2 space-y-1.5">
          <div className="text-[9px] text-white/35 leading-relaxed">
            {c.name} · {fmtExpiry(c.expiry)} ({c.dte}d) · IV {c.iv != null ? `${(c.iv * 100).toFixed(1)}%` : "—"}
            {c.vrp != null ? ` · IV/RV ${c.vrp}×` : ""}
            {c.ivRank != null ? ` · IVR ${c.ivRank}` : ""}
            {c.fair != null ? ` · fair ₹${c.fair} vs ₹${c.ltp}` : ""}
          </div>

          {factors.length > 0 && (
            <div className="space-y-1">
              {factors.map((f) => (
                <div key={f.key}>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-white/70">{f.label}</span>
                    <span className="text-white/40 tnum truncate ml-2">{f.reading}</span>
                  </div>
                  <div className="relative h-1.5 mt-0.5 rounded-full bg-white/[0.06]">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-sky-400/70"
                      style={{ width: `${Math.round((f.s ?? 0) * 100)}%` }}
                    />
                    {/* weight tick: how much this factor is worth in the blend */}
                    <div className="absolute -bottom-px h-2 w-px bg-white/25" style={{ left: `${Math.round(f.weight * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {(c.cvar != null || c.tailReliance != null) && (
            <div className="flex items-center justify-between text-[9px] text-white/40 tnum">
              <span>
                {c.cvar != null ? `worst 5%: ₹${c.cvar.toFixed(1)}/sh` : ""}
                {c.worst != null ? ` · worst case ₹${c.worst.toFixed(0)}/sh` : ""}
              </span>
              {c.tailReliance != null && (
                <span className={c.tailReliance > 0.7 ? "text-amber-300/70" : ""}>
                  {Math.round(c.tailReliance * 100)}% tail-priced
                </span>
              )}
            </div>
          )}

          {c.notes?.length ? (
            <div className="text-[9px] text-amber-200/70 leading-relaxed">⚠ {c.notes.join(" · ")}</div>
          ) : null}

          {c.deliveryRisk && (
            <div className="text-[9px] text-amber-200/70 leading-relaxed">
              Physical settlement: an ITM short is assigned into delivery and margin steps up to
              ~40% of contract value in the days before expiry.
            </div>
          )}

          <div className="flex items-center justify-between pt-0.5">
            <span className="text-[9px] text-white/30 tnum">
              OI-adj · risk-neutral {Math.round(c.probProfit * 100)}% vs forecast {Math.round(pKeep * 100)}%
              {c.probTouchF != null ? ` · touch ${Math.round(c.probTouchF * 100)}%` : ""}
            </span>
            <button
              onClick={() => onOpen(c.file, c.name)}
              className="text-[9px] px-2 py-0.5 rounded-full border border-white/20 text-white/70 active:bg-white/[0.08]"
            >
              Open {c.symbol} →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
