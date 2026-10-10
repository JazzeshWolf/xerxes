import { useMemo, useState } from "preact/hooks";
import type { Snapshot, StockRow, StockEvent, StockFiling, MarketData, Perf } from "../lib/types";
import { fmt, fmtPct, fmtExpiry, timeAgo } from "../lib/format";
import { sectorMedian, splitMove, moveReading, vsExpiry, priceMovingNews, peerPerf, type PerfKey } from "../lib/outlook";
import { Card, Badge } from "./ui";
import { NewsRow } from "./StockNewsTab";

/**
 * The stock counterpart of the index Outlook: what is moving THIS name, how its
 * sector and the market are doing, what is scheduled before expiry, and the
 * filings and headlines that could move the price.
 *
 * Everything here is read from data already loaded: the stock's own file
 * (outlook, events, filings, news), the screener's index.json (every peer's
 * move — zero extra requests) and market.json (macro calendar).
 */
const PERIODS: { key: PerfKey; label: string }[] = [
  { key: "d1", label: "1D" },
  { key: "w1", label: "1W" },
  { key: "m1", label: "1M" },
  { key: "m3", label: "3M" },
];
const tone = (x: number | null | undefined) => (x == null ? "text-white/45" : x < 0 ? "text-rose-400" : "text-emerald-400");

export function StockOutlookTab({
  snap,
  expiry,
  peers,
  benchmark,
  market,
  onOpenPeer,
  onShowNews,
}: {
  snap: Snapshot;
  /** The expiry selected in the header — events are placed against it. */
  expiry: string;
  /** Every screener row sharing this stock's sector, itself included. */
  peers: StockRow[];
  /** NIFTY's returns from index.json — the fallback for files without `outlook`. */
  benchmark: { name: string; perf: Perf } | null;
  market: MarketData | null;
  onOpenPeer: (file: string, name: string) => void;
  onShowNews: () => void;
}) {
  const o = snap.outlook ?? null;
  const bench = o?.benchmark ?? benchmark;
  const stockPerf: Perf = o?.perf ?? { d1: snap.spot.changePct, w1: null, m1: null, m3: null };
  const sectorBy = useMemo(
    () => Object.fromEntries(PERIODS.map(({ key }) => [key, sectorMedian(peers, snap.index, key)])) as Record<PerfKey, number | null>,
    [peers, snap.index],
  );

  return (
    <div className="space-y-3">
      <MovingCard snap={snap} stockPerf={stockPerf} benchD1={bench?.perf.d1 ?? null} sectorD1={sectorBy.d1} />
      <ComingCard snap={snap} expiry={expiry} market={market} />
      <SectorCard
        snap={snap}
        peers={peers}
        stockPerf={stockPerf}
        sectorBy={sectorBy}
        bench={bench}
        onOpenPeer={onOpenPeer}
      />
      <FilingsCard filings={snap.filings ?? []} />
      <HeadlinesCard snap={snap} onShowNews={onShowNews} />
    </div>
  );
}

// --- What's moving it -------------------------------------------------------

