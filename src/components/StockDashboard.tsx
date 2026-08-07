import { useEffect, useState } from "preact/hooks";
import { useStock } from "../state/store";
import { SpotStrip } from "./SpotStrip";
import { VerdictCard } from "./VerdictCard";
import { HorizonBiasCard } from "./HorizonBiasCard";
import { MarketStructureCard } from "./MarketStructureCard";
import { OiProfile } from "./OiProfile";
import { LevelsCard } from "./LevelsCard";
import { MetricsCard } from "./MetricsCard";
import { SellTable } from "./SellTable";
import { FactorsCard } from "./FactorsCard";
import { HolisticTab } from "./HolisticTab";
import { PositionTab } from "./PositionTab";
import { TabBar, type Tab } from "./TabBar";
import { ThemeToggle } from "./ThemeToggle";
import { timeAgo } from "../lib/format";

// Stocks get the option-centric subset of the index tabs (no macro Outlook/News).
const TABS: Tab[] = ["verdict", "chain", "holistic", "position"];

/** Per-stock dashboard — same layout/components as the index Dashboard, fed by
 *  a stock snapshot. The index Dashboard is left untouched. */
export function StockDashboard({ file, name, onBack }: { file: string; name: string; onBack: () => void }) {
  const dash = useStock(file);
  const snap = dash.snap;
  const [selectedExpiry, setSelectedExpiry] = useState<string>("");
  const [tab, setTab] = useState<Tab>("verdict");

  useEffect(() => {
    if (snap) setSelectedExpiry(snap.defaultExpiry);
  }, [snap?.defaultExpiry, snap?.index]);

  const exp = snap?.expiries ? snap.expiries[selectedExpiry] ?? snap.expiries[snap.defaultExpiry] : null;
  const onDefaultHorizon = !snap || !exp || exp.date === snap.defaultExpiry;

  return (
    <div className="flex flex-col min-h-[100dvh]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <button onClick={onBack} className="flex items-center gap-1.5 active:opacity-70">
          <span className="text-white/40 text-sm">←</span>
          <span className="text-base font-semibold">{name}</span>
          <span className="text-[10px] text-white/35 uppercase tracking-wide border border-white/12 rounded px-1 py-0.5">stock</span>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-white/30 tnum">{snap?.asOf ? timeAgo(snap.asOf) : ""}</span>
          <button
            onClick={dash.hardRefresh}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-white/15 text-white/70 active:bg-white/[0.08] disabled:opacity-50"
            disabled={dash.loading || dash.refreshing}
            aria-label="Refresh data"
          >
            <span className={dash.loading || dash.refreshing ? "animate-spin" : ""}>⟳</span>
            {dash.refreshing ? "Refreshing…" : dash.loading ? "…" : "Refresh"}
          </button>
          <ThemeToggle />
        </div>
      </header>
      {dash.refreshing && (
        <div className="px-4 -mt-1 pb-1 text-[10px] text-sky-300/70">Rebuilding this stock's data — ~30–60s…</div>
      )}
      {dash.refreshError && !dash.refreshing && (
        <div className="px-4 -mt-1 pb-1 text-[10px] text-amber-300/70">{dash.refreshError}</div>
      )}

      <main className="flex-1 px-3 space-y-3 pb-4">
        {dash.error && !snap && (
          <div className="text-center text-white/40 py-16 text-sm">
            No data yet for {name}.
            <div className="text-[10px] mt-2 text-white/25">{dash.error}</div>
          </div>
        )}
        {!snap && !dash.error && <div className="text-center text-white/40 py-16">Loading {name}…</div>}
        {snap && !exp && (
          <div className="text-center text-white/40 py-16 text-sm">Refreshing {name} data…</div>
        )}

        {snap && exp && (
          <>
            <SpotStrip snap={snap} selectedExpiry={exp.date} onExpiryChange={setSelectedExpiry} />
            <TabBar tabs={TABS} tab={tab} onChange={setTab} />

            {tab === "verdict" && (
              <>
                <HorizonBiasCard snap={snap} selected={exp.date} onSelect={setSelectedExpiry} />
                <VerdictCard v={exp.verdict ?? snap.verdict} dte={exp.dte} />
                <MarketStructureCard structure={snap.structure} exp={exp} />
                <SellTable snap={snap} exp={exp} />
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

            {tab === "holistic" && <HolisticTab snap={snap} exp={exp} />}
            {tab === "position" && <PositionTab snap={snap} exp={exp} />}
          </>
        )}
      </main>

      <footer className="px-4 pb-5 text-[9px] leading-relaxed text-white/25">
        Decision aid, not advice. Options carry unlimited risk when sold naked — always define risk.
        Data is delayed and may be stale outside market hours.
      </footer>
    </div>
  );
}
