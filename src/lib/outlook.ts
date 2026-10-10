// ---------------------------------------------------------------------------
// Pure helpers behind the stock Outlook tab and the live "Fetch latest news".
//
// Kept out of the components so the arithmetic (the move split, the sector
// median, the live-news merge) is unit-tested rather than eyeballed.
// ---------------------------------------------------------------------------

import type { LiveNews, Perf, Snapshot, StockEvent, StockNewsItem, StockRow } from "./types";

export type PerfKey = keyof Perf;

/** Median of the non-null values, or null when there are none. */
export function median(xs: (number | null | undefined)[]): number | null {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** A peer's return over `key`. The day move lives on the row itself, the
 *  rest under `perf` (absent on index.json files published before it existed). */
export const peerPerf = (r: StockRow, key: PerfKey): number | null =>
  key === "d1" ? r.changePct ?? r.perf?.d1 ?? null : r.perf?.[key] ?? null;

/** The sector's median move over `key`, the stock itself excluded. */
export function sectorMedian(peers: StockRow[], self: string, key: PerfKey): number | null {
  return median(peers.filter((p) => p.symbol !== self).map((p) => peerPerf(p, key)));
}

export interface MoveSplit {
  /** β × the market's move — what the stock "should" have done on the tape alone. */
  market: number;
  /** The sector's move beyond the market (0 when there are no peers to measure). */
  sector: number;
  /** Whatever is left: the stock's own story. */
  own: number;
  total: number;
}

/**
 * Split a day's move into market, sector and stock-specific parts. It always
 * sums back to the stock's move. An approximation: the market part uses the
 * stock's beta, while the sector part assumes the sector moves 1:1 with the
 * market. That's accurate enough to tell "the whole tape fell" from "something
 * happened to this company", which is the only question it is here to answer.
 */
export function splitMove(
  stockPct: number | null,
  marketPct: number | null,
  beta: number | null,
  sectorPct: number | null,
): MoveSplit | null {
  if (stockPct == null || marketPct == null) return null;
  const market = (beta ?? 1) * marketPct;
  const sector = sectorPct != null ? sectorPct - marketPct : 0;
  return { market, sector, own: stockPct - market - sector, total: stockPct };
}

/** One sentence on what dominated the move. Thresholds are deliberately loose. */
export function moveReading(s: MoveSplit): string {
  const parts = [
    ["the market", Math.abs(s.market)],
    ["its sector", Math.abs(s.sector)],
    ["stock-specific news or flow", Math.abs(s.own)],
  ] as const;
  const total = parts.reduce((a, [, v]) => a + v, 0);
  if (Math.abs(s.total) < 0.3 && total < 0.6) return "A quiet day — nothing much is moving it.";
  const [who, size] = [...parts].sort((a, b) => b[1] - a[1])[0];
  const share = total > 0 ? size / total : 0;
  if (share < 0.45) return "No single driver — market, sector and the stock itself all contributed.";
  return who === "stock-specific news or flow"
    ? "Mostly its own story: the market and sector don't explain the move. Check the news and filings below."
    : `Mostly ${who}: the stock is moving with ${who === "the market" ? "the tape" : "its peers"}, not on its own news.`;
}

/** Where an event sits against the selected expiry. A results date BEFORE expiry
 *  is the single most important thing a premium seller can learn here. */
export function vsExpiry(date: string | null, expiry: string): "before" | "on" | "after" | null {
  if (!date) return null;
  return date < expiry ? "before" : date === expiry ? "on" : "after";
}

/** Headlines that carry a directional read or name a corporate event. Same
 *  vocabulary as the build's `classifyEvent`, kept short on purpose. */
const EVENTFUL = /result|earnings|dividend|buy[- ]?back|order|contract|acqui|merger|stake|rating|upgrade|downgrade|target|guidance|block deal|bulk deal|penalt|probe|raid|resign|appoint|fund ?rais|qip|split|bonus/i;
export function priceMovingNews(news: StockNewsItem[], n = 4): StockNewsItem[] {
  return news.filter((x) => x.impact !== "twoway" || EVENTFUL.test(`${x.title} ${x.snippet ?? ""}`)).slice(0, n);
}

const eventKey = (e: StockEvent) => `${e.kind}|${e.date ?? "?"}`;

/**
 * Overlay a live /news answer on the published snapshot.
 *
 * - The published copy wins if it is newer (a build landed after the tap).
 * - Live headlines replace the cached ones, unless Google returned nothing — a
 *   failed fetch must not wipe the list, nor claim "fetched just now".
 * - Events: the live dated ones win; the file still contributes the
 *   options-implied window (the Worker can't compute it — no chain), and its
 *   NSE dates whenever NSE didn't answer the live call.
 * - Filings follow the same NSE rule.
 */
export function mergeLiveNews(snap: Snapshot, live: LiveNews | null): Snapshot {
  if (!live || live.symbol !== snap.index) return snap;
  if (snap.newsAsOf && snap.newsAsOf >= live.newsAsOf) return snap;
  const gotNews = live.news.length > 0;
  const keepFromFile = (snap.events ?? []).filter(
    (e) => e.source === "options" || (e.source === "nse" && !live.nseOk) || (e.source === "news" && !gotNews),
  );
  const events = new Map<string, StockEvent>();
  for (const e of [...keepFromFile, ...live.events]) {
    const prev = events.get(eventKey(e));
    if (!prev || prev.source !== "nse") events.set(eventKey(e), e);
  }
  return {
    ...snap,
    news: gotNews ? live.news : snap.news ?? [],
    newsAsOf: gotNews ? live.newsAsOf : snap.newsAsOf ?? null,
    events: [...events.values()].sort((a, b) => ((a.date ?? "9999") < (b.date ?? "9999") ? -1 : 1)),
    filings: live.nseOk ? live.filings : snap.filings ?? [],
  };
}
