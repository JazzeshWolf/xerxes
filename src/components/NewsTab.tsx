import type { IndexKey, MarketData, NewsItem } from "../lib/types";
import { timeAgo } from "../lib/format";
import { INDEX_META } from "../lib/types";
import { Card, Badge } from "./ui";

/** Impact-tagged news feed with an overall sentiment read for the index. */
export function NewsTab({ market, index }: { market: MarketData | null; index: IndexKey }) {
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
      <SentimentWidget news={news} index={index} />
      {news.map((n) => (
        <NewsRow key={n.url} n={n} />
      ))}
      <p className="text-[9px] text-white/45 px-1">
        Headlines via Google News; impact tags are keyword-based heuristics, not a verified read.
      </p>
    </div>
  );
}

/** Aggregate the feed's impact into an overall positive/negative/neutral read. */
function SentimentWidget({ news, index }: { news: NewsItem[]; index: IndexKey }) {
  const now = Date.now();
  let score = 0;
  let up = 0, down = 0, neutral = 0;
  for (const n of news) {
    if (n.impact === "up") up++;
    else if (n.impact === "down") down++;
    else neutral++;
    if (n.impact === "twoway") continue;
    const ageH = Math.max(0, (now - new Date(n.publishedAt).getTime()) / 3.6e6);
    const recency = ageH < 6 ? 1 : ageH < 24 ? 0.7 : ageH < 72 ? 0.4 : 0.2;
    const weight = (n.trusted ? 1.5 : 1) * recency;
    score += (n.impact === "up" ? 1 : -1) * weight;
  }
  const directional = up + down;
  // Normalise to −1..+1 over the directional items' max possible weight.
  const norm = directional > 0 ? Math.max(-1, Math.min(1, score / (directional * 1.05))) : 0;
  const label = norm > 0.15 ? "Positive" : norm < -0.15 ? "Negative" : "Mixed / neutral";
  const tone = norm > 0.15 ? "text-emerald-400" : norm < -0.15 ? "text-rose-400" : "text-sky-300";
  const pct = ((norm + 1) / 2) * 100;

  return (
    <Card title={`News sentiment · ${INDEX_META[index].label}`}>
      <div className="flex items-center justify-between">
        <span className={`text-lg font-bold ${tone}`}>{label}</span>
        <span className="text-[10px] text-white/40 tnum">
          <span className="text-emerald-400">{up}▲</span> · <span className="text-rose-400">{down}▼</span> · <span className="text-white/45">{neutral}◦</span> of {news.length}
        </span>
      </div>
      <div className="relative h-2 rounded-full mt-2 bg-gradient-to-r from-rose-500/60 via-white/15 to-emerald-500/60">
        <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow -translate-x-1/2" style={{ left: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[9px] text-white/45 mt-1">
        <span>bearish</span>
        <span>neutral</span>
        <span>bullish</span>
      </div>
      <div className="text-[9px] text-white/45 mt-1.5">
        Weighted by source trust &amp; recency across the headlines below — a read on the tape's mood, not a forecast.
      </div>
    </Card>
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
            {n.indirect && <span className="text-white/45">· macro</span>}
            <span className="ml-auto shrink-0">{timeAgo(n.publishedAt)}</span>
          </div>
        </div>
      </div>
    </a>
  );
}
