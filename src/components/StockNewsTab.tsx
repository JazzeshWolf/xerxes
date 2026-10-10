import type { Snapshot, StockNewsItem } from "../lib/types";
import { timeAgo } from "../lib/format";
import { Card, Badge } from "./ui";

/**
 * THIS company's headlines. "Fetch latest news" asks the refresh Worker for
 * them live — a few seconds, straight from Google News and NSE — and overlays
 * the answer on the published snapshot (see `mergeLiveNews`). Without the
 * Worker the button can only re-pull the published copy, which the rotation
 * refreshes every ~2 h, so the tab says that and offers a live search link.
 *
 * Scheduled events, filings and sector peers live on the Outlook tab.
 */
const impactTone = (i: string) => (i === "up" ? "up" : i === "down" ? "down" : "neutral");

export function StockNewsTab({
  snap,
  onFetch,
  fetching,
  fetchError,
  canFetch,
}: {
  snap: Snapshot;
  onFetch: () => void;
  fetching: boolean;
  fetchError: string | null;
  canFetch: boolean;
}) {
  const news = snap.news ?? [];
  const liveSearch = `https://news.google.com/search?q=${encodeURIComponent(`"${snap.name}" OR "${snap.index}"`)}&hl=en-IN&gl=IN&ceid=IN:en`;

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

        {fetching && <div className="text-[10px] text-sky-300/80 mb-2">Asking Google News and NSE for {snap.index} — a few seconds.</div>}
        {fetchError && !fetching && <div className="text-[10px] text-amber-300 mb-2">{fetchError}</div>}
        {!canFetch && !fetching && (
          <div className="text-[10px] text-white/50 leading-relaxed mb-2">
            Live fetching needs the refresh Worker (<span className="tnum">worker/README.md</span>) — until it's
            deployed this button only re-pulls the published copy, which refreshes on a ~2 h rotation.{" "}
            <a href={liveSearch} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline underline-offset-2">
              Search Google News live ↗
            </a>
          </div>
        )}

        {news.length ? (
          <div className="space-y-2">
            {news.map((n) => (
              <NewsRow key={n.url} n={n} />
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-white/50 py-3 text-center">No news cached for {snap.index} yet.</div>
        )}
        <div className="text-[9px] text-white/45 mt-2 leading-relaxed">
          Upcoming results, earnings calls, AGMs, exchange filings and the sector are on the Outlook tab.
        </div>
      </Card>
    </div>
  );
}

export function NewsRow({ n }: { n: StockNewsItem }) {
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
