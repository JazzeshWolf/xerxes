import { useMemo, useState } from "preact/hooks";
import { decileGroups, leanTone, type RankerIndex, type RankerRow, type SkillState } from "../../lib/ranker";
import { fmt, fmtPct } from "../../lib/format";
import { Card, Badge } from "../ui";

// ---------------------------------------------------------------------------
// The decile table — rank, symbol, forecast, percentile, sector, and the
// option-selling implication.
//
// Presentation follows the gate: when the ranking is unvalidated the leans are
// rendered muted and the implication column is prefixed "unproven", so the page
// cannot be read as a set of trade instructions it has not earned the right to
// give. That is a visual rule, not a disclaimer paragraph — a disclaimer at the
// top does nothing once the reader is scanning rows.
// ---------------------------------------------------------------------------

const LEAN_LABEL: Record<string, string> = {
  bullish: "Sell puts",
  bearish: "Sell calls",
  neutral: "—",
};

function LeanCell({ row, actionable }: { row: RankerRow; actionable: boolean }) {
  const tone = leanTone(row.lean);
  if (!tone) return <span className="text-white/30">—</span>;
  const cls = actionable
    ? tone === "up"
      ? "text-emerald-300"
      : "text-rose-300"
    : "text-white/45"; // unvalidated: never render a lean as a live instruction
  return <span className={cls}>{LEAN_LABEL[row.lean]}</span>;
}

export function DecileTable({
  index,
  state,
  onOpen,
}: {
  index: RankerIndex;
  state: SkillState;
  onOpen: (symbol: string) => void;
}) {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "edges">("edges");

  const groups = useMemo(() => decileGroups(index.rows), [index.rows]);
  const needle = q.trim().toUpperCase();

  const visible = useMemo(() => {
    if (needle) {
      return groups
        .map((g) => ({
          ...g,
          rows: g.rows.filter(
            (r) => r.symbol.includes(needle) || r.name.toUpperCase().includes(needle),
          ),
        }))
        .filter((g) => g.rows.length);
    }
    // Default to the two ends of the book: the middle deciles carry no lean and
    // scrolling ~190 rows to reach them helps nobody.
    const EDGE_DECILES = new Set([10, 9, 2, 1]);
    return only === "edges" ? groups.filter((g) => EDGE_DECILES.has(g.decile)) : groups;
  }, [groups, needle, only]);

  return (
    <>
      <input
        value={q}
        onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        placeholder="Search the universe by name or ticker…"
        className="w-full px-3 py-2.5 rounded-xl bg-white/[0.05] border border-white/10 text-sm text-white/90 placeholder:text-white/45"
      />

      {!needle && (
        <div className="flex gap-1">
          {(["edges", "all"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setOnly(m)}
              className={`shrink-0 text-xs px-3 py-1.5 rounded-full border transition-colors ${
                only === m
                  ? "border-white/40 text-white bg-white/[0.07]"
                  : "border-white/10 text-white/50"
              }`}
            >
              {m === "edges" ? "Top & bottom deciles" : `All ${index.rows.length}`}
            </button>
          ))}
        </div>
      )}

      {visible.map((g) => (
        <Card
          key={g.decile}
          title={`Decile ${g.decile}${g.decile === 10 ? " — most bullish" : g.decile === 1 ? " — most bearish" : ""}`}
          right={
            <span className="text-[9px] text-white/40 tnum">
              {g.rows.length} names · mean {fmtPct(g.meanForecast * 100, 1)}
            </span>
          }
        >
          <div className="space-y-0.5">
            <div className="grid grid-cols-[28px_1fr_54px_44px_64px] gap-1.5 text-[9px] uppercase tracking-wide text-white/35 px-1 pb-1">
              <span>#</span>
              <span>Name</span>
              <span className="text-right">Fcst</span>
              <span className="text-right">Pctl</span>
              <span className="text-right">Action</span>
            </div>
            {g.rows.map((r) => (
              <button
                key={r.symbol}
                onClick={() => onOpen(r.symbol)}
                className="w-full grid grid-cols-[28px_1fr_54px_44px_64px] gap-1.5 items-center px-1 py-1.5 rounded-lg text-left active:bg-white/[0.06]"
              >
                <span className="text-[10px] text-white/40 tnum">{r.rank}</span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-white/90 truncate">
                    {r.symbol}
                  </span>
                  <span className="block text-[9px] text-white/40 truncate">{r.sector}</span>
                </span>
                <span
                  className={`text-[11px] text-right tnum ${
                    r.forecastReturn > 0 ? "text-emerald-400/90" : "text-rose-400/90"
                  }`}
                >
                  {fmtPct(r.forecastReturn * 100, 1)}
                </span>
                <span className="text-[10px] text-right text-white/45 tnum">
                  {fmt(r.percentile * 100, 0)}
                </span>
                <span className="text-[10px] text-right">
                  <LeanCell row={r} actionable={state.actionable} />
                </span>
              </button>
            ))}
          </div>
        </Card>
      ))}

      {needle && !visible.length && (
        <div className="text-center text-white/40 py-10 text-sm">
          No name matches “{q}”.
        </div>
      )}

      <div className="text-[10px] text-white/45 leading-relaxed px-1">
        {state.actionable ? (
          <>
            Top decile = lean bullish = prefer selling puts; bottom decile = lean
            bearish = prefer selling calls. The forecast percentage is the
            model's median over {index.horizonLabel} and is shown for context —
            the <em>rank</em> is the product, not the number.
          </>
        ) : (
          <>
            <Badge tone="warn">Unproven</Badge> The lean column is shown for
            inspection only. Measured skill has not cleared the bar, so these
            ranks are not yet a basis for choosing which side to sell.
          </>
        )}
      </div>
    </>
  );
}
