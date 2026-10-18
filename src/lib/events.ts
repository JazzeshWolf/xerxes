// ---------------------------------------------------------------------------
// The screener's event marker: which listed trades have a price-moving event
// (results, earnings call, corporate action) before their own expiry.
//
// The rows come from index.json → events (built by `priceEvents` in
// scripts/stock-news.mjs: dated, upcoming, allow-listed kinds only). This file
// only decides which of them fall inside a given trade's life and how to label
// them. Display only — nothing here feeds the conviction score.
// ---------------------------------------------------------------------------

import type { RowEvent } from "./types";

/** Short labels for the row badge, where space is tight on a phone. */
export const EVENT_ABBR: Record<string, string> = {
  Results: "RES",
  "Earnings call": "CALL",
  "Board meeting": "BM",
  Dividend: "DIV",
  "Bonus issue": "BONUS",
  "Stock split": "SPLIT",
  Buyback: "BUYBK",
  "Rights issue": "RIGHTS",
  "Fund raise": "RAISE",
  AGM: "AGM",
  EGM: "EGM",
  "Corporate action": "CA",
};

/** Results-type events: the ones that gap a stock through a short strike. */
const EARNINGS = new Set(["Results", "Earnings call", "Board meeting"]);
export const isEarnings = (kind: string) => EARNINGS.has(kind);

/** IST calendar date (the market's), yyyy-mm-dd. */
export const istToday = (now = Date.now()) => new Date(now + 330 * 60000).toISOString().slice(0, 10);

/**
 * Events that land inside a trade's life: today through expiry day, inclusive.
 * An event after expiry can't hurt a position that is already settled, so a
 * 27 Oct put on a stock reporting on 4 Nov is clean.
 */
export function eventsForTrade(events: RowEvent[] | undefined, expiry: string | undefined, today: string): RowEvent[] {
  if (!events?.length || !expiry) return [];
  return events.filter((e) => e.date >= today && e.date <= expiry);
}

/** Same-day tie-break: the results themselves outrank the call and the board meeting. */
const EARNINGS_RANK: Record<string, number> = { Results: 0, "Board meeting": 1, "Earnings call": 2 };

/**
 * The event the badge shows: the earliest results-type one if any (on a tie,
 * Results before Board meeting before Earnings call — they usually land the
 * same day), else the earliest event. `list` is date-ordered.
 */
export function leadEvent(list: RowEvent[]): RowEvent | null {
  const earnings = list.filter((e) => isEarnings(e.kind));
  if (!earnings.length) return list[0] ?? null;
  return [...earnings].sort((a, b) => (a.date === b.date ? EARNINGS_RANK[a.kind] - EARNINGS_RANK[b.kind] : a.date < b.date ? -1 : 1))[0];
}

/** Whole days from `today` to an event date (0 = today). */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}
