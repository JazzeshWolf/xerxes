import { useEffect, useState } from "preact/hooks";
import { useDashboard } from "./state/store";
import type { IndexKey } from "./lib/types";
import { INDEX_META } from "./lib/types";
import { InstrumentPicker } from "./components/InstrumentPicker";
import { SpotStrip } from "./components/SpotStrip";
import { VerdictCard } from "./components/VerdictCard";
import { MarketStructureCard } from "./components/MarketStructureCard";
import { OiProfile } from "./components/OiProfile";
import { LevelsCard } from "./components/LevelsCard";
import { MetricsCard } from "./components/MetricsCard";
import { SellTable } from "./components/SellTable";
import { FactorsCard } from "./components/FactorsCard";
import { timeAgo } from "./lib/format";

const LS_KEY = "xerxes.instrument";

export function App() {
  const [instrument, setInstrument] = useState<IndexKey | null>(() => {
    const s = localStorage.getItem(LS_KEY) as IndexKey | null;
    return s && INDEX_META[s] ? s : null;
  });

  const pick = (i: IndexKey) => {
    localStorage.setItem(LS_KEY, i);
    setInstrument(i);
  };

  if (!instrument) return <InstrumentPicker onPick={pick} />;
  return <Dashboard instrument={instrument} onSwitch={() => setInstrument(null)} />;
}

function Dashboard({ instrument, onSwitch }: { instrument: IndexKey; onSwitch: () => void }) {
  const dash = useDashboard(instrument);
  const snap = dash.snap;
  const [selectedExpiry, setSelectedExpiry] = useState<string>("");

  // Reset the expiry selection to the default whenever a new snapshot loads.
  useEffect(() => {
    if (snap) setSelectedExpiry(snap.defaultExpiry);
  }, [snap?.defaultExpiry, snap?.index]);

  // Defensive: tolerate an old-format / mid-refresh file that lacks `expiries`.
  const exp = snap?.expiries ? snap.expiries[selectedExpiry] ?? snap.expiries[snap.defaultExpiry] : null;
  const onDefaultHorizon = !snap || !exp || exp.date === snap.defaultExpiry;

  return (
    <div className="flex flex-col min-h-[100dvh]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <button onClick={onSwitch} className="flex items-center gap-1.5 active:opacity-70">
          <span className="text-lg font-bold tracking-tight">⚔️</span>
          <span className="text-base font-semibold">{INDEX_META[instrument].label}</span>
          <span className="text-white/30 text-xs">▾</span>
        </button>
        <button
          onClick={dash.refresh}
          className="text-xs text-white/50 flex items-center gap-1 active:text-white"
          disabled={dash.loading}
        >
          <span className={dash.loading ? "animate-spin" : ""}>⟳</span>
          {dash.loading ? "…" : timeAgo(snap?.asOf ?? null)}
          <span className="text-[8px] text-white/20 ml-1">v{__BUILD_ID__}</span>
        </button>
      </header>

      <main className="flex-1 px-3 space-y-3 pb-4">
        {dash.error && !snap && (
          <div className="text-center text-white/40 py-16 text-sm">
            No data yet for {INDEX_META[instrument].label}.
            <div className="text-[10px] mt-2 text-white/25">{dash.error}</div>
          </div>
        )}
        {!snap && !dash.error && <div className="text-center text-white/40 py-16">Loading market data…</div>}
        {snap && !exp && (
          <div className="text-center text-white/40 py-16 text-sm">
            Refreshing {INDEX_META[instrument].label} data…
            <div className="text-[10px] mt-2 text-white/25">The next data run will populate this shortly.</div>
          </div>
        )}

        {snap && exp && (
          <>
            <SpotStrip snap={snap} selectedExpiry={exp.date} onExpiryChange={setSelectedExpiry} />
            <VerdictCard v={snap.verdict} dte={snap.expiries[snap.defaultExpiry].dte} />
            <MarketStructureCard structure={snap.structure} exp={snap.expiries[snap.defaultExpiry]} />
            {!onDefaultHorizon && (
              <div className="text-[10px] text-amber-300/70 px-1 -mt-1">
                Verdict reflects the nearest expiry ({snap.expiries[snap.defaultExpiry].label}); you're viewing {exp.label} data below.
              </div>
            )}
            <SellTable snap={snap} exp={exp} />
            <OiProfile snap={snap} exp={exp} />
            <LevelsCard snap={snap} exp={exp} />
            <MetricsCard snap={snap} exp={exp} />
            <FactorsCard v={snap.verdict} />
          </>
        )}
      </main>

      <footer className="px-4 pb-5 text-[9px] leading-relaxed text-white/25">
        Decision aid, not advice. Index options carry unlimited risk when sold naked — always define risk.
        Data is delayed (~10 min refresh via GitHub Actions) and may be stale outside market hours.
      </footer>
    </div>
  );
}
