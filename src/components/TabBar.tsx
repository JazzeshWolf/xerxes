export type Tab = "verdict" | "chain" | "holistic" | "outlook" | "news";

const LABELS: Record<Tab, string> = {
  verdict: "Verdict",
  chain: "Chain",
  holistic: "Holistic",
  outlook: "Outlook",
  news: "News",
};

export function TabBar({ tabs, tab, onChange }: { tabs: Tab[]; tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto no-scrollbar px-1 py-1">
      {tabs.map((t) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={`shrink-0 text-xs px-3 py-1.5 rounded-full border transition-colors ${
            tab === t ? "border-white/40 text-white bg-white/[0.07]" : "border-white/10 text-white/50"
          }`}
        >
          {LABELS[t]}
        </button>
      ))}
    </div>
  );
}
