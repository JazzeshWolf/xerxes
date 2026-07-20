import { useState } from "preact/hooks";
import { useDashboard } from "./state/store";
import { SpotStrip } from "./components/SpotStrip";
import { VerdictCard } from "./components/VerdictCard";
import { OiProfile } from "./components/OiProfile";
import { LevelsCard } from "./components/LevelsCard";
import { MetricsCard } from "./components/MetricsCard";
import { SellTable } from "./components/SellTable";
import { FactorsCard } from "./components/FactorsCard";
import { timeAgo } from "./lib/format";

const INDEX_TABS = [
  { key: "NIFTY", label: "NIFTY", live: true },
  { key: "BANKNIFTY", label: "BANKNIFTY", live: false },
  { key: "SENSEX", label: "SENSEX", live: false },
] as const;

export function App() {
  const dash = useDashboard();
  const [idx, setIdx] = useState<string>("NIFTY");
  const snap = dash.snap;

  return (
    <div className="flex flex-col min-h-[100dvh]">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <h1 className="text-lg font-bold tracking-tight">⚔️ Xerxes</h1>
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

      <nav className="flex gap-1 px-3 pb-2">
        {INDEX_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => t.live && setIdx(t.key)}
            className={`text-[11px] px-2.5 py-1 rounded-full border ${
              idx === t.key
                ? "border-white/40 text-white bg-white/[0.06]"
                : t.live
                  ? "border-white/10 text-white/50"
                  : "border-white/5 text-white/25"
            }`}
          >
            {t.label}
            {!t.live && <span className="ml-1 text-[8px]">soon</span>}
          </button>
        ))}
      </nav>

      <main className="flex-1 px-3 space-y-3 pb-4">
        {dash.error && !snap && (
          <div className="text-center text-white/40 py-16 text-sm">
            No data yet — the refresh Action hasn't produced a snapshot.
            <div className="text-[10px] mt-2 text-white/25">{dash.error}</div>
          </div>
        )}
        {!snap && !dash.error && <div className="text-center text-white/40 py-16">Loading market data…</div>}

        {snap && (
          <>
            <SpotStrip snap={snap} />
            <VerdictCard v={snap.verdict} dte={snap.expiry.dte} />
            <SellTable snap={snap} />
            <OiProfile snap={snap} />
            <LevelsCard snap={snap} />
            <MetricsCard snap={snap} />
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