function MovingCard({
  snap,
  stockPerf,
  benchD1,
  sectorD1,
}: {
  snap: Snapshot;
  stockPerf: Perf;
  benchD1: number | null;
  sectorD1: number | null;
}) {
  const o = snap.outlook ?? null;
  const beta = o?.beta ?? null;
  const split = splitMove(stockPerf.d1, benchD1, beta, sectorD1);
  const rows = split
    ? [
        { label: `Market (β × NIFTY)`, value: split.market },
        { label: "Sector", value: split.sector },
        { label: "Stock-specific", value: split.own },
      ]
    : [];
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value)), 0.25);
  const s = snap.structure;
  const pace = o?.volume?.pace ?? null;

  return (
    <Card
      title={`What's moving ${snap.index}`}
      right={<span className={`text-[11px] font-semibold tnum ${tone(stockPerf.d1)}`}>{fmtPct(stockPerf.d1, 2)} today</span>}
    >
      {split ? (
        <>
          <div className="text-[11px] text-white/70 mb-2 leading-snug">{moveReading(split)}</div>
          <div className="space-y-1">
            {rows.map((r) => {
              const w = (Math.abs(r.value) / maxAbs) * 100;
              const pos = r.value >= 0;
              return (
                <div key={r.label} className="flex items-center gap-2 text-[11px]">
                  <span className="w-[112px] shrink-0 text-white/75 truncate">{r.label}</span>
                  <div className="flex-1 relative h-3">
                    <div className="absolute inset-y-0 left-1/2 w-px bg-white/15" />
                    <div
                      className={`absolute inset-y-0 rounded ${pos ? "bg-emerald-400/70" : "bg-rose-400/70"}`}
                      style={pos ? { left: "50%", width: `${w / 2}%` } : { right: "50%", width: `${w / 2}%` }}
                    />
                  </div>
                  <span className={`w-14 shrink-0 text-right tnum ${tone(r.value)}`}>{fmtPct(r.value, 2)}</span>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="text-[11px] text-white/50">
          The market/sector split needs NIFTY's move, which this snapshot doesn't carry yet — it appears after the next build.
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 mt-3">
        {beta != null && <Chip label="Beta to NIFTY" value={fmt(beta, 2)} hint={beta > 1.2 ? "amplifies the market" : beta < 0.8 ? "damps the market" : "moves with the market"} />}
        {s && (
          <Chip
            label="Futures"
            value={s.label}
            valueClass={s.bias === "bullish" ? "text-emerald-400" : s.bias === "bearish" ? "text-rose-400" : "text-sky-300"}
            hint={`price ${fmtPct(s.priceChgPct * 100, 1)} · OI ${fmtPct(s.oiChgPct * 100, 1)}`}
          />
        )}
        {pace != null && (
          <Chip
            label="Volume"
            value={`${fmt(pace, 1)}× usual`}
            valueClass={pace >= 1.5 ? "text-amber-300" : undefined}
            hint={o?.volume?.sessionFrac != null && o.volume.sessionFrac < 1 ? "pace so far today" : "vs 20-day avg"}
          />
        )}
      </div>
      <div className="text-[9px] text-white/45 mt-2 leading-relaxed">
        Market = beta × NIFTY's move; sector = the peer median's move beyond NIFTY; the rest is the stock's own. An
        approximation that always adds up to the day's move. Heavy volume plus a large own share usually means news —
        see filings and headlines below.
      </div>
    </Card>
  );
}

function Chip({ label, value, hint, valueClass }: { label: string; value: string; hint?: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1 min-w-0">
      <div className="text-[9px] uppercase tracking-wide text-white/45">{label}</div>
      <div className={`text-[11px] font-semibold tnum ${valueClass ?? "text-white/85"}`}>{value}</div>
      {hint && <div className="text-[9px] text-white/45">{hint}</div>}
    </div>
  );
}

// --- What's coming ------------------------------------------------------------

const EVENT_SOURCE_NOTE: Record<StockEvent["source"], string> = {
  nse: "NSE",
  news: "from news",
  options: "implied by option prices",
};
/** Earnings-type events are the ones that blow through a short strike. */
const EARNINGS = /^(Results|Earnings call|Board meeting|Event priced in)$/;

function ComingCard({ snap, expiry, market }: { snap: Snapshot; expiry: string; market: MarketData | null }) {
  const today = new Date().toISOString().slice(0, 10);
  const events = (snap.events ?? []).filter((e) => !e.date || e.date >= today);
  const recent = (snap.events ?? []).filter((e) => e.date && e.date < today);
  // Macro dates up to a week past expiry: they move every stock, banks most.
  const horizon = new Date(Date.parse(`${expiry}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  const macro = (market?.events ?? []).filter((e) => !e.done && e.date >= today && e.date <= horizon);
  const earningsBefore = events.find((e) => EARNINGS.test(e.kind) && e.source !== "options" && vsExpiry(e.date, expiry) !== "after" && e.date);

  return (
    <Card title="What's coming" right={<span className="text-[9px] text-white/45">vs the {fmtExpiry(expiry)} expiry</span>}>
      {earningsBefore && (
        <div className="mb-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-2.5 py-2 text-[11px] leading-snug text-amber-300">
          {earningsBefore.kind} on {fmtExpiry(earningsBefore.date)} — <b>before</b> this expiry. Expect a gap on the day and
          an IV drop after it; short strikes need room for both.
        </div>
      )}

      {events.length ? (
        <div className="space-y-1.5">
          {events.map((e, i) => (
            <EventRow key={`${e.kind}-${e.date ?? i}`} e={e} expiry={expiry} />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-white/50 py-2 text-center">
          No results date, earnings call, AGM or corporate action found — and the option chain isn't pricing one either.
        </div>
      )}

      {macro.length > 0 && (
        <>
          <div className="text-[9px] uppercase tracking-wider text-white/50 mt-3 mb-1.5">Market-wide</div>
          <div className="space-y-1">
            {macro.map((e) => (
              <div key={e.name + e.date} className="flex items-center gap-2 text-[11px]">
                <span className="w-[92px] shrink-0 tnum text-white/75">
                  {fmtExpiry(e.date)}
                  {e.approx && <span className="text-white/45"> ~</span>}
                </span>
                <span className="flex-1 text-white/80">{e.name}</span>
                {e.weight >= 3 && <Badge tone="warn">high</Badge>}
              </div>
            ))}
          </div>
        </>
      )}

      {recent.length > 0 && (
        <div className="text-[10px] text-white/45 mt-2">
          Just happened:{" "}
          {recent.map((e) => `${e.kind} ${fmtExpiry(e.date)}`).join(" · ")}
        </div>
      )}

      <div className="text-[9px] text-white/45 mt-2 leading-relaxed">
        Dates come from NSE's calendar, corporate actions (ex-dates) and filings, or from headlines ("approx"). "Event
        priced in" is read off the IV term structure: the market expects <em>something</em> before that expiry without
        naming it.
      </div>
    </Card>
  );
}

function EventRow({ e, expiry }: { e: StockEvent; expiry: string }) {
  const days = e.date ? Math.round((Date.parse(`${e.date}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86400000) : null;
  const where = vsExpiry(e.date, expiry);
  const body = (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="w-[92px] shrink-0 tnum text-white/80">
        {e.date ? fmtExpiry(e.date) : "date unknown"}
        {days != null && days >= 0 && <span className="text-white/45"> · {days === 0 ? "today" : `${days}d`}</span>}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-semibold text-white/85">{e.kind}</span>
          {e.approx && e.source !== "options" && <span className="text-[9px] text-amber-300">approx</span>}
          {where === "before" || where === "on" ? (
            <Badge tone="warn">{where === "on" ? "expiry day" : "before expiry"}</Badge>
          ) : where === "after" ? (
            <Badge>after expiry</Badge>
          ) : null}
        </div>
        <div className="text-[10px] text-white/50 leading-snug">{e.title}</div>
        <div className="text-[9px] text-white/40">
          {EVENT_SOURCE_NOTE[e.source]}
          {e.url ? " ↗" : ""}
        </div>
      </div>
    </div>
  );
  return e.url ? (
    <a href={e.url} target="_blank" rel="noopener noreferrer" className="block active:opacity-70">
      {body}
    </a>
  ) : (
    body
  );
}

// --- Sector & market ------------------------------------------------------------

function SectorCard({
  snap,
  peers,
  stockPerf,
  sectorBy,
  bench,
  onOpenPeer,
}: {
  snap: Snapshot;
  peers: StockRow[];
  stockPerf: Perf;
  sectorBy: Record<PerfKey, number | null>;
  bench: { name: string; perf: Perf } | null;
  onOpenPeer: (file: string, name: string) => void;
}) {
  const [period, setPeriod] = useState<PerfKey>("d1");
  const sector = snap.sector ?? null;
  const others = peers.filter((p) => p.symbol !== snap.index);
  // The stock itself sits in the ranking, highlighted, so its place is obvious.
  const ranked = useMemo(() => {
    const self = { symbol: snap.index, name: snap.name, file: "", value: stockPerf[period], self: true };
    const list = others.map((p) => ({ symbol: p.symbol, name: p.name, file: p.file, value: peerPerf(p, period), self: false }));
    return [...list, self]
      .filter((r) => r.value != null)
      .sort((a, b) => (b.value as number) - (a.value as number));
  }, [others, period, snap.index, snap.name, stockPerf]);
  const rank = ranked.findIndex((r) => r.self) + 1;
  const hasPeriods = others.some((p) => p.perf != null) || stockPerf.w1 != null;

  return (
    <Card title={sector ? `${sector} & market` : "Sector & market"} right={<span className="text-[9px] text-white/45">{others.length} peers</span>}>
      {/* Stock vs sector median vs NIFTY, every period at once. */}
      <div className="grid grid-cols-[52px_1fr_1fr_1fr] gap-y-1 text-[11px] tnum mb-3">
        <span className="text-[9px] uppercase tracking-wide text-white/45" />
        <span className="text-[9px] uppercase tracking-wide text-white/45 text-right">{snap.index}</span>
        <span className="text-[9px] uppercase tracking-wide text-white/45 text-right">Sector</span>
        <span className="text-[9px] uppercase tracking-wide text-white/45 text-right">{bench?.name ?? "NIFTY 50"}</span>
        {PERIODS.map(({ key, label }) => (
          <Row key={key} label={label} a={stockPerf[key]} b={sectorBy[key]} c={bench?.perf[key] ?? null} />
        ))}
      </div>

      {!others.length ? (
        <div className="text-[11px] text-white/50 py-2 text-center">No sector peers in the F&amp;O universe.</div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] text-white/55">
              {rank > 0 && (
                <>
                  {snap.index} is <span className="text-white/85 font-semibold">#{rank}</span> of {ranked.length} over{" "}
                  {PERIODS.find((p) => p.key === period)?.label}
                </>
              )}
            </div>
            {hasPeriods && (
              <div className="flex gap-1">
                {PERIODS.map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setPeriod(key)}
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${period === key ? "border-white/40 text-white/90 bg-white/[0.07]" : "border-white/10 text-white/50"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-0.5">
            {ranked.map((p) => (
              <button
                key={p.symbol}
                disabled={p.self}
                onClick={() => !p.self && onOpenPeer(p.file, p.name)}
                className={`w-full flex items-center gap-2 py-1 px-1 rounded-lg text-left text-[11px] ${
                  p.self ? "bg-white/[0.06] border border-white/[0.1]" : "active:bg-white/[0.05]"
                }`}
              >
                <span className={`w-[86px] shrink-0 font-semibold truncate ${p.self ? "text-white" : "text-white/85"}`}>{p.symbol}</span>
                <span className="flex-1 min-w-0 text-[10px] text-white/45 truncate">{p.self ? "this stock" : p.name}</span>
                <span className={`shrink-0 tnum ${tone(p.value)}`}>{fmtPct(p.value, 2)}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="text-[9px] text-white/45 mt-2 leading-relaxed">
        Sector = median of the F&amp;O peers in the same trading group. A stock running against its whole sector is
        usually reacting to something of its own — worth finding before selling into it.
      </div>
    </Card>
  );
}

function Row({ label, a, b, c }: { label: string; a: number | null; b: number | null; c: number | null }) {
  return (
    <>
      <span className="text-white/55">{label}</span>
      <span className={`text-right font-semibold ${tone(a)}`}>{fmtPct(a, 2)}</span>
      <span className={`text-right ${tone(b)}`}>{fmtPct(b, 2)}</span>
      <span className={`text-right ${tone(c)}`}>{fmtPct(c, 2)}</span>
    </>
  );
}

// --- Filings + headlines ----------------------------------------------------------

const FILING_TONE: Record<string, "up" | "down" | "warn" | "neutral"> = {
  "Order win": "up",
  "Legal / regulatory": "down",
  "Management change": "warn",
  Results: "warn",
  "Earnings call": "warn",
};

function FilingsCard({ filings }: { filings: StockFiling[] }) {
  return (
    <Card title="Exchange filings" right={<span className="text-[9px] text-white/45">NSE · last 3 weeks</span>}>
      {filings.length ? (
        <div className="space-y-1.5">
          {filings.slice(0, 8).map((f) => {
            const body = (
              <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={FILING_TONE[f.kind] ?? "neutral"}>{f.kind}</Badge>
                  <span className="text-[9px] text-white/45 tnum">
                    {timeAgo(f.publishedAt)}
                    {f.url ? " · PDF ↗" : ""}
                  </span>
                </div>
                <div className="text-[11px] text-white/80 leading-snug mt-1 line-clamp-3">{f.title}</div>
              </div>
            );
            return f.url ? (
              <a key={f.publishedAt + f.title} href={f.url} target="_blank" rel="noopener noreferrer" className="block active:opacity-70">
                {body}
              </a>
            ) : (
              <div key={f.publishedAt + f.title}>{body}</div>
            );
          })}
        </div>
      ) : (
        <div className="text-[11px] text-white/50 py-2 text-center">
          No price-sensitive filings on record — or NSE hasn't answered yet (it blocks automated requests often).
        </div>
      )}
      <div className="text-[9px] text-white/45 mt-2 leading-relaxed">
        Con-call schedules, shareholder meetings, board outcomes, order wins, ratings and management changes, straight
        from the exchange. Routine paperwork (trading-window notices, certificates) is left out.
      </div>
    </Card>
  );
}

function HeadlinesCard({ snap, onShowNews }: { snap: Snapshot; onShowNews: () => void }) {
  const items = priceMovingNews(snap.news ?? []);
  return (
    <Card
      title="Headlines that could move it"
      right={
        <button onClick={onShowNews} className="text-[10px] text-sky-300 active:opacity-70">
          All news →
        </button>
      }
    >
      {items.length ? (
        <div className="space-y-2">
          {items.map((n) => (
            <NewsRow key={n.url} n={n} />
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-white/50 py-2 text-center">
          Nothing directional in the latest headlines{snap.newsAsOf ? ` (fetched ${timeAgo(snap.newsAsOf)})` : ""}.
        </div>
      )}
    </Card>
  );
}
