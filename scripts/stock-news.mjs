// ---------------------------------------------------------------------------
// Per-stock news + corporate events.
//
// market.mjs answers "what is happening to the market". This answers "what is
// happening to THIS company" — the headlines, and the scheduled events (results,
// board meetings, dividends) that move a single name and therefore decide
// whether selling premium into an expiry is safe.
//
// Four event sources, deliberately, because each one fails differently:
//   1. options-implied  — from the IV term structure. Never fails, needs no
//      network, but gives a WINDOW ("something before 25 Aug"), not a date.
//   2. NSE event calendar — exact dates, bot-protected and intermittent.
//   3. the news feed itself — dates parsed out of headlines; approximate.
//   4. Moneycontrol / ET / Mint — reached through Google News `source:`
//      operators rather than a separate scraper.
// They are merged and deduped, so a run where three of them fail still shows
// something useful.
//
// Everything fails soft to empty — a stock with no news is normal, not an error.
// ---------------------------------------------------------------------------

import { getText, stripTags, decodeEntities, tagImpact, isTrusted } from "./market.mjs";
import { STOCKS } from "./stocks-universe.mjs";

const RSS_HEADERS = {
  "User-Agent": "Mozilla/5.0",
  Accept: "application/rss+xml,application/xml",
};

const MAX_AGE_MS = 14 * 86400000;
const MAX_ITEMS = 12;

/** Outlets worth naming in the query — `isTrusted` already recognises them. */
const SOURCES = ["Moneycontrol", "Economic Times", "Mint", "Business Standard", "Reuters"];

/** Event keywords → a short kind label. Order matters; first match wins. */
const EVENT_KINDS = [
  [/\b(q[1-4]|quarterly|half[- ]year|annual)\s+(results|earnings)|results? (date|on|announce)|earnings call/i, "Results"],
  [/board meeting/i, "Board meeting"],
  [/\bdividend\b/i, "Dividend"],
  [/buy[- ]?back/i, "Buyback"],
  [/\bagm\b|annual general meeting/i, "AGM"],
  [/stock split|\bsplit\b/i, "Stock split"],
  [/\bbonus (issue|share)/i, "Bonus issue"],
  [/rights issue/i, "Rights issue"],
  [/\bfund\s?rais|\bqip\b|preferential (issue|allotment)/i, "Fund raise"],
];

// Both the abbreviation and the full name, because headlines use either
// ("28 Aug" and "28th August"). Deliberately an explicit list rather than
// `(aug)[a-z]*`: that would let "maybe 3" parse as May 3.
const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sept: 8, sep: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11,
};
// Longest first so "August" wins over "aug" and leaves no trailing letters.
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
// A date more than this far behind us is read as next year's: these are
// forward-looking corporate events, so a bare "15 Feb" seen in August means the
// coming February, not the one that has passed.
const PAST_TOLERANCE_MS = 30 * 86400000;

/**
 * Pull a date out of a headline: "results on 28 Aug", "board meeting Sept 3",
 * "28 August 2026". Returns an ISO date or null.
 *
 * Year is inferred, not assumed: a bare "28 Aug" seen in December means next
 * year, so a month more than ~6 months behind rolls forward.
 */
export function parseEventDate(text, now = Date.now()) {
  if (!text) return null;
  const t = String(text);
  const re = new RegExp(
    String.raw`\b(?:(\d{1,2})\s*(?:st|nd|rd|th)?\s+(${MONTH_ALT})|` +
      String.raw`(${MONTH_ALT})\.?\s+(\d{1,2})(?:\s*(?:st|nd|rd|th))?)\b\s*,?\s*(\d{4})?`,
    "i",
  );
  const m = t.match(re);
  if (!m) return null;
  const day = Number(m[1] ?? m[4]);
  const monKey = String(m[2] ?? m[3]).toLowerCase();
  const mon = MONTHS[monKey];
  if (!(day >= 1 && day <= 31) || mon == null) return null;

  const ref = new Date(now);
  let year = m[5] ? Number(m[5]) : ref.getUTCFullYear();
  if (!m[5]) {
    // No year given — pick the nearest sensible one rather than assuming "this".
    const candidate = Date.UTC(year, mon, day);
    if (candidate < now - PAST_TOLERANCE_MS) year += 1;
    else if (candidate > now + 300 * 86400000) year -= 1;
  }
  const d = new Date(Date.UTC(year, mon, day));
  if (d.getUTCMonth() !== mon || d.getUTCDate() !== day) return null; // e.g. 31 Feb
  return d.toISOString().slice(0, 10);
}

