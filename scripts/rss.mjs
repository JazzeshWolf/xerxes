// ---------------------------------------------------------------------------
// RSS / headline primitives shared by the macro feed (market.mjs), the
// per-stock feed (stock-news.mjs) and the refresh Worker (worker/index.js).
//
// Deliberately free of Node-only imports: market.mjs pulls in upstox.mjs and
// with it node:zlib, which a Cloudflare Worker can't bundle. Keeping these here
// lets the Worker fetch a company's news with exactly the same parsing,
// impact tagging and trusted-source list the build uses. Don't fork them.
// ---------------------------------------------------------------------------

export async function getText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

export function stripTags(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}
const BULL_KW = [/rate cut/i, /dovish/i, /fii inflow|fpi inflow|foreign inflow/i, /gst cut/i, /(strong|robust) (gdp|growth|earnings|results)/i, /results? beat|beats? estimates/i, /record high|all[- ]?time high/i, /rally|rallies|surge|soar|jump|spike|gains?/i, /upgrade/i, /buyback|order win|deal win/i, /stimulus|capex push/i, /yields? (fall|drop|ease)/i, /bull/i];
const BEAR_KW = [/rate hike/i, /hawkish/i, /fii outflow|fpi outflow|foreign outflow/i, /sell[- ]?off/i, /plunge|plummet|tumble|slump|crash|sink|slide/i, /(falls|drops|slips|declines)/i, /downgrade/i, /(weak|miss) (results|earnings)|misses? estimates/i, /recession|slowdown/i, /profit[- ]?taking|correction/i, /yields? (rise|jump|climb)/i, /bear/i];
export function tagImpact(text) {
  let b = 0, r = 0;
  for (const re of BULL_KW) if (re.test(text)) b++;
  for (const re of BEAR_KW) if (re.test(text)) r++;
  return b > r ? "up" : r > b ? "down" : "twoway";
}
const TRUSTED = [/reuters/i, /bloomberg/i, /zee\s*business/i, /economic times/i, /livemint|^mint$|\bmint\b/i, /moneycontrol/i, /business standard/i, /ndtv profit/i, /cnbc/i, /financial express/i, /businessline|hindu business/i, /marketwatch/i, /wall street journal|wsj/i, /financial times/i, /investing\.com/i];
export const isTrusted = (s) => TRUSTED.some((re) => re.test(s || ""));

