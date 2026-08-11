import { useState } from "preact/hooks";
import { useRanker } from "../../state/rankerStore";
import { skillState } from "../../lib/ranker";
import { timeAgo } from "../../lib/format";
import { ThemeToggle } from "../ThemeToggle";
import { SkillScorecard } from "./SkillScorecard";
import { DecileTable } from "./DecileTable";
import { NameDetail } from "./NameDetail";

// ---------------------------------------------------------------------------
// The Kronos tab: a cross-sectional ranking of the NSE F&O universe.
//
// It is a TOP-LEVEL route rather than a tab inside an instrument dashboard,
// because it is not a view of an instrument. The existing TabBar holds
// per-instrument tabs (Verdict / Chain / Holistic / …) for one symbol at a time;
// a ranking across ~190 names is a sibling of the Stocks screener, not a seventh
// view of NIFTY. Routing it here also means TabBar and every index component
// stay untouched.
//
// Section order is fixed and load-bearing: SKILL FIRST, then ranks, then
// per-name detail. See SkillScorecard for why.
// ---------------------------------------------------------------------------

type Section = "skill" | "ranks";

export function KronosView({ onBack }: { onBack: () => void }) {
  const { index, skill, loading, missing, error, refresh } = useRanker();
  const [section, setSection] = useState<Section>("skill");
  const [openSymbol, setOpenSymbol] = useState<string | null>(null);

  const state = skillState(index);
  const openRow = openSymbol ? index?.rows.find((r) => r.symbol === openSymbol) ?? null : null;

  return (
    <div className="flex flex-col min-h-[100dvh]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <button onClick={onBack} className="flex items-center gap-1.5 active:opacity-70">
          <span className="text-white/40 text-sm">←</span>
          <span className="text-base font-semibold">Kronos</span>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-white/45 tnum">
            {index ? `${index.universeCount} names · ${timeAgo(index.asOf)}` : ""}
          </span>
          <button
            onClick={refresh}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-white/15 text-white/70 active:bg-white/[0.08] disabled:opacity-50"
            disabled={loading}
            aria-label="Refresh ranker"
          >
            <span className={loading ? "animate-spin" : ""}>⟳</span>
            {loading ? "…" : "Refresh"}
          </button>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 px-3 space-y-3 pb-6">
        {loading && !index && (
          <div className="text-center text-white/40 py-16">Loading the ranking…</div>
        )}

        {/* The explicit failure path: absent or malformed data must degrade to an
            empty state, never to a half-rendered ranking. */}
        {!loading && !index && (
          <div className="text-center text-white/40 py-16 text-sm">
            No ranking published yet.
            <div className="text-[10px] mt-2 text-white/45 leading-relaxed max-w-xs mx-auto">
              {error
                ? "The published ranker data could not be read, so nothing is shown rather than a partial table."
                : "The Kronos ranker builds after the NSE close. Once its first run publishes, the decile ranking appears here."}
              {missing && !error && (
                <>
                  {" "}
                  Run the <span className="text-white/60">Kronos NSE F&amp;O ranker</span>{" "}
                  workflow to populate it.
                </>
              )}
            </div>
          </div>
        )}

        {index && openRow && (
          <NameDetail
            row={openRow}
            total={index.universeCount}
            state={state}
            onBack={() => setOpenSymbol(null)}
          />
        )}

        {index && !openRow && (
          <>
            <div className="flex gap-1 py-1">
              {(["skill", "ranks"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSection(s)}
                  className={`shrink-0 text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    section === s
                      ? "border-white/40 text-white bg-white/[0.07]"
                      : "border-white/10 text-white/50"
                  }`}
                >
                  {s === "skill" ? "Skill" : "Ranks"}
                </button>
              ))}
            </div>

            {section === "skill" && (
              <SkillScorecard index={index} skill={skill} state={state} />
            )}
            {section === "ranks" && (
              <DecileTable index={index} state={state} onOpen={setOpenSymbol} />
            )}

            <div className="text-[9px] text-white/40 leading-relaxed px-1">
              {index.engine} · {index.model} · horizon {index.horizonLabel} · trade
              date {index.tradeDate}
            </div>
          </>
        )}
      </main>

      <footer className="px-4 pb-5 text-[9px] leading-relaxed text-white/45">
        Decision aid, not advice. The ranking is the product — no single name's
        forecast is meant to carry a position on its own.
      </footer>
    </div>
  );
}
