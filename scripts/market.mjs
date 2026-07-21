// ---------------------------------------------------------------------------
// Shared macro layer for all indices → public/data/market.json:
//   * events   — hardcoded 2026 event radar (RBI / FOMC / CPI / Budget)
//   * news     — Google News RSS, impact-tagged (free, no key)
//   * drivers  — index heavyweights: weight × day-move = contribution to the
//                index move (shows broad vs narrow leadership)
// Everything fails soft (returns []/{}), so a bad fetch never breaks the build.
// ---------------------------------------------------------------------------

import * as upstox from "./upstox.mjs";

async function getText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

// --- Event radar (hardcoded 2026 calendar; dates approximate where noted) ----
export function buildEvents() {
  const RBI = ["2026-02-06", "2026-04-08", "2026-06-05", "2026-08-05", "2026-10-01", "2026-12-04"];
  const FOMC = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];
  const US_CPI = ["2026-07-10", "2026-08-12", "2026-09-11", "2026-10-13", "2026-11-12", "2026-12-10"];
  const IN_CPI = ["2026-07-14", "2026-08-12", "2026-09-14", "2026-10-13", "2026-11-12", "2026-12-14"];
  const events = [];
  for (const d of RBI) events.push({ name: "RBI MPC", date: d, kind: "rbi", weight: 3, effect: "Rate/stance decision — a cut or dovish tone lifts rate-sensitives (banks, autos); a hawkish hold pressures them." });
  for (const d of FOMC) events.push({ name: "US Fed (FOMC)", date: d, kind: "fomc", weight: 3, effect: "Sets global risk appetite & the dollar — dovish → FII inflows to India; hawkish → outflows, INR pressure." });
  for (const d of US_CPI) events.push({ name: "US CPI", date: d, kind: "us_cpi", weight: 2, effect: "Hot CPI → higher-for-longer rates, risk-off for EM equities; cool CPI → supportive. (Date approx.)" });
  for (const d of IN_CPI) events.push({ name: "India CPI", date: d, kind: "in_cpi", weight: 2, effect: "Feeds the RBI's next move — cooler inflation opens room to cut. (Date approx.)" });
  events.push({ name: "Union Budget", date: "2026-02-01", kind: "budget", weight: 3, effect: "Fiscal stance, capex & taxes — a high-volatility session for the whole market." });

  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  return events
    .filter((e) => e.date >= today && e.date <= horizon)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, 8);
}

// --- News (Google News RSS, impact-tagged) ----------------------------------
function stripTags(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}
const BULL_KW = [/rate cut/i, /dovish/i, /fii inflow|fpi inflow|foreign inflow/i, /gst cut/i, /(strong|robust) (gdp|growth|earnings|results)/i, /results? beat|beats? estimates/i, /record high|all[- ]?time high/i, /rally|rallies|surge|soar|jump|spike|gains?/i, /upgrade/i, /buyback|order win|deal win/i, /stimulus|capex push/i, /yields? (fall|drop|ease)/i, /bull/i];
const BEAR_KW = [/rate hike/i, /hawkish/i, /fii outflow|fpi outflow|foreign outflow/i, /sell[- ]?off/i, /plunge|plummet|tumble|slump|crash|sink|slide/i, /(falls|drops|slips|declines)/i, /downgrade/i, /(weak|miss) (results|earnings)|misses? estimates/i, /recession|slowdown/i, /profit[- ]?taking|correction/i, /yields? (rise|jump|climb)/i, /bear/i];
function tagImpact(text) {
  let b = 0, r = 0;
  for (const re of BULL_KW) if (re.test(text)) b++;
  for (const re of BEAR_KW) if (re.test(text)) r++;
  return b > r ? "up" : r > b ? "down" : "twoway";
}
const TRUSTED = [/reuters/i, /bloomberg/i, /zee\s*business/i, /economic times/i, /livemint|^mint$|\bmint\b/i, /moneycontrol/i, /business standard/i, /ndtv profit/i, /cnbc/i, /financial express/i, /businessline|hindu business/i, /marketwatch/i, /wall street journal|wsj/i, /financial times/i, /investing\.com/i];
const isTrusted = (s) => TRUSTED.some((re) => re.test(s || ""));

