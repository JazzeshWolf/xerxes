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
// Plus two more NSE feeds riding the same session: corporate actions (ex-dates
// for dividends, bonus, splits) and the exchange filings themselves — con-call
// schedules, shareholder-meeting notices, order wins. Filings are kept as their
// own list too, since they are the primary source the headlines come from.
//
// Imports only Node-free modules (rss.mjs, nse.mjs, the universe) so the
// refresh Worker can bundle this file and serve the same thing live.
// They are merged and deduped, so a run where three of them fail still shows
// something useful.
//
// Everything fails soft to empty — a stock with no news is normal, not an error.
// ---------------------------------------------------------------------------

import { getText, stripTags, decodeEntities, tagImpact, isTrusted } from "./rss.mjs";
import { STOCKS } from "./stocks-universe.mjs";
import * as nse from "./nse.mjs";

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
  // Ahead of Results: "Q2 earnings call on 16 Oct" is the call, not the filing.
  [/earnings (conference )?call|con(ference)?\.?[- ]?call|analysts?(\/institutional)? (investor )?meet|investors? meet/i, "Earnings call"],
  [/\b(q[1-4]|quarterly|half[- ]year|annual)\s+(results|earnings)|results? (date|on|announce)/i, "Results"],
  [/board meeting/i, "Board meeting"],
  [/\bdividend\b/i, "Dividend"],
  [/buy[- ]?back/i, "Buyback"],
  [/\begm\b|extra[- ]?ordinary general meeting/i, "EGM"],
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

/**
 * Re-apply the relevance guard (and the age cut) to CACHED news. News is only
 * re-fetched for a few names per build, so a stored item outlives many runs —
 * without this, headlines admitted by an older, looser guard stay on the page
 * forever. Seen live: "Reliance Power Q1 Results" persisted on RELIANCE after
 * `mentionsCompany` had been tightened, because that name wasn't due a refetch.
 */
export function pruneNews(news, symbol, name, { now = Date.now() } = {}) {
  AMBIGUOUS ??= ambiguousFirstWords(STOCKS);
  const cutoff = now - MAX_AGE_MS;
  return (Array.isArray(news) ? news : []).filter(
    (n) =>
      n?.title &&
      Date.parse(n.publishedAt) >= cutoff &&
      mentionsCompany(`${n.title} ${n.snippet ?? ""}`, symbol, name, AMBIGUOUS),
  );
}

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

// --- NSE corporate actions + filings -----------------------------------------

const MON3 = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * NSE's dates, in the shapes its APIs actually use: "25-Oct-2024",
 * "09-Oct-2026 18:30:12" and "2026-10-09 18:30:12". Times are IST. Returns
 * epoch ms, or null for "-" and anything else unparseable. Explicit rather
 * than `new Date(str)`, whose handling of these strings is engine-dependent.
 */
export function nseTime(s) {
  const t = String(s ?? "").trim();
  let m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const mon = MON3[m[2].toLowerCase()];
    if (mon == null) return null;
    return Date.UTC(+m[3], mon, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) - IST_OFFSET_MS;
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) - IST_OFFSET_MS;
  return null;
}
const IST_OFFSET_MS = 330 * 60000;
/** The IST calendar day of an epoch, as ISO yyyy-mm-dd. */
const istDay = (ms) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * Corporate actions → events dated on the EX-date, which is the day the price
 * actually adjusts (a dividend comes off the stock that morning). Record date is
 * the fallback. Past actions older than a week are dropped, for the same reason
 * as the event calendar: NSE hands back the whole history.
 */
export function parseCorporateActions(rows, now = Date.now()) {
  const from = now - 7 * 86400000;
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const subject = String(r?.subject ?? r?.purpose ?? "").replace(/\s+/g, " ").trim();
    if (!subject) continue;
    const ms = nseTime(r?.exDate) ?? nseTime(r?.recDate);
    if (ms == null || ms < from) continue;
    // NSE subjects are terse ("Bonus 1:1"), so the filing vocabulary fits them
    // better than the headline one.
    const kind = classifyFiling(subject) ?? classifyEvent(subject) ?? "Corporate action";
    out.push({ kind, title: `Ex-date: ${subject}`, date: istDay(ms), approx: false, source: "nse" });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 6);
}

/**
 * Exchange filings worth a seller's attention, in order of precedence. Anything
 * matching none of these is routine paperwork and is dropped. Housekeeping is
 * screened out FIRST: a trading-window notice says "…for the purpose of
 * financial results" and would otherwise file itself under Results.
 */
const FILING_SKIP =
  /trading window|newspaper|news ?paper publication|loss of share|duplicate share|certificate under|regulation 74|reg\.? ?74|\besop\b|\besos\b|\besps\b|compliance certificate|statement of investor complaints|copy of/i;
