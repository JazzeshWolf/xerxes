import type { MarketData, NewsItem } from "../lib/types";
import { timeAgo } from "../lib/format";
import { Card, Badge } from "./ui";

/** Impact-tagged news feed (index + macro), trusted sources first. */
export function NewsTab({ market }: { market: MarketData | null }) {
  if (!market) return <div className="text-center text-white/40 py-12 text-sm">Loading news…</div>;
  const news = market.news ?? [];
  if (!news.length) {
    return (
      <Card title="News">
        <div className="text-xs text-white/45">No fresh market news right now — check back after the next refresh.</div>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {news.map((n) => (
        <NewsRow key={n.url} n={n} />
      ))}
      <p className="text-[9px] text-white/25 px-1">
        Headlines via Google News; impact tags are keyword-based heuristics, not a verified read.
      </p>
    </div>
  );
}

function NewsRow({ n }: { n: NewsItem }) {
  const dot = n.impact === "up" ? "bg-emerald-400" : n.impact === "down" ? "bg-rose-400" : "bg-amber-400";
  return (
    <a
      href={n.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-xl bg-white/[0.04] border border-white/[0.06] p-3 active:bg-white/[0.07]"
    >
      <div className="flex gap-2">
        <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} title={n.impact} />
        <div className="min-w-0">
          <div className="text-[12px] text-white/90 leading-snug">{n.title}</div>
          <div className="flex items-center gap-1.5 mt-1 text-[10px] text-white/40">
            <span className="truncate">{n.source}</span>
            {n.trusted && <Badge>trusted</Badge>}
            {n.indirect && <span className="text-white/30">· macro</span>}
            <span className="ml-auto shrink-0">{timeAgo(n.publishedAt)}</span>
          </div>
        </div>
      </div>
    </a>
  );
}
