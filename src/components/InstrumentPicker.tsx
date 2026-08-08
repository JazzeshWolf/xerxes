import type { IndexKey } from "../lib/types";
import { INDEX_META } from "../lib/types";
import { ThemeToggle } from "./ThemeToggle";

const ORDER: IndexKey[] = ["NIFTY", "BANKNIFTY", "SENSEX"];

/** Landing chooser — pick which market to analyse. Persisted by the caller. */
export function InstrumentPicker({ onPick, onPickStocks }: { onPick: (i: IndexKey) => void; onPickStocks: () => void }) {
  return (
    <div className="flex flex-col min-h-[100dvh] px-5 justify-center">
      {/* The whole block is vertically centred, so the toggle rides alongside
          the title rather than pinning to the top of the viewport. `top-0.5`
          centres the 28px button on the 32px h1 line. */}
      <div className="relative text-center mb-6">
        <h1 className="text-2xl font-bold tracking-tight">⚔️ Xerxes</h1>
        <p className="text-[11px] text-white/45 mt-1">Index option screener — pick a market</p>
        <div className="absolute right-0 top-0.5">
          <ThemeToggle />
        </div>
      </div>
      <div className="space-y-2.5">
        {ORDER.map((k) => (
          <button
            key={k}
            onClick={() => onPick(k)}
            className="w-full flex items-center justify-between rounded-xl bg-white/[0.05] border border-white/[0.08] px-4 py-3.5 active:bg-white/[0.09] text-left"
          >
            <div>
              <div className="text-base font-semibold">{INDEX_META[k].label}</div>
              <div className="text-[11px] text-white/45">{INDEX_META[k].blurb}</div>
            </div>
            <span className="text-white/45 text-lg">→</span>
          </button>
        ))}
        <button
          onClick={onPickStocks}
          className="w-full flex items-center justify-between rounded-xl bg-white/[0.05] border border-white/[0.08] px-4 py-3.5 active:bg-white/[0.09] text-left"
        >
          <div>
            <div className="text-base font-semibold">Stocks</div>
            <div className="text-[11px] text-white/45">Single-stock F&amp;O screener · liquidity, structure, candidates</div>
          </div>
          <span className="text-white/45 text-lg">→</span>
        </button>
      </div>
      <p className="text-[9px] text-white/45 text-center mt-6 leading-relaxed">
        Decision aid, not advice. Data is delayed (~10 min) and may be stale outside market hours.
      </p>
    </div>
  );
}