/** Classify a headline as a corporate event, or null if it isn't one. */
export function classifyEvent(text) {
  for (const [re, kind] of EVENT_KINDS) if (re.test(text)) return kind;
  return null;
}

const NAME_NOISE = /\b(ltd|limited|india|indian|industries|corporation|corp|company|co|the|and|&)\b/g;

export const nameWords = (name) =>
  String(name || "").toLowerCase().replace(NAME_NOISE, " ").split(/[^a-z0-9]+/).filter((w) => w.length >= 4);

/**
 * The name with only truly generic tokens removed — "Reliance Industries Ltd" →
 * "reliance industries". Used as the qualifier for a shared house name, where
 * the corporate word is precisely what tells the siblings apart, so it must NOT
 * be stripped the way `nameWords` strips it.
 */
export const fullNameKey = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/\b(ltd|limited|the|and|&)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Business-house names whose OTHER listed arms are not in the F&O universe, so
 * counting universe entries can't discover them. Only Reliance Industries is in
 * F&O, yet "Reliance Power Q1 results" matched it live — hence this supplement.
 * Keep it to houses with several listed entities; it costs precision to add a
 * name that isn't genuinely shared.
 */
const HOUSE_NAMES = ["reliance", "birla", "mahindra", "hinduja"];

/**
 * First words shared by more than one company, so a bare mention of them can't
 * identify a specific issuer — "adani", "bajaj", "tata", "godrej" fall out of
 * the universe itself, and HOUSE_NAMES covers the rest. Derived rather than
 * hardcoded wherever possible, so it stays right as the F&O list changes.
 */
export function ambiguousFirstWords(stocks) {
  const counts = new Map();
  for (const [, name] of stocks) {
    const w = nameWords(name)[0];
    if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const derived = [...counts.entries()].filter(([, n]) => n > 1).map(([w]) => w);
  return new Set([...derived, ...HOUSE_NAMES]);
}

/**
 * Does this item actually talk about THIS company? Google News honours an OR
 * query loosely, so the guard matters twice over:
 *
 *  - unrelated market chatter that names nobody must be dropped;
 *  - and a shared first word must not carry another company's news across.
 *    Matching any distinctive word once filed "Reliance Power Q1 results" under
 *    RELIANCE. So when the leading word is shared inside the universe, the full
 *    name or the exact ticker is required.
 */
export function mentionsCompany(text, symbol, name, ambiguous = new Set()) {
  const raw = String(text || "");
  const hay = raw.toLowerCase();
  const ticker = symbol.replace(/[^A-Za-z0-9]/g, "");
  // The ticker is matched CASE-SENSITIVELY. Headlines write tickers in caps
  // ("RELIANCE gains 2%") and company names in title case ("Reliance Power"),
  // and for a house name the lowercased ticker IS the ambiguous word — so a
  // case-insensitive test here would wave through exactly what we're excluding.
  if (new RegExp(`\\b${ticker}\\b`).test(raw)) return true;
  const words = nameWords(name);
  if (!words.length) return false;
  if (ambiguous.has(words[0])) {
    // Needs the qualifier too: "reliance industries", not bare "reliance".
    const key = fullNameKey(name);
    return key.includes(" ") ? hay.includes(key) : false;
  }
  return words.some((w) => hay.includes(w));
}

/**
 * Drop events that have gone by. Cached events are carried forward between runs
 * (news is only re-fetched for a few names each build), so without pruning a
 * past event would linger indefinitely — and the first live run showed exactly
 * that, with NSE's full history back to 2005 stuck in the file. Pruning runs on
 * EVERY build, not just ones that fetch, so stale entries clear themselves out.
 */
export function pruneEvents(events, now = Date.now(), keepPastMs = 7 * 86400000) {
  return (Array.isArray(events) ? events : []).filter((e) => {
    if (!e || !e.kind) return false;
    if (!e.date) return true; // undated: can't tell, keep until something dates it
    return Date.parse(`${e.date}T00:00:00Z`) >= now - keepPastMs;
  });
}

/** Merge event lists, keeping the most precise entry per (kind, date). */
export function mergeEvents(...lists) {
  const out = new Map();
  const rank = { nse: 3, news: 2, options: 1 };
  for (const ev of lists.flat()) {
    if (!ev || !ev.kind) continue;
    const key = `${ev.kind}|${ev.date ?? "?"}`;
    const prev = out.get(key);
    // Prefer a dated entry over an undated one, then the more authoritative source.
    if (
      !prev ||
      (ev.date && !prev.date) ||
      (!!ev.date === !!prev.date && (rank[ev.source] ?? 0) > (rank[prev.source] ?? 0))
    ) {
      out.set(key, ev);
    }
  }
  // An undated entry is redundant once the same kind has a date.
  const dated = new Set([...out.values()].filter((e) => e.date).map((e) => e.kind));
  return [...out.values()]
    .filter((e) => e.date || !dated.has(e.kind))
    .sort((a, b) => (a.date ?? "9999") < (b.date ?? "9999") ? -1 : 1);
}

/**
 * The options market's own view that something is scheduled: when the near
 * expiry's ATM IV sits well above the far one, an event is being priced before
 * the near date. Costs nothing and is the only source that never fails.
 */
export function impliedEvent(termSlope, nearExpiry, minPts = 2) {
  if (termSlope == null || !(termSlope > minPts) || !nearExpiry) return null;
  return {
    kind: "Event priced in",
    title: `Options are pricing an event before ${nearExpiry} — front-month IV is ${termSlope} vol points over the next expiry.`,
    date: nearExpiry,
    approx: true, // a window, not a calendar entry
    source: "options",
  };
}

function parseRssItems(xml) {
  const out = [];
  for (const block of String(xml).split("<item>").slice(1)) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1] : "";
    };
    let title = decodeEntities(stripTags(get("title")));
    const link = decodeEntities(stripTags(get("link")));
    const desc = decodeEntities(stripTags(get("description")));
    const srcM = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    let source = srcM ? decodeEntities(stripTags(srcM[1])) : "";
    if (!source && / - [^-]{2,40}$/.test(title)) {
      const i = title.lastIndexOf(" - ");
      source = title.slice(i + 3);
      title = title.slice(0, i);
    } else if (source && title.endsWith(" - " + source)) {
      title = title.slice(0, -(source.length + 3));
    }
    if (!title || !link) continue;
    const pubMs = get("pubDate") ? new Date(get("pubDate")).getTime() : Date.now();
    out.push({ title, link, desc, source: source || "News", pubMs: Number.isFinite(pubMs) ? pubMs : Date.now() });
  }
  return out;
}

