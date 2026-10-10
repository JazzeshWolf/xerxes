import { useEffect, useState } from "preact/hooks";
import { useStock, useStockScreener, useMarket, HAS_REFRESH_PROXY } from "../state/store";
import { SpotStrip } from "./SpotStrip";
import { VerdictCard } from "./VerdictCard";
import { HorizonBiasCard } from "./HorizonBiasCard";
import { MarketStructureCard } from "./MarketStructureCard";
import { OiProfile } from "./OiProfile";
import { LevelsCard } from "./LevelsCard";
import { MetricsCard } from "./MetricsCard";
import { SellTable } from "./SellTable";
import { VolPremiumCard } from "./VolPremiumCard";
import { FactorsCard } from "./FactorsCard";
import { HolisticTab } from "./HolisticTab";
import { PositionTab } from "./PositionTab";
import { StockNewsTab } from "./StockNewsTab";
import { StockOutlookTab } from "./StockOutlookTab";
import { TabBar, type Tab } from "./TabBar";
import { ThemeToggle } from "./ThemeToggle";
import { timeAgo } from "../lib/format";

// Same tab set as the index dashboard. Outlook and News are per-COMPANY rather
// than macro: Outlook answers "what is moving this stock, how is its sector
// doing, what is scheduled before expiry"; News is its own headlines, fetched
// live through the refresh Worker when one is deployed.
const TABS: Tab[] = ["verdict", "chain", "holistic", "outlook", "news", "position"];

/** Per-stock dashboard — same layout/components as the index Dashboard, fed by
 *  a stock snapshot. The index Dashboard is left untouched. */
export function StockDashboard({
  file,
  name,
  initialExpiry,
  onBack,
  onOpen,
}: {
  file: string;
  name: string;
  /** Expiry to open on — the one the tapped screener candidate belongs to. */
  initialExpiry?: string;
  onBack: () => void;
  onOpen?: (file: string, name: string, expiry?: string) => void;
}) {
  const dash = useStock(file);
  // The screener index is already loaded/cached by the store and carries every
  // stock's sector + day move — all the peer panel needs, with no extra fetch.
  const { screener } = useStockScreener();
  // Macro calendar (RBI, Fed, CPI) — the same market.json the index Outlook reads.
  const market = useMarket();
  const snap = dash.snap;
  const [selectedExpiry, setSelectedExpiry] = useState<string>("");
  const [tab, setTab] = useState<Tab>("verdict");

  useEffect(() => {
    if (!snap) return;
    // Land on the expiry the candidate came from, not blindly on the nearest
    // one. The screener's current and next lists are different trades entirely
    // — tapping a 39d put and arriving on the 4d chain showed a strike the user
    // never chose. Falls back when that expiry isn't in this stock's file,
    // which is what a stale candidates.json against a fresh snapshot looks like.
    setSelectedExpiry(
      initialExpiry && snap.expiries?.[initialExpiry] ? initialExpiry : snap.defaultExpiry,
    );
  }, [snap?.defaultExpiry, snap?.index, initialExpiry]);

  const exp = snap?.expiries ? snap.expiries[selectedExpiry] ?? snap.expiries[snap.defaultExpiry] : null;
  const onDefaultHorizon = !snap || !exp || exp.date === snap.defaultExpiry;

  return (
    <div className="flex flex-col min-h-[100dvh]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <button onClick={onBack} className="flex items-center gap-1.5 active:opacity-70">
          <span className="text-white/40 text-sm">←</span>
          <span className="text-base font-semibold">{name}</span>
          <span className="text-[10px] text-white/50 uppercase tracking-wide border border-white/12 rounded px-1 py-0.5">stock</span>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-white/45 tnum">{snap?.asOf ? timeAgo(snap.asOf) : ""}</span>
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
            <div className="text-[10px] mt-2 text-white/45">{dash.error}</div>
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
                <VolPremiumCard exp={exp} kind="stock" />
                <SellTable key={exp.date} snap={snap} exp={exp} />
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
            {tab === "outlook" && (
              <StockOutlookTab
                snap={snap}
                expiry={exp.date}
                peers={(screener?.stocks ?? []).filter((r) => snap.sector && r.sector === snap.sector)}
                benchmark={screener?.benchmark ?? null}
                market={market.data}
                onOpenPeer={(f, n) => onOpen?.(f, n)}
                onShowNews={() => setTab("news")}
              />
            )}
            {tab === "news" && (
              <StockNewsTab
                snap={snap}
                onFetch={dash.fetchNews}
                fetching={dash.newsFetching}
                fetchError={dash.newsError}
                canFetch={HAS_REFRESH_PROXY}
              />
            )}
            {tab === "position" && <PositionTab snap={snap} exp={exp} />}
          </>
        )}
      </main>

      <footer className="px-4 pb-5 text-[9px] leading-relaxed text-white/45">
        Decision aid, not advice. Options carry unlimited risk when sold naked — always define risk.
        Data is delayed and may be stale outside market hours.
      </footer>
    </div>
  );
}
