import type { IndexKey, MarketData, Driver } from "../lib/types";
import { fmt, fmtPct, fmtExpiry } from "../lib/format";
import { Card, Badge } from "./ui";

/** Weighted heavyweight drivers + upcoming event radar. */
export function OutlookTab({ market, index }: { market: MarketData | null; index: IndexKey }) {
  if (!market) return <div className="text-center text-white/40 py-12 text-sm">Loading outlook…</div>;
  const drivers = market.drivers?.[index] ?? [];
  return (
    <div className="space-y-3">
      <DriversCard drivers={drivers} />
      <EventRadar events={market.events} />
    </div>
  );
}

function DriversCard({ drivers }: { drivers: Driver[] }) {
  if (!drivers.length) {
    return (
      <Card title="What's moving the index">
        <div className="text-xs text-white/45">Heavyweight moves unavailable right now.</div>
      </Card>
    );
  }
  const net = drivers.reduce((a, d) => a + d.contribution, 0);
  const maxAbs = Math.max(...drivers.map((d) => Math.abs(d.contribution)), 0.01);
  const up = drivers.filter((d) => d.pct > 0).length;
  const lead = drivers[0];
  return (
    <Card
      title="What's moving the index"
      right={<span className={`text-[11px] font-semibold tnum ${net >= 0 ? "text-emerald-400" : "text-rose-400"}`}>net {net >= 0 ? "+" : ""}{fmt(net, 2)} pts-eq</span>}
    >
      <div className="text-[11px] text-white/50 mb-2">
        {up}/{drivers.length} heavyweights green · led by <span className="text-white/80">{lead.symbol}</span>{" "}
        ({fmtPct(lead.pct, 2)})
      </div>
      <div className="space-y-1">
        {drivers.map((d) => {
          const w = (Math.abs(d.contribution) / maxAbs) * 100;
          const pos = d.contribution >= 0;
          return (
            <div key={d.symbol} className="flex items-center gap-2 text-[11px]">
              <span className="w-20 shrink-0 text-white/85 truncate">{d.symbol}</span>
              <span className="w-9 shrink-0 text-white/35 tnum text-right">{fmt(d.weight, 1)}%</span>
              <div className="flex-1 relative h-3">
                <div className="absolute inset-y-0 left-1/2 w-px bg-white/15" />
                <div
                  className={`absolute inset-y-0 rounded ${pos ? "bg-emerald-400/70" : "bg-rose-400/70"}`}
                  style={pos ? { left: "50%", width: `${w / 2}%` } : { right: "50%", width: `${w / 2}%` }}
                />
              </div>
              <span className={`w-12 shrink-0 text-right tnum ${d.pct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(d.pct, 2)}</span>
            </div>
          );
        })}
      </div>
      <div className="text-[9px] text-white/25 mt-2">
        Bar = contribution to the index (weight × move). Weights are approximate free-float and refreshed periodically.
      </div>
    </Card>
  );
}

function EventRadar({ events }: { events: MarketData["events"] }) {
  if (!events.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <Card title="Event radar">
      <div className="space-y-2">
        {events.map((e) => {
          const days = Math.max(0, Math.round((Date.parse(e.date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000));
          return (
            <div key={e.name + e.date} className="border-t first:border-t-0 border-white/[0.06] pt-2 first:pt-0">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white/85">{e.name}</span>
                <span className="text-[10px] text-white/45 tnum">
                  {fmtExpiry(e.date)} · {days === 0 ? "today" : `in ${days}d`}
                  {e.weight >= 3 && <span className="ml-1"><Badge tone="warn">high</Badge></span>}
                </span>
              </div>
              <div className="text-[10px] text-white/50 mt-0.5 leading-relaxed">{e.effect}</div>
            </div>
          );
        })}
      </div>
      <div className="text-[9px] text-white/25 mt-2">Scheduled macro events; some dates are approximate.</div>
    </Card>
  );
}