const FILING_KINDS = [
  [/earnings (conference )?call|con(ference)?\.?[- ]?call|analysts?|institutional investor|investors? meet/i, "Earnings call"],
  [/extra[- ]?ordinary general meeting|\begm\b/i, "EGM"],
  [/annual general meeting|\bagm\b|shareholders?'? meeting/i, "AGM"],
  [/postal ballot/i, "Postal ballot"],
  [/outcome of board meeting|financial results?|results? for the (quarter|period|half|year)/i, "Results"],
  [/board meeting/i, "Board meeting"],
  [/dividend/i, "Dividend"],
  [/\bbonus\b/i, "Bonus issue"],
  [/\bsplit\b|sub-?division/i, "Stock split"],
  [/buy[- ]?back/i, "Buyback"],
  [/rights issue/i, "Rights issue"],
  [/\bqip\b|preferential (issue|allotment)|fund ?rais/i, "Fund raise"],
  [/acquisition|amalgamation|merger|demerger|scheme of arrangement|joint venture/i, "M&A"],
  [/award(ing)? of (order|contract)|bagging|receipt of (order|contract)|orders? (win|received)|letter of (award|intent)/i, "Order win"],
  [/credit rating/i, "Credit rating"],
  [/resignation|cessation|appointment of (md|ceo|cfo|managing|chief|whole)|change in (directors?|management|kmp|key managerial)/i, "Management change"],
  [/litigation|dispute|penalt|show cause|tax demand|search and seizure|\bsebi order\b|regulatory action/i, "Legal / regulatory"],
  [/press release|media release/i, "Press release"],
  [/investor presentation/i, "Investor presentation"],
];
/** "quarter ended September 30, 2026" / "half year ending 30th Sept" — a past
 *  reporting period, never the date of the meeting. Optional year. */
const PERIOD_ENDED = new RegExp(
  String.raw`(quarter|period|half[- ]year|year|month)s?\s+end(ed|ing)\s+(on\s+)?` +
    String.raw`(\d{1,2}(st|nd|rd|th)?\s+[a-z]+\.?|[a-z]+\.?\s+\d{1,2}(st|nd|rd|th)?)(\s*,?\s*\d{4})?`,
  "gi",
);
/** Kinds whose filing normally names a FUTURE date worth putting on the calendar. */
const SCHEDULED = new Set(["Earnings call", "EGM", "AGM", "Postal ballot", "Board meeting", "Results"]);

export function classifyFiling(text) {
  const t = String(text ?? "");
  if (FILING_SKIP.test(t)) return null;
  for (const [re, kind] of FILING_KINDS) if (re.test(t)) return kind;
  return null;
}

/**
 * Exchange filings → `{ filings, events }`. Filings are the recent price-
 * sensitive ones, newest first. Events are the dates they announce ahead of us
 * ("earnings call on October 16, 2026").
 *
 * The "quarter ended September 30" phrase is cut before the date is read: it
 * is the first date in almost every results-related filing, it is always in the
 * past, and without a year `parseEventDate` would roll it forward a year.
 */
export function parseAnnouncements(rows, now = Date.now(), maxAgeDays = 21) {
  const cutoff = now - maxAgeDays * 86400000;
  const filings = [];
  const events = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const desc = String(r?.desc ?? r?.subject ?? "").replace(/\s+/g, " ").trim();
    const body = String(r?.attchmntText ?? r?.text ?? "").replace(/\s+/g, " ").trim();
    const text = `${desc} ${body}`;
    const kind = classifyFiling(text);
    if (!kind) continue;
    const at = nseTime(r?.sort_date) ?? nseTime(r?.an_dt) ?? nseTime(r?.dt);
    if (at == null || at < cutoff || at > now + 86400000) continue;
    const title = (body || desc).slice(0, 220);
    const key = `${kind}|${title.toLowerCase().slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const url = /^https?:\/\//.test(String(r?.attchmntFile ?? "")) ? String(r.attchmntFile) : null;
    filings.push({ kind, title, desc, publishedAt: new Date(at).toISOString(), url, impact: tagImpact(text) });

    if (SCHEDULED.has(kind)) {
      const cleaned = text.replace(PERIOD_ENDED, " ");
      const date = parseEventDate(cleaned, now);
      const ms = date ? Date.parse(`${date}T00:00:00Z`) : null;
      // Today or later, and not absurdly far out (a misread year).
      if (ms != null && ms >= Date.parse(`${istDay(now)}T00:00:00Z`) && ms <= now + 120 * 86400000) {
        events.push({ kind, title: title.slice(0, 160), date, approx: false, source: "nse", ...(url ? { url } : {}) });
      }
    }
  }
  filings.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return { filings: filings.slice(0, 10), events };
}

/** Drop cached filings that have aged out — same carry-forward logic as news. */
export function pruneFilings(filings, now = Date.now(), maxAgeDays = 21) {
  const cutoff = now - maxAgeDays * 86400000;
  return (Array.isArray(filings) ? filings : []).filter((f) => f?.kind && Date.parse(f.publishedAt) >= cutoff);
}

/**
 * Everything the stock's News and Outlook tabs need from the outside world, in
 * one call: headlines, news-derived events, the NSE calendar, corporate-action
 * ex-dates and exchange filings. Used by the build's news rotation AND by the
 * refresh Worker's live /news endpoint, so the two can never disagree.
 *
 * `nseOk` says whether NSE answered at all. Its three feeds fail together
 * (same bot wall), and a failed pass must not be mistaken for "no events" —
 * the caller carries the previous NSE events forward when it is false.
 */
export async function fetchCompanyBundle(symbol, name, { now = Date.now() } = {}) {
  const [feed, calendar, actions, announcements] = await Promise.all([
    fetchStockNews(symbol, name, { now }).catch(() => ({ news: [], events: [] })),
    nse.fetchEventCalendar(symbol).catch(() => []),
    nse.fetchCorporateActions(symbol).catch(() => []),
    nse.fetchAnnouncements(symbol, 21, now).catch(() => []),
  ]);
  const filed = parseAnnouncements(announcements, now);
  return {
    news: feed.news,
    events: feed.events,
    nseEvents: [...calendar, ...parseCorporateActions(actions, now), ...filed.events],
    filings: filed.filings,
    nseOk: calendar.length > 0 || actions.length > 0 || announcements.length > 0,
  };
}
