// ---------------------------------------------------------------------------
// Upstox market-data integration for NSE index options (read-only). Uses the
// 1-year "Analytics" access token (UPSTOX_ACCESS_TOKEN) — no daily re-auth.
//
// Thin fetchers + pure helpers. All return null/[] on failure so the caller
// can fall back to the NSE public API or last-good data. Endpoints per
// Upstox API v2.
// ---------------------------------------------------------------------------

import { gunzipSync } from "node:zlib";

const BASE = "https://api.upstox.com/v2";
const INSTRUMENTS_NSE = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const INSTRUMENTS_BSE = "https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz";
const INSTRUMENTS_ALL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/**
 * Fetch + gunzip the instrument master for an exchange ("NSE" | "BSE"),
 * falling back to the combined `complete.json.gz`. BSE is needed for SENSEX
 * (BSE F&O); NSE covers NIFTY/BANKNIFTY.
 */
export async function fetchInstruments(exchange = "NSE") {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/gzip, application/octet-stream, application/json, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://upstox.com/",
  };
  const primary = exchange === "BSE" ? INSTRUMENTS_BSE : INSTRUMENTS_NSE;
  for (const url of [primary, INSTRUMENTS_ALL]) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const gz = buf[0] === 0x1f && buf[1] === 0x8b;
      if (!gz && (buf[0] === 0x3c /* '<' */ || buf.length < 100)) {
        throw new Error("blocked (HTML/empty response)");
      }
      const text = gz ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
      const arr = JSON.parse(text);
      if (Array.isArray(arr) && arr.length) {
        console.log(`upstox instruments: ${arr.length} from ${url}`);
        return arr;
      }
    } catch (e) {
      console.warn(`upstox instruments ${url}: ${e.message}`);
    }
  }
  return [];
}

