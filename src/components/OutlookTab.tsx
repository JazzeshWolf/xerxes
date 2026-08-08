import type { IndexKey, MarketData, Driver, Announcement } from "../lib/types";
import { fmt, fmtPct, fmtExpiry, timeAgo } from "../lib/format";
import { Card, Badge } from "./ui";

/** Weighted heavyweight drivers + event radar (macro + this index's company events). */
export function OutlookTab({ market, index }: { market: MarketData | null; index: IndexKey }) {
  if (!market) return <div className="text-center text-white/40 py-12 text-sm">Loading outlook…</div>;
  const drivers = market.drivers?.[index] ?? [];
  // Only company events touching THIS index's constituents.
  const constituents = new Set(drivers.map((d) => d.symbol));
  const companyEvents = (market.announcements ?? []).filter((a) => a.symbols.some((s) => constituents.has(s)));
  return (
    <div className="space-y-3">
      <DriversCard drivers={drivers} />
      <EventRadar events={market.events} companyEvents={companyEvents} index={index} />
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
              <span className="w-9 shrink-0 text-white/50 tnum text-right">{fmt(d.weight, 1)}%</span>
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
      <div className="text-[9px] text-white/45 mt-2">
        Bar = contribution to the index (weight × move). Weights are approximate free-float and refreshed periodically.
      </div>
    </Card>
  );
}

function EventRadar({ events, companyEvents, index }: { events: MarketData["events"]; companyEvents: Announcement[]; index: IndexKey }) {
  if (!events.length && !companyEvents.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = events.filter((e) => !e.done);
  const past = events.filter((e) => e.done).reverse(); // most recent first
  return (
    <Card title="Event radar">
      {past.length > 0 && (
        <>
          <div className="text-[9px] uppercase tracking-wider text-white/50 mb-1.5">Recent — how the index reacted</div>
          <div className="space-y-2 mb-3">
            {past.map((e) => {
              const r = e.realized?.[index];
              return (
                <div key={e.name + e.date} className="border-t first:border-t-0 border-white/[0.06] pt-2 first:pt-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white/70">{e.name}</span>
                    <span className="text-[10px] tnum">
                      <span className="text-white/40">{fmtExpiry(e.date)} · </span>
                      {r != null ? (
                        <span className={`font-bold ${r >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {r >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(r), 2, false)} on the day
                        </span>
                      ) : (
                        <span className="text-white/50">reaction n/a</span>
                      )}
                    </span>
                  </div>
                  <div className="text-[10px] text-white/40 mt-0.5 leading-relaxed">{e.effect}</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {upcoming.length > 0 && (
        <>
          <div className="text-[9px] uppercase tracking-wider text-white/50 mb-1.5">Upcoming — macro</div>
          <div className="space-y-2">
            {upcoming.map((e) => {
              const days = Math.max(0, Math.round((Date.parse(e.date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000));
              return (
                <div key={e.name + e.date} className="border-t first:border-t-0 border-white/[0.06] pt-2 first:pt-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white/85">{e.name}</span>
                    <span className="text-[10px] text-white/45 tnum">
                      {fmtExpiry(e.date)}{e.approx && <span className="text-white/45"> ~</span>} · {days === 0 ? "today" : `in ${days}d`}
                      {e.weight >= 3 && <span className="ml-1"><Badge tone="warn">high</Badge></span>}
                    </span>
                  </div>
                  <div className="text-[10px] text-white/50 mt-0.5 leading-relaxed">{e.effect}</div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {companyEvents.length > 0 && (
        <>
          <div className="text-[9px] uppercase tracking-wider text-white/50 mb-1.5 mt-3">Company events — {index} heavyweights</div>
          <div className="space-y-2">
            {companyEvents.slice(0, 6).map((a) => {
              const dot = a.impact === "up" ? "bg-emerald-400" : a.impact === "down" ? "bg-rose-400" : "bg-amber-400";
              return (
                <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer" className="block border-t first:border-t-0 border-white/[0.06] pt-2 first:pt-0 active:opacity-70">
                  <div className="flex gap-2">
                    <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                    <div className="min-w-0">
                      <div className="text-[11px] text-white/85 leading-snug">{a.title}</div>
                      <div className="text-[9px] text-white/40 mt-0.5">
                        <span className="text-white/60">{a.symbols.join(" · ")}</span> · {a.source} · {timeAgo(a.publishedAt)}
                      </div>
                    </div>
                  </div>
                </a>
              );
            })}
          </div>
        </>
      )}

      <div className="text-[9px] text-white/45 mt-2">
        Reaction = the index's move on the first session after the event. Company events are news-derived (results, board
        meetings, payouts); <span className="text-white/45">~</span> marks an unconfirmed date.
      </div>
    </Card>
  );
}
