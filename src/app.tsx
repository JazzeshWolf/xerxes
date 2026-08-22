import { useEffect, useState } from "preact/hooks";
import { useDashboard, useMarket } from "./state/store";
import type { IndexKey } from "./lib/types";
import { INDEX_META } from "./lib/types";
import { InstrumentPicker } from "./components/InstrumentPicker";
import { StockScreenerView } from "./components/StockScreenerView";
import { StockDashboard } from "./components/StockDashboard";
import { KronosView } from "./components/kronos/KronosView";
import { SpotStrip } from "./components/SpotStrip";
import { VerdictCard } from "./components/VerdictCard";
import { HorizonBiasCard } from "./components/HorizonBiasCard";
import { MarketStructureCard } from "./components/MarketStructureCard";
import { OiProfile } from "./components/OiProfile";
import { LevelsCard } from "./components/LevelsCard";
import { MetricsCard } from "./components/MetricsCard";
import { SellCandidatesCard } from "./components/SellCandidatesCard";
import { VolPremiumCard } from "./components/VolPremiumCard";
import { FactorsCard } from "./components/FactorsCard";
import { HolisticTab } from "./components/HolisticTab";
import { OutlookTab } from "./components/OutlookTab";
import { NewsTab } from "./components/NewsTab";
import { PositionTab } from "./components/PositionTab";
import { TabBar, type Tab } from "./components/TabBar";
import { ThemeToggle } from "./components/ThemeToggle";
import { timeAgo } from "./lib/format";

const TABS: Tab[] = ["verdict", "chain", "holistic", "outlook", "news", "position"];

const LS_KEY = "xerxes.instrument";

export function App() {
  const [instrument, setInstrument] = useState<IndexKey | null>(() => {
    const s = localStorage.getItem(LS_KEY) as IndexKey | null;
    return s && INDEX_META[s] ? s : null;
  });

  const [stocksOpen, setStocksOpen] = useState(false);
  const [stock, setStock] = useState<{ file: string; name: string; expiry?: string } | null>(null);
  const [kronosOpen, setKronosOpen] = useState(false);

  const pick = (i: IndexKey) => {
    localStorage.setItem(LS_KEY, i);
    setStocksOpen(false);
    setStock(null);
    setKronosOpen(false);
    setInstrument(i);
  };
  const openStocks = () => {
    localStorage.removeItem(LS_KEY);
    setInstrument(null);
    setStock(null);
    setKronosOpen(false);
    setStocksOpen(true);
  };
  const openKronos = () => {
    localStorage.removeItem(LS_KEY);
    setInstrument(null);
    setStock(null);
    setStocksOpen(false);
    setKronosOpen(true);
  };

  // Cross-sectional ranker — its own route, sharing no state with the index or
  // stock screener routes. A failure to load its data cannot affect either.
  if (kronosOpen) return <KronosView onBack={() => setKronosOpen(false)} />;

  // Stocks section (kept entirely separate from the index route).
  if (stock)
    return (
      <StockDashboard
        file={stock.file}
        name={stock.name}
        initialExpiry={stock.expiry}
        onBack={() => setStock(null)}
        onOpen={(file, name, expiry) => setStock({ file, name, expiry })}
      />
    );
  if (stocksOpen)
    return <StockScreenerView onOpen={(file, name, expiry) => setStock({ file, name, expiry })} onBack={() => setStocksOpen(false)} />;

  if (!instrument)
    return <InstrumentPicker onPick={pick} onPickStocks={openStocks} onPickKronos={openKronos} />;
  return <Dashboard instrument={instrument} onSwitch={() => setInstrument(null)} />;
}

function Dashboard({ instrument, onSwitch }: { instrument: IndexKey; onSwitch: () => void }) {
  const dash = useDashboard(instrument);
  const market = useMarket();
  const snap = dash.snap;
  const [selectedExpiry, setSelectedExpiry] = useState<string>("");
  const [tab, setTab] = useState<Tab>("verdict");

  const refreshAll = () => {
    dash.refresh();
    market.refresh();
  };

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
          <span className="text-white/45 text-xs">▾</span>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-white/45 tnum" title="Data age — snapshots rebuild server-side every ~10 min in market hours">
            {snap?.asOf ? timeAgo(snap.asOf) : ""}
            <span className="text-white/15 ml-1">v{__BUILD_ID__}</span>
          </span>
          <button
            onClick={refreshAll}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-white/15 text-white/70 active:bg-white/[0.08] disabled:opacity-50"
            disabled={dash.loading}
            aria-label="Refresh data"
          >
            <span className={dash.loading ? "animate-spin" : ""}>⟳</span>
            {dash.loading ? "…" : "Refresh"}
          </button>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 px-3 space-y-3 pb-4">
        {dash.error && !snap && (
          <div className="text-center text-white/40 py-16 text-sm">
            No data yet for {INDEX_META[instrument].label}.
            <div className="text-[10px] mt-2 text-white/45">{dash.error}</div>
          </div>
        )}
        {!snap && !dash.error && <div className="text-center text-white/40 py-16">Loading market data…</div>}
        {snap && !exp && (
          <div className="text-center text-white/40 py-16 text-sm">
            Refreshing {INDEX_META[instrument].label} data…
            <div className="text-[10px] mt-2 text-white/45">The next data run will populate this shortly.</div>
          </div>
        )}

        {snap && exp && (
          <>
            <SpotStrip snap={snap} selectedExpiry={exp.date} onExpiryChange={setSelectedExpiry} />
            <TabBar tabs={TABS} tab={tab} onChange={setTab} />

            {tab === "verdict" && (
              <>
                {/* Selling premium is what this screen is for, so the candidates
                    lead the tab the way they lead the stocks screener. The
                    expiry chooser in SpotStrip still sits above and drives it. */}
                <SellCandidatesCard snap={snap} exp={exp} />
                <HorizonBiasCard snap={snap} selected={exp.date} onSelect={setSelectedExpiry} />
                <VerdictCard v={exp.verdict ?? snap.verdict} dte={exp.dte} />
                <MarketStructureCard structure={snap.structure} exp={exp} />
                <VolPremiumCard exp={exp} kind="index" />
                <FactorsCard v={exp.verdict ?? snap.verdict} snap={snap} exp={exp} />
              </>
            )}

            {tab === "chain" && (
              <>
                {!onDefaultHorizon && (
                  <div className="text-[10px] text-amber-300/70 px-1">
                    Viewing {exp.label} expiry ({exp.date}); the verdict is on the nearest expiry.
                  </div>
                )}
                <OiProfile snap={snap} exp={exp} />
                <LevelsCard snap={snap} exp={exp} />
                <MetricsCard snap={snap} exp={exp} />
              </>
            )}

            {tab === "position" && <PositionTab snap={snap} exp={exp} />}
            {tab === "holistic" && <HolisticTab snap={snap} exp={exp} />}
            {tab === "outlook" && <OutlookTab market={market.data} index={instrument} />}
            {tab === "news" && <NewsTab market={market.data} index={instrument} />}
          </>
        )}
      </main>

      <footer className="px-4 pb-5 text-[9px] leading-relaxed text-white/45">
        Decision aid, not advice. Index options carry unlimited risk when sold naked — always define risk.
        Data is delayed (~10 min refresh via GitHub Actions) and may be stale outside market hours.
      </footer>
    </div>
  );
}
