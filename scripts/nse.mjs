// ---------------------------------------------------------------------------
// NSE public option-chain API — the free, token-less fallback source.
//
// nseindia.com sits behind Akamai bot protection: a cookie-priming GET on the
// HTML page usually earns a session that the /api/* endpoints accept. From
// GitHub Actions runners this works intermittently — every helper fails soft
// (returns null) so the builder can keep last-good data instead.
//
// IV from NSE is annualized % (e.g. 12.5); OI/volume are in contracts.
// ---------------------------------------------------------------------------

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/option-chain",
};

async function primeCookies() {
  try {
    const r = await fetch("https://www.nseindia.com/option-chain", {
      headers: { ...HEADERS, Accept: "text/html,*/*" },
    });
    const cookies = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
    return cookies.length ? cookies.join("; ") : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the NIFTY (or BANKNIFTY) chain from NSE and normalize it to the same
 * flat shape as the Upstox path. Returns null on any failure.
 * `symbol`: "NIFTY" | "BANKNIFTY" | "FINNIFTY" …
 */
export async function fetchNseChain(symbol) {
  const cookie = await primeCookies();
  const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`;
  try {
    const res = await fetch(url, { headers: cookie ? { ...HEADERS, Cookie: cookie } : HEADERS });
    if (!res.ok) throw new Error(`-> ${res.status}`);
    const j = await res.json();
    const all = j?.records?.data ?? [];
    const expiries = (j?.records?.expiryDates ?? [])
      .map(nseDateToIso)
      .filter(Boolean)
      .sort();
    if (!all.length || !expiries.length) throw new Error("empty payload");
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = expiries.filter((e) => e >= today);
    const expiry = upcoming[0] ?? expiries[expiries.length - 1];
    const spot = Number(j?.records?.underlyingValue) || null;
    const chain = [];
    for (const row of all) {
      if (nseDateToIso(row.expiryDate) !== expiry) continue;
      for (const [side, type] of [["CE", "CE"], ["PE", "PE"]]) {
        const o = row[side];
        if (!o) continue;
        const oi = Number(o.openInterest ?? 0) || 0;
        const ltp = Number(o.lastPrice) || null;
        if (!(ltp > 0) && !(oi > 0)) continue;
        const chg = Number(o.changeinOpenInterest);
        chain.push({
          strike: Number(row.strikePrice),
          type,
          ltp,
          iv: Number(o.impliedVolatility) > 0 ? Number(o.impliedVolatility) / 100 : null,
          oi,
          prevOi: Number.isFinite(chg) ? oi - chg : null,
          volume: Number(o.totalTradedVolume ?? 0) || 0,
          delta: null,
          theta: null,
          pop: null,
        });
      }
    }
    if (!chain.length) throw new Error("no rows for nearest expiry");
    console.log(`nse: ${symbol} chain ${chain.length} rows, expiry ${expiry}, spot ${spot}`);
    return { chain, spot, expiry, optionExpiries: upcoming };
  } catch (e) {
    console.warn(`nse chain ${symbol}: ${e.message}`);
    return null;
  }
}

/** "24-Jul-2026" -> "2026-07-24" */
function nseDateToIso(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const mm = months[m[2]];
  return mm ? `${m[3]}-${mm}-${m[1].padStart(2, "0")}` : null;
}

/** India VIX from the NSE all-indices endpoint. Returns null on failure. */
export async function fetchNseVix() {
  const cookie = await primeCookies();
  try {
    const res = await fetch("https://www.nseindia.com/api/allIndices", {
      headers: cookie ? { ...HEADERS, Cookie: cookie } : HEADERS,
    });
    if (!res.ok) throw new Error(`-> ${res.status}`);
    const j = await res.json();
    const vix = (j?.data ?? []).find((d) => /india vix/i.test(d.index ?? d.indexSymbol ?? ""));
    const v = Number(vix?.last ?? vix?.lastPrice);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch (e) {
    console.warn(`nse vix: ${e.message}`);
    return null;
  }
}

// Yahoo Finance v8 chart API — keyless daily history (server-side only).
// Used for index/VIX history when Upstox is unavailable. ^NSEI / ^INDIAVIX.
export async function yahooHistory(symbol, range = "1y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0" } });
    if (!res.ok) throw new Error(`-> ${res.status}`);
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const closes = r?.indicators?.quote?.[0]?.close ?? [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const v = closes[i];
      if (Number.isFinite(v) && v > 0) out.push({ t: new Date(ts[i] * 1000).toISOString().slice(0, 10), v });
    }
    return out;
  } catch (e) {
    console.warn(`yahoo ${symbol}: ${e.message}`);
    return [];
  }
}

/**
 * Upcoming corporate events for one symbol from NSE's event calendar —
 * board meetings, results, dividends, with EXACT dates, which none of the other
 * sources can give. Behind the same Akamai protection as the chain endpoints and
 * about as reliable from a runner, so it fails soft to [] and is treated as one
 * of several event sources rather than the truth.
 */
export async function fetchEventCalendar(symbol) {
  const cookie = await primeCookies();
  const url = `https://www.nseindia.com/api/event-calendar?symbol=${encodeURIComponent(symbol)}`;
  try {
    const res = await fetch(url, { headers: cookie ? { ...HEADERS, Cookie: cookie } : HEADERS });
    if (!res.ok) throw new Error(String(res.status));
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const r of rows) {
      // NSE returns dd-MMM-yyyy; purpose is free text ("Quarterly Results").
      const raw = String(r?.date ?? r?.eventDate ?? "").trim();
      const d = raw ? new Date(raw) : null;
      const date = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
      const purpose = String(r?.purpose ?? r?.subject ?? "").trim();
      if (!purpose) continue;
      out.push({
        kind: /result/i.test(purpose) ? "Results" : /board/i.test(purpose) ? "Board meeting" : purpose.slice(0, 40),
        title: purpose,
        date,
        approx: false,
        source: "nse",
      });
    }
    return out;
  } catch (e) {
    console.warn(`nse event calendar ${symbol}: ${e.message}`);
    return [];
  }
}