export async function fetchNews(prevNews) {
  const queries = [
    `https://news.google.com/rss/search?q=${encodeURIComponent("Nifty OR Sensex OR Bank Nifty OR Indian stock market")}&hl=en-IN&gl=IN&ceid=IN:en`,
    `https://news.google.com/rss/search?q=${encodeURIComponent("Nifty outlook OR FII DII flows OR RBI policy OR India inflation")}&hl=en-IN&gl=IN&ceid=IN:en`,
    `https://news.google.com/rss/search?q=${encodeURIComponent('Nifty (source:Reuters OR source:"Economic Times" OR source:Mint OR source:Moneycontrol OR source:"Zee Business")')}&hl=en-IN&gl=IN&ceid=IN:en`,
    `https://news.google.com/rss/search?q=${encodeURIComponent("Federal Reserve rate OR US inflation CPI OR dollar index OR global markets")}&hl=en-US&gl=US&ceid=US:en`,
  ];
  const MAX_AGE_MS = 16 * 86400000;
  const cutoff = Date.now() - MAX_AGE_MS;
  const DIRECT = /nifty|sensex|bank nifty|indian (stock|market|equities)|dalal street|\bfii\b|\bdii\b|\bfpi\b/i;
  const INDIRECT = /federal reserve|fomc|rate (cut|hike|decision)|inflation|\bcpi\b|dollar index|treasury yield|crude|geopolit|global markets|\brbi\b/i;
  const items = [];
  const seen = new Set();
  for (const url of queries) {
    try {
      const xml = await getText(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/rss+xml,application/xml" } });
      for (const block of xml.split("<item>").slice(1)) {
        const get = (tag) => { const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? m[1] : ""; };
        let title = decodeEntities(stripTags(get("title")));
        const link = decodeEntities(stripTags(get("link")));
        const pub = get("pubDate");
        const desc = decodeEntities(stripTags(get("description")));
        const srcM = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
        let source = srcM ? decodeEntities(stripTags(srcM[1])) : "";
        if (!source && / - [^-]{2,40}$/.test(title)) { const i = title.lastIndexOf(" - "); source = title.slice(i + 3); title = title.slice(0, i); }
        else if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
        if (!title || !link) continue;
        const pubMs = pub ? new Date(pub).getTime() : Date.now();
        if (Number.isFinite(pubMs) && pubMs < cutoff) continue;
        const text = `${title} ${desc}`;
        const direct = DIRECT.test(text);
        if (!direct && !INDIRECT.test(text)) continue;
        const key = title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ title, url: link, source: source || "News", trusted: isTrusted(source), indirect: !direct, publishedAt: new Date(Number.isFinite(pubMs) ? pubMs : Date.now()).toISOString(), snippet: desc.slice(0, 180), impact: tagImpact(text) });
      }
    } catch (e) {
      console.warn(`news ${url.slice(0, 48)}: ${e.message}`);
    }
  }
  items.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const MAX_INDIRECT = 5;
  let ind = 0;
  const pick = (list, acc) => {
    for (const i of list) {
      if (acc.length >= 15) break;
      if (i.indirect) { if (ind >= MAX_INDIRECT) continue; ind++; }
      acc.push(i);
    }
    return acc;
  };
  const out = pick(items.filter((i) => !i.trusted), pick(items.filter((i) => i.trusted), []));
  const prevFresh = (prevNews ?? []).filter((n) => new Date(n.publishedAt).getTime() >= cutoff);
  console.log(`news: ${out.length} items (${out.filter((i) => i.trusted).length} trusted)`);
  return out.length ? out : prevFresh;
}

// --- Heavyweight drivers ----------------------------------------------------
// Approximate free-float index weights (%). Slow-changing — refresh a few times
// a year. Contribution = weight × the stock's day return.
export const CONSTITUENTS = {
  NIFTY: [
    ["HDFCBANK", 13.2], ["RELIANCE", 9.2], ["ICICIBANK", 8.6], ["INFY", 5.6], ["TCS", 3.9],
    ["BHARTIARTL", 4.2], ["LT", 3.6], ["ITC", 3.7], ["AXISBANK", 3.1], ["SBIN", 3.0],
    ["KOTAKBANK", 2.6], ["HINDUNILVR", 2.3],
  ],
  BANKNIFTY: [
    ["HDFCBANK", 28.0], ["ICICIBANK", 24.0], ["SBIN", 9.5], ["AXISBANK", 9.0], ["KOTAKBANK", 8.5],
    ["PNB", 2.5], ["BANKBARODA", 2.3], ["IDFCFIRSTB", 2.0], ["AUBANK", 1.8], ["FEDERALBNK", 1.7],
  ],
  SENSEX: [
    ["HDFCBANK", 15.0], ["RELIANCE", 10.5], ["ICICIBANK", 9.8], ["INFY", 6.3], ["TCS", 4.4],
    ["BHARTIARTL", 4.8], ["LT", 4.1], ["ITC", 4.2], ["AXISBANK", 3.5], ["SBIN", 3.4],
  ],
};

/** Day return % for a quote — prefer net_change, fall back to ltp vs prevClose. */
function dayPct(q) {
  if (!q) return null;
  if (q.netChange != null && q.lastPrice != null && q.lastPrice - q.netChange > 0) {
    return (q.netChange / (q.lastPrice - q.netChange)) * 100;
  }
  if (q.lastPrice != null && q.prevClose > 0) return ((q.lastPrice - q.prevClose) / q.prevClose) * 100;
  return null;
}

/** Build the driver list for every index from one batched quote call. */
export async function buildDrivers(token, nseMaster) {
  if (!token || !nseMaster?.length) return {};
  try {
    const symbols = [...new Set(Object.values(CONSTITUENTS).flat().map(([s]) => s))];
    const keyBySym = upstox.pickEquityKeys(nseMaster, symbols);
    const keys = [...new Set(Object.values(keyBySym))];
    if (!keys.length) return {};
    const q = await upstox.quotes(token, keys);
    const byKey = {};
    for (const [k, v] of Object.entries(q)) byKey[k] = v;
    // Upstox may key the response by "NSE_EQ:SYMBOL" rather than the instrument
    // key — index by both the raw key and any value carrying our symbols.
    const drivers = {};
    for (const [index, list] of Object.entries(CONSTITUENTS)) {
      const rows = [];
      for (const [sym, weight] of list) {
        const key = keyBySym[sym];
        const quote = key ? byKey[key] ?? q[`NSE_EQ:${sym}`] : q[`NSE_EQ:${sym}`];
        const pct = dayPct(quote);
        if (pct == null) continue;
        rows.push({ symbol: sym, weight, pct: Math.round(pct * 100) / 100, contribution: Math.round(weight * pct) / 100 });
      }
      rows.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
      drivers[index] = rows;
    }
    const n = Object.values(drivers).reduce((a, r) => a + r.length, 0);
    console.log(`drivers: ${n} constituent moves across ${Object.keys(drivers).length} indices`);
    return drivers;
  } catch (e) {
    console.warn(`drivers failed: ${e.message}`);
    return {};
  }
}
