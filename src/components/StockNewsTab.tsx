import { useMemo } from "preact/hooks";
import type { Snapshot, StockNewsItem, StockEvent, StockRow } from "../lib/types";
import { fmtPct, fmtExpiry, timeAgo } from "../lib/format";
import { Card, Badge } from "./ui";

/**
 * What could move THIS stock: its own headlines, the scheduled events between
 * now and expiry, and how the rest of its sector is trading.
 *
 * Only the news list needs fetching. Events always include the options-implied
 * window (derived from the IV term structure at build time), and the peer panel
 * is pure arithmetic over the screener index — so this tab still says something
 * useful on a run where every scrape failed.
 */
const impactTone = (i: string) => (i === "up" ? "up" : i === "down" ? "down" : "neutral");
const EVENT_SOURCE_NOTE: Record<StockEvent["source"], string> = {
  nse: "NSE calendar",
  news: "from news",
  options: "implied by option prices",
};

export function StockNewsTab({
  snap,
  peers,
  onFetch,
  fetching,
  fetchError,
  canFetch,
  onOpenPeer,
}: {
  snap: Snapshot;
  peers: StockRow[];
  onFetch: () => void;
  fetching: boolean;
  fetchError: string | null;
  canFetch: boolean;
  onOpenPeer: (file: string, name: string) => void;
}) {
  const news = snap.news ?? [];
  const events = snap.events ?? [];
  const sector = snap.sector ?? null;

  // Peer stats: the sector's median day-move, and where this stock sits in it.
  const peerStats = useMemo(() => {
    const others = peers.filter((p) => p.symbol !== snap.index && p.changePct != null);
    if (!others.length) return null;
    const moves = others.map((p) => p.changePct as number).sort((a, b) => a - b);
    const median = moves[Math.floor(moves.length / 2)];
    const mine = snap.spot.changePct;
    return {
      median,
      relative: mine != null ? mine - median : null,
      ranked: [...others].sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0)),
    };
  }, [peers, snap.index, snap.spot.changePct]);

  return (
    <div className="space-y-3">
      <Card
        title={`${snap.index} news`}
        right={
          <span className="text-[9px] text-white/45 tnum">
            {snap.newsAsOf ? `fetched ${timeAgo(snap.newsAsOf)}` : "not fetched yet"}
          </span>
        }
      >
        <button
          onClick={onFetch}
          disabled={fetching}
          className="w-full mb-2 text-[11px] px-3 py-2 rounded-lg border border-white/20 text-white/85 active:bg-white/[0.08] disabled:opacity-50"
        >
          {fetching ? "Fetching…" : "Fetch latest news"}
        </button>

        {fetching && (
          <div className="text-[10px] text-sky-300/80 mb-2">
            Rebuilding {snap.index} with fresh news — ~30–60s.
          </div>
        )}
        {fetchError && !fetching && <div className="text-[10px] text-amber-300/80 mb-2">{fetchError}</div>}
        {!canFetch && !fetching && (
          <div className="text-[10px] text-white/50 leading-relaxed mb-2">
            Live fetching needs the refresh worker (<span className="tnum">worker/README.md</span>). Until
            it's deployed this button just re-pulls the last published copy, and news fills in on a
            rotation — a few names per build, oldest first.
          </div>
        )}

        {news.length ? (
          <div className="space-y-2">
            {news.map((n) => (
              <NewsRow key={n.url} n={n} />
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-white/50 py-3 text-center">
            No news cached for {snap.index} yet.
          </div>
        )}
      </Card>

      <Card title="What's coming" right={<span className="text-[9px] text-white/45">before / around expiry</span>}>
        {events.length ? (
          <div className="space-y-1.5">
            {events.map((e, i) => (
              <EventRow key={`${e.kind}-${e.date ?? i}`} e={e} />
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-white/50 py-3 text-center">
            Nothing scheduled that we can see, and the option chain isn't pricing an event either.
          </div>
        )}
        <div className="text-[9px] text-white/45 mt-2 leading-relaxed">
          A dated entry comes from NSE's calendar or a headline. "Event priced in" is inferred from the
          IV term structure — it means the market expects <em>something</em> before that expiry, without
          naming it.
        </div>
      </Card>

      <Card
        title={sector ? `${sector} today` : "Sector"}
        right={<span className="text-[9px] text-white/45">{peerStats ? `${peerStats.ranked.length} peers` : ""}</span>}
      >
        {!sector || !peerStats ? (
          <div className="text-[11px] text-white/50 py-3 text-center">No sector peers available.</div>
        ) : (
          <>
            <div className="flex items-baseline justify-between mb-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-white/45">Sector median</div>
                <div className={`text-sm font-semibold tnum ${peerStats.median < 0 ? "text-rose-400" : "text-emerald-400"}`}>
                  {fmtPct(peerStats.median, 2)}
                </div>
              </div>
              {peerStats.relative != null && (
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wide text-white/45">
                    {snap.index} vs sector
                  </div>
                  <div className={`text-sm font-semibold tnum ${peerStats.relative < 0 ? "text-rose-400" : "text-emerald-400"}`}>
                    {fmtPct(peerStats.relative, 2)}
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-0.5">
              {peerStats.ranked.map((p) => (
                <button
                  key={p.symbol}
                  onClick={() => onOpenPeer(p.file, p.name)}
                  className="w-full flex items-center gap-2 py-1 px-1 rounded-lg active:bg-white/[0.05] text-left text-[11px]"
                >
                  <span className="w-[86px] shrink-0 font-semibold text-white/85 truncate">{p.symbol}</span>
                  <span className="flex-1 min-w-0 text-[10px] text-white/45 truncate">{p.name}</span>
                  <span className={`shrink-0 tnum ${(p.changePct ?? 0) < 0 ? "text-rose-400" : "text-emerald-400"}`}>
                    {fmtPct(p.changePct, 2)}
                  </span>
                </button>
              ))}
            </div>
            <div className="text-[9px] text-white/45 mt-2 leading-relaxed">
              A stock moving against its whole sector is usually reacting to something of its own —
              worth finding before selling into it.
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function NewsRow({ n }: { n: StockNewsItem }) {
  return (
    <a
      href={n.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2 active:bg-white/[0.06]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] leading-snug text-white/85">{n.title}</span>
        <Badge tone={impactTone(n.impact)}>{n.impact === "twoway" ? "mixed" : n.impact}</Badge>
      </div>
      <div className="text-[9px] text-white/45 mt-1 tnum">
        {n.source}
        {n.trusted ? " ✓" : ""} · {timeAgo(n.publishedAt)}
      </div>
    </a>
  );
}

function EventRow({ e }: { e: StockEvent }) {
  const days = e.date ? Math.round((Date.parse(`${e.date}T00:00:00Z`) - Date.now()) / 86400000) : null;
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="w-[92px] shrink-0 tnum text-white/80">
        {e.date ? fmtExpiry(e.date) : "date unknown"}
        {days != null && days >= 0 && <span className="text-white/45"> · {days}d</span>}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-white/85">{e.kind}</span>
          {e.approx && <span className="text-[9px] text-amber-300/80">approx</span>}
        </div>
        <div className="text-[10px] text-white/50 leading-snug">{e.title}</div>
        <div className="text-[9px] text-white/40">{EVENT_SOURCE_NOTE[e.source]}</div>
      </div>
    </div>
  );
}