function expiryToIso(e) {
  if (e == null) return null;
  if (typeof e === "number") return new Date(e).toISOString().slice(0, 10);
  const s = String(e);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(Number(s) || s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const norm = (r) => {
  const type = String(r.instrument_type ?? r.instrumentType ?? "").toUpperCase();
  return {
    key: r.instrument_key ?? r.instrumentKey,
    underlyingKey: r.underlying_key ?? r.underlyingKey ?? null,
    assetSymbol: String(r.asset_symbol ?? r.assetSymbol ?? r.name ?? "").toUpperCase(),
    segment: String(r.segment ?? "").toUpperCase(),
    type,
    isFuture: type.includes("FUT"),
    isOption: type === "CE" || type === "PE",
    expiry: expiryToIso(r.expiry),
    strike: Number(r.strike_price ?? r.strikePrice ?? 0) || 0,
    lotSize: Number(r.lot_size ?? r.lotSize ?? 0) || 0,
  };
};

/**
 * Resolve NSE cash-equity instrument keys for a list of trading symbols
 * (e.g. RELIANCE, HDFCBANK) from the instrument master. Returns
 * { SYMBOL: instrument_key }.
 */
export function pickEquityKeys(instruments, symbols) {
  const want = new Set(symbols.map((s) => s.toUpperCase()));
  const out = {};
  for (const r of instruments) {
    const seg = String(r.segment ?? "").toUpperCase();
    if (seg !== "NSE_EQ") continue;
    const ts = String(r.trading_symbol ?? r.tradingsymbol ?? "").toUpperCase();
    const type = String(r.instrument_type ?? r.instrumentType ?? "").toUpperCase();
    if (want.has(ts) && !out[ts] && (type === "EQ" || type === "" )) {
      out[ts] = r.instrument_key ?? r.instrumentKey;
    }
  }
  return out;
}

/**
 * Contract discovery for an index (e.g. NIFTY): upcoming option expiries,
 * front-month future, lot size. `foSegment` is "NSE_FO" (or "BSE_FO" for
 * SENSEX later).
 */
export function pickIndex(instruments, assetSymbol, foSegment, todayIso) {
  const sym = assetSymbol.toUpperCase();
  const rows = instruments
    .map(norm)
    .filter((r) => r.key && r.segment === foSegment && r.assetSymbol === sym);
  if (!rows.length) return null;
  const optRows = rows.filter((r) => r.isOption && r.expiry && r.strike > 0);
  const optionExpiries = [...new Set(optRows.map((r) => r.expiry))]
    .sort()
    .filter((e) => e >= todayIso);
  const futs = rows.filter((r) => r.isFuture && r.expiry && r.expiry >= todayIso);
  const future = futs.sort((a, b) => (a.expiry < b.expiry ? -1 : 1))[0] ?? null;
  const lotSize = optRows.find((r) => r.lotSize > 0)?.lotSize ?? future?.lotSize ?? null;
  return { optionExpiries, future, lotSize };
}

/**
 * Option chain for an index underlying at one expiry, normalized to flat rows:
 * { strike, type, ltp, iv, oi, prevOi, volume, delta, theta, pop }.
 * Also returns the spot the exchange stamped on the chain.
 */
export async function optionChain(token, underlyingKey, expiryIso) {
  const url = `${BASE}/option/chain?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${expiryIso}`;
  try {
    const j = await getJson(url, { headers: authHeaders(token) });
    const rows = j?.data ?? [];
    const chain = [];
    let spot = null;
    for (const r of rows) {
      const strike = Number(r.strike_price ?? r.strikePrice);
      const us = Number(r.underlying_spot_price);
      if (Number.isFinite(us) && us > 0) spot = us;
      for (const side of ["call_options", "put_options"]) {
        const o = r[side];
        if (!o) continue;
        const md = o.market_data ?? {};
        const gk = o.option_greeks ?? {};
        const ltp = Number(md.ltp ?? md.last_price);
        if (!Number.isFinite(strike) || strike <= 0) continue;
        const oi = Number(md.oi ?? 0) || 0;
        // Skip strikes with neither a price nor open interest — dead wings.
        if (!(ltp > 0) && !(oi > 0)) continue;
        chain.push({
          strike,
          type: side === "call_options" ? "CE" : "PE",
          ltp: ltp > 0 ? ltp : null,
          iv: Number.isFinite(Number(gk.iv)) && Number(gk.iv) > 0 ? Number(gk.iv) / 100 : null, // Upstox IV is in %
          oi,
          prevOi: Number.isFinite(Number(md.prev_oi)) ? Number(md.prev_oi) : null,
          volume: Number(md.volume ?? 0) || 0,
          delta: Number.isFinite(Number(gk.delta)) ? Number(gk.delta) : null,
          theta: Number.isFinite(Number(gk.theta)) ? Number(gk.theta) : null,
          pop: Number.isFinite(Number(gk.pop)) ? Number(gk.pop) : null,
        });
      }
    }
    return { chain, spot };
  } catch (e) {
    console.warn(`upstox option chain ${expiryIso}: ${e.message}`);
    return { chain: [], spot: null };
  }
}

/** Live quotes keyed by instrument key -> { lastPrice, prevClose, oi }. */
export async function quotes(token, instrumentKeys) {
  const keys = Array.isArray(instrumentKeys) ? instrumentKeys : [instrumentKeys];
  const url = `${BASE}/market-quote/quotes?instrument_key=${encodeURIComponent(keys.join(","))}`;
  try {
    const j = await getJson(url, { headers: authHeaders(token) });
    const out = {};
    for (const v of Object.values(j?.data ?? {})) {
      const k = v?.instrument_token ?? v?.instrument_key;
      if (!k) continue;
      out[k] = {
        lastPrice: Number(v.last_price) || null,
        prevClose: Number(v?.ohlc?.close) || null,
        netChange: Number.isFinite(Number(v.net_change)) ? Number(v.net_change) : null,
        oi: Number(v.oi) || null,
      };
    }
    return out;
  } catch (e) {
    console.warn(`upstox quotes: ${e.message}`);
    return {};
  }
}

/**
 * Daily history for an instrument. Returns
 * { history:[{t,v}], oiHistory:[{t,v}], ohlc:[{t,o,h,l,c,v}] } oldest-first.
 *
 * `oiHistory` is populated for futures (candle field 6); it's empty for indices,
 * which carry no open interest. `ohlc` carries the full bar the API already
 * sends — the stock screener needs open/high/low for gap-aware (Yang-Zhang)
 * realized vol, and it costs nothing extra to keep. `history` stays
 * close-only so the index pipeline is untouched.
 */
export async function dailyCandles(token, instrumentKey, fromIso, toIso) {
  const url = `${BASE}/historical-candle/${encodeURIComponent(instrumentKey)}/day/${toIso}/${fromIso}`;
  try {
    const j = await getJson(url, { headers: authHeaders(token) });
    const candles = j?.data?.candles ?? [];
    // Each candle: [timestamp, open, high, low, close, volume, oi] (newest first).
    const history = [];
    const oiHistory = [];
    const ohlc = [];
    for (const c of candles) {
      const t = String(c[0]).slice(0, 10);
      const [o, h, l, close] = [Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4])];
      if (Number.isFinite(close) && close > 0) history.push({ t, v: close });
      if ([o, h, l, close].every((x) => Number.isFinite(x) && x > 0) && h >= l) {
        ohlc.push({ t, o, h, l, c: close, v: Number(c[5]) || 0 });
      }
      if (c[6] != null && Number.isFinite(Number(c[6])) && Number(c[6]) > 0) oiHistory.push({ t, v: Number(c[6]) });
    }
    history.reverse();
    oiHistory.reverse();
    ohlc.reverse();
    return { history, oiHistory, ohlc };
  } catch (e) {
    console.warn(`upstox candles ${instrumentKey}: ${e.message}`);
    return { history: [], oiHistory: [], ohlc: [] };
  }
}