/**
 * News + news-derived events for one company. Two queries: a general one and a
 * trusted-outlet one, so Moneycontrol/ET/Mint coverage is reached without a
 * bespoke scraper for each site.
 */
let AMBIGUOUS = null; // computed once from the universe, on first use

export async function fetchStockNews(symbol, name, { now = Date.now() } = {}) {
  AMBIGUOUS ??= ambiguousFirstWords(STOCKS);
  const company = `"${name}" OR "${symbol}"`;
  const queries = [
    `${company} (share OR shares OR stock OR results OR order OR profit OR revenue OR stake OR deal)`,
    `${company} (${SOURCES.map((s) => `source:"${s}"`).join(" OR ")})`,
  ];
  const cutoff = now - MAX_AGE_MS;
  const items = [];
  const seen = new Set();

  for (const q of queries) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
    try {
      const raw = parseRssItems(await getText(url, { headers: RSS_HEADERS }));
      for (const r of raw) {
        if (r.pubMs < cutoff) continue;
        const text = `${r.title} ${r.desc}`;
        if (!mentionsCompany(text, symbol, name, AMBIGUOUS)) continue;
        const key = r.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          title: r.title,
          url: r.link,
          source: r.source,
          trusted: isTrusted(r.source),
          publishedAt: new Date(r.pubMs).toISOString(),
          snippet: r.desc.slice(0, 180),
          impact: tagImpact(text),
        });
      }
    } catch (e) {
      console.warn(`stock news ${symbol}: ${e.message}`);
    }
  }

  // Trusted sources first, then recency.
  items.sort((a, b) => (a.trusted === b.trusted ? (a.publishedAt < b.publishedAt ? 1 : -1) : a.trusted ? -1 : 1));
  const news = items.slice(0, MAX_ITEMS);

  const events = [];
  for (const n of news) {
    const kind = classifyEvent(`${n.title} ${n.snippet}`);
    if (!kind) continue;
    const date = parseEventDate(`${n.title} ${n.snippet}`, now);
    // Only forward-looking dates are useful for an expiry decision.
    if (date && Date.parse(`${date}T00:00:00Z`) < now - 86400000) continue;
    events.push({ kind, title: n.title, date, approx: !date, source: "news", url: n.url });
  }

  return { news, events };
}
