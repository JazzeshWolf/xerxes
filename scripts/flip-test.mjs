// ---------------------------------------------------------------------------
// "Flip" backtest (owner's idea, 2026-11-14). When a stock alert says SELL
// X CE, don't sell it — BUY the ATM PE of the same expiry (and vice versa) at
// the open of the next 5-minute candle, and see whether +5% on the premium
// paid can be churned out intraday.
//
//   entry   open of the first 5-min candle that STARTS after the alert was sent
//   target  +5% of the premium paid (limit order: fills at the target price)
//   stop    5% / 10% / 20% / none, each simulated separately
//   exit    else squared off at the 15:15 candle's open (intraday only)
//
// Signals come from the alerts-state branch's git history: every commit of
// stocks.json / stocks-sharp.json carries `announced`, so the commit in which a
// contract first appears is the run that sent its NEW alert, and its commit
// time is when the message went out (seconds after Telegram accepted it). The
// tracked row in that same commit has the spot the alert was decided on, which
// picks the ATM strike.
//
// Every number is compared with a BASELINE: the same rules entered at every
// 5-minute candle of the same contract on the same day. Hitting +5% on an ATM
// option is easy by chance; the question is whether entering on the alert
// beats entering at a random time.
//
// Prices: Upstox 5-minute candles (v3 for live contracts, the expired-
// instruments API for expired ones — which needs an Upstox Plus plan and may
// 403; those trades are then reported as unavailable, never guessed). Candles
// are cached on the `flip-test` branch so a contract fetched while live stays
// testable after it expires.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";

export const TICK = 0.05;
export const STOPS = [0.05, 0.1, 0.2, null];
export const TARGET = 0.05;
export const EXIT_MIN = 15 * 60 + 15; // square-off candle (15:15 IST)
export const LAST_ENTRY_MIN = 15 * 60 + 10; // at least one candle to work with
export const MAX_ENTRY_DELAY_MIN = 30; // first trade later than this → illiquid, skipped

const IST_MS = 5.5 * 3600e3;
const r2 = (x) => Math.round(x * 100) / 100;

// --- pure helpers (unit-tested) ---------------------------------------------

/** Seconds since IST midnight for an ISO instant. */
export const istSeconds = (iso) => {
  const d = new Date(new Date(iso).getTime() + IST_MS);
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
};
export const istDay = (iso) => new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(0, 10);

/** Upstox candle arrays → [{t (minutes since IST midnight), o, h, l, c, v}] oldest first. */
export function parseCandles(raw) {
  const out = [];
  for (const c of raw ?? []) {
    const m = /T(\d{2}):(\d{2})/.exec(String(c[0]));
    const [o, h, l, cl] = [1, 2, 3, 4].map((i) => Number(c[i]));
    if (!m || ![o, h, l, cl].every((x) => Number.isFinite(x) && x > 0)) continue;
    out.push({ t: Number(m[1]) * 60 + Number(m[2]), o, h, l, c: cl, v: Number(c[5]) || 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The opposite side of the alert, at the strike nearest spot (ties → lower strike). */
export function oppositeAtm(alertType, spot, strikes) {
  const type = alertType === "CE" ? "PE" : "CE";
  const list = [...new Set(strikes)].filter((s) => s > 0).sort((a, b) => a - b);
  if (!list.length || !(spot > 0)) return null;
  let best = list[0];
  for (const s of list) if (Math.abs(s - spot) < Math.abs(best - spot)) best = s;
  return { type, strike: best };
}

/** Index of the first candle that STARTS strictly after the alert went out. */
export function entryIndex(candles, sentSec) {
  return candles.findIndex((c) => c.t * 60 > sentSec);
}

const up = (x) => Math.ceil(x / TICK - 1e-9) * TICK;
const down = (x) => Math.floor(x / TICK + 1e-9) * TICK;

/**
 * Walk the candles from the entry. Within one candle the order of high and low
 * is unknown, so a candle touching BOTH the stop and the target counts as the
 * stop (`ambiguous` flags it) — the conservative reading.
 */
export function simulate(candles, i0, { target = TARGET, stop = null, exitMin = EXIT_MIN } = {}) {
  const entry = candles[i0].o;
  const tp = r2(up(entry * (1 + target)));
  const sl = stop == null ? null : r2(Math.max(TICK, down(entry * (1 - stop))));
  for (let i = i0; i < candles.length; i++) {
    const c = candles[i];
    if (c.t >= exitMin) return { entry, exit: c.o, reason: "time", at: c.t };
    if (i > i0) {
      if (sl != null && c.o <= sl) return { entry, exit: c.o, reason: "stop", at: c.t };
      if (c.o >= tp) return { entry, exit: c.o, reason: "target", at: c.t };
    }
    const hitS = sl != null && c.l <= sl;
    const hitT = c.h >= tp;
    if (hitS) return { entry, exit: sl, reason: "stop", at: c.t, ambiguous: hitT };
    if (hitT) return { entry, exit: tp, reason: "target", at: c.t };
  }
  const last = candles[candles.length - 1];
  return { entry, exit: last.c, reason: "time", at: last.t };
}

/**
 * Net return on premium paid for one lot, after costs. Slippage: one tick paid
 * on entry and on market exits (stop, time); the target is a resting limit, so
 * none there. Charges at Zerodha-style rates: ₹20/order, STT 0.1% of the sell
 * premium, exchange 0.03503%, SEBI ₹10/crore, stamp 0.003% on the buy, GST 18%
 * on brokerage + exchange + SEBI.
 */
export function netReturn({ entry, exit, reason }, lot, { slipTicks = 1 } = {}) {
  const buy = entry + slipTicks * TICK;
  const sell = reason === "target" ? exit : Math.max(0, exit - slipTicks * TICK);
  const bv = buy * lot;
  const sv = sell * lot;
  const brokerage = 40;
  const exch = (bv + sv) * 0.0003503;
  const sebi = (bv + sv) * 1e-6;
  const charges = brokerage + sv * 0.001 + exch + sebi + bv * 0.00003 + 0.18 * (brokerage + exch + sebi);
  return {
    grossPct: ((exit - entry) / entry) * 100,
    netPct: ((sv - bv - charges) / bv) * 100,
    netRs: sv - bv - charges,
    capital: bv,
  };
}

/** Summary stats for a list of trades. */
export function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const cnt = (f) => trades.filter(f).length;
  const nets = trades.map((t) => t.netPct).sort((a, b) => a - b);
  const mean = nets.reduce((a, b) => a + b, 0) / n;
  return {
    n,
    targetPct: (cnt((t) => t.reason === "target") / n) * 100,
    stopPct: (cnt((t) => t.reason === "stop") / n) * 100,
    timePct: (cnt((t) => t.reason === "time") / n) * 100,
    winPct: (cnt((t) => t.netPct > 0) / n) * 100,
    meanNet: mean,
    medianNet: nets[Math.floor(n / 2)],
    worst: nets[0],
    best: nets[n - 1],
    sumRs: trades.reduce((a, t) => a + (t.netRs ?? 0), 0),
    ambiguous: cnt((t) => t.ambiguous),
  };
}

/** Per stop level: the alert trade and the every-candle baseline on the same contract-day. */
export function evaluate(candles, sentSec, lot) {
  const i0 = entryIndex(candles, sentSec);
  if (i0 < 0) return { skip: "no candle after the alert" };
  const delay = candles[i0].t - Math.floor(sentSec / 60);
  if (candles[i0].t > LAST_ENTRY_MIN) return { skip: "alert too late for an intraday trade" };
  if (delay > MAX_ENTRY_DELAY_MIN) return { skip: `illiquid (first trade ${delay} min after the alert)` };
  const byStop = {};
  for (const stop of STOPS) {
    const sim = simulate(candles, i0, { stop });
    const alert = { ...sim, ...netReturn(sim, lot) };
    const base = [];
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].t < 9 * 60 + 15 || candles[i].t > LAST_ENTRY_MIN) continue;
      const s = simulate(candles, i, { stop });
      base.push({ ...s, ...netReturn(s, lot) });
    }
    const b = summarize(base);
    byStop[stopLabel(stop)] = { alert, baseline: { n: b.n, targetPct: b.targetPct, meanNet: b.meanNet, winPct: b.winPct } };
  }
  return { entryAt: candles[i0].t, delay, byStop };
}

export const stopLabel = (s) => (s == null ? "none" : `${Math.round(s * 100)}%`);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// --- signals from the alerts-state history -----------------------------------

export function signalsFromHistory(dir) {
  const sh = (c) => execSync(c, { cwd: dir, maxBuffer: 1 << 28 }).toString();
  const out = new Map();
  for (const file of ["stocks.json", "stocks-sharp.json"]) {
    const feed = file === "stocks.json" ? "stocks" : "premium";
    const log = sh(`git log --reverse --format='%H %cI' -- ${file}`).trim();
    if (!log) continue;
    const seen = new Set();
    let prevVersion = null; // null = no earlier commit of this file
    for (const line of log.split("\n")) {
      const [h, t] = line.split(" ");
      let s;
      try { s = JSON.parse(sh(`git show ${h}:${file}`)); } catch { continue; }
      // A run with no prior state, or the first under v3 rules, ARMS: one
      // summary message, not NEW alerts (alerts.mjs main()).
      const armedRun = prevVersion == null || prevVersion < 3;
      prevVersion = s.version ?? 1;
      const keys = Object.keys(s.announced ?? {}).filter((k) => k.split("|").length === 4);
      for (const k of keys) {
        if (seen.has(k)) continue;
        seen.add(k);
        // The first commit carrying announcements is the "armed" summary, not a NEW.
        if (armedRun) continue;
        const r = s.tracked?.[k];
        const [symbol, expiry, strike, type] = k.split("|");
        const prev = out.get(k);
        if (prev) { prev.feeds.push(feed); continue; }
        out.set(k, { key: k, symbol, expiry, strike: Number(strike), type, sentAt: t,
          spot: r?.spot ?? null, conviction: r?.conviction ?? null, lot: r?.lot ?? null, feeds: [feed] });
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1));
}

// --- Upstox ------------------------------------------------------------------

const API = "https://api.upstox.com";
async function upstox(token, path) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1500 * attempt)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
    return res.json();
  }
  throw new Error("429 rate limited");
}

async function main() {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) throw new Error("UPSTOX_ACCESS_TOKEN not set");
  const stateDir = process.env.ALERTS_DIR ?? "_alerts";
  const outDir = process.env.FLIP_DIR ?? "_flip";
  const cacheDir = resolve(outDir, "candles");
  mkdirSync(cacheDir, { recursive: true });
  const today = istDay(new Date().toISOString());

  const signals = signalsFromHistory(stateDir);
  console.log(`signals: ${signals.length} NEW stock alerts (${signals[0]?.sentAt} → ${signals.at(-1)?.sentAt})`);

  const { fetchInstruments, pickEquityKeys } = await import("./upstox.mjs");
  const master = await fetchInstruments("NSE");
  if (!master.length) throw new Error("no NSE instrument master");
  const live = new Map(); // `SYM|expiry|type` → [{strike, key}]
  for (const r of master) {
    if (String(r.segment).toUpperCase() !== "NSE_FO") continue;
    const type = String(r.instrument_type ?? "").toUpperCase();
    if (type !== "CE" && type !== "PE") continue;
    const exp = typeof r.expiry === "number" ? new Date(r.expiry + IST_MS).toISOString().slice(0, 10) : String(r.expiry).slice(0, 10);
    const k = `${String(r.asset_symbol ?? r.name).toUpperCase()}|${exp}|${type}`;
    if (!live.has(k)) live.set(k, []);
    live.get(k).push({ strike: Number(r.strike_price), key: r.instrument_key, lot: Number(r.lot_size) || null });
  }
  const eqKeys = pickEquityKeys(master, [...new Set(signals.map((s) => s.symbol))]);

  const expiredContracts = new Map();
  let expiredApi = "untried";
  async function contractsFor(sig, type) {
    const k = `${sig.symbol}|${sig.expiry}|${type}`;
    if (live.has(k)) return { list: live.get(k), expired: false };
    if (!expiredContracts.has(`${sig.symbol}|${sig.expiry}`)) {
      let list = [];
      const eq = eqKeys[sig.symbol];
      if (eq && expiredApi !== "denied") {
        try {
          const j = await upstox(token, `/v2/expired-instruments/option/contract?instrument_key=${encodeURIComponent(eq)}&expiry_date=${sig.expiry}`);
          list = (j?.data ?? []).map((c) => ({ strike: Number(c.strike_price), key: c.instrument_key,
            type: String(c.instrument_type).toUpperCase(), lot: Number(c.lot_size) || null }));
          expiredApi = "ok";
        } catch (e) {
          console.warn(`expired contracts ${sig.symbol} ${sig.expiry}: ${e.message}`);
          if (/^40[13]/.test(e.message)) expiredApi = "denied";
        }
      }
      expiredContracts.set(`${sig.symbol}|${sig.expiry}`, list);
    }
    return { list: expiredContracts.get(`${sig.symbol}|${sig.expiry}`).filter((c) => c.type === type), expired: true };
  }

  async function candlesFor(instrumentKey, day, expired) {
    const file = resolve(cacheDir, `${instrumentKey.replace(/[^A-Za-z0-9]/g, "_")}_${day}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
    const k = encodeURIComponent(instrumentKey);
    const path = expired
      ? `/v2/expired-instruments/historical-candle/${k}/5minute/${day}/${day}`
      : day === today
        ? `/v3/historical-candle/intraday/${k}/minutes/5`
        : `/v3/historical-candle/${k}/minutes/5/${day}/${day}`;
    const j = await upstox(token, path);
    const candles = parseCandles(j?.data?.candles);
    // Cache only complete sessions — today's only after the close.
    const closed = day < today || istSeconds(new Date().toISOString()) > 15 * 3600 + 35 * 60;
    if (candles.length && closed) writeFileSync(file, JSON.stringify(candles));
    return candles;
  }

  const trades = [];
  const skipped = [];
  const seenTrade = new Set();
  for (const sig of signals) {
    const day = istDay(sig.sentAt);
    const sentSec = istSeconds(sig.sentAt);
    const base = { ...sig, day, sentIst: hhmm(Math.floor(sentSec / 60)) };
    if (!(sig.spot > 0)) { skipped.push({ ...base, skip: "no spot in the alert state" }); continue; }
    const want = sig.type === "CE" ? "PE" : "CE";
    const { list, expired } = await contractsFor(sig, want);
    const atm = oppositeAtm(sig.type, sig.spot, list.map((c) => c.strike));
    if (!atm) { skipped.push({ ...base, skip: expired ? `expired contract list unavailable (${expiredApi})` : "no contracts" }); continue; }
    const contract = list.find((c) => c.strike === atm.strike);
    const lot = contract.lot ?? sig.lot;
    // Two alerts on the same stock in one run (e.g. two CE strikes) map to the
    // same flipped trade — count it once.
    const tradeKey = `${sig.symbol}|${sig.expiry}|${atm.strike}|${atm.type}|${sig.sentAt}`;
    if (seenTrade.has(tradeKey)) { skipped.push({ ...base, skip: "duplicate of another alert in the same run" }); continue; }
    seenTrade.add(tradeKey);
    let candles;
    try { candles = await candlesFor(contract.key, day, expired); }
    catch (e) { skipped.push({ ...base, skip: `candles: ${e.message}` }); continue; }
    if (!candles.length) { skipped.push({ ...base, skip: "no candles that day" }); continue; }
    const ev = evaluate(candles, sentSec, lot);
    const row = { ...base, buy: `${atm.strike} ${atm.type}`, buyStrike: atm.strike, buyType: atm.type, lot, expired };
    if (ev.skip) { skipped.push({ ...row, skip: ev.skip }); continue; }
    trades.push({ ...row, entryIst: hhmm(ev.entryAt), delay: ev.delay, byStop: ev.byStop });
  }

  const report = buildReport(trades, skipped, { expiredApi, generatedAt: new Date().toISOString(), signals: signals.length });
  writeFileSync(resolve(outDir, "results.json"), JSON.stringify({ generatedAt: new Date().toISOString(), expiredApi, trades, skipped }, null, 1));
  writeFileSync(resolve(outDir, "REPORT.md"), report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  console.log(report);
}

const f1 = (x) => (x == null || Number.isNaN(x) ? "–" : x.toFixed(1));
const sign = (x) => (x == null || Number.isNaN(x) ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);

export function buildReport(trades, skipped, { expiredApi, generatedAt, signals }) {
  const L = [];
  L.push(`# Flip test — buy the opposite ATM on each sell alert`, "");
  L.push(`Generated ${generatedAt}. ${signals} NEW stock alerts → **${trades.length} trades simulated**, ${skipped.length} skipped. Target +5% of premium paid, intraday (square-off 15:15), entry at the open of the next 5-min candle. Net = after 1-tick slippage and charges.`, "");
  L.push(`| stop | trades | hit +5% | stopped | 15:15 exit | net > 0 | mean net | median net | worst | total ₹ (1 lot each) | baseline hit +5% | baseline mean net |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of STOPS.map(stopLabel)) {
    const a = summarize(trades.map((t) => t.byStop[s].alert));
    const bHit = trades.reduce((x, t) => x + t.byStop[s].baseline.targetPct, 0) / (trades.length || 1);
    const bMean = trades.reduce((x, t) => x + t.byStop[s].baseline.meanNet, 0) / (trades.length || 1);
    L.push(`| ${s} | ${a.n} | ${f1(a.targetPct)}% | ${f1(a.stopPct)}% | ${f1(a.timePct)}% | ${f1(a.winPct)}% | ${sign(a.meanNet)} | ${sign(a.medianNet)} | ${sign(a.worst)} | ₹${Math.round(a.sumRs ?? 0).toLocaleString("en-IN")} | ${f1(bHit)}% | ${sign(bMean)} |`);
  }
  L.push("", "Baseline = the same rules entered at every 5-min candle of the same contract on the same day, averaged per trade. The alert adds something only if it beats the baseline.", "");
  const groups = [
    ["Feed", (t) => (t.feeds.includes("premium") ? "premium (also stocks)" : "stocks only")],
    ["Bought", (t) => t.buyType],
    ["Entry hour (IST)", (t) => t.entryIst.slice(0, 2) + ":00"],
    ["Expiry", (t) => t.expiry],
  ];
  for (const [title, fn] of groups) {
    L.push(`## By ${title.toLowerCase()} (stop 10%)`, "", `| ${title} | trades | hit +5% | net > 0 | mean net | baseline mean net |`, `|---|---|---|---|---|---|`);
    const by = {};
    for (const t of trades) (by[fn(t)] ??= []).push(t);
    for (const [k, ts] of Object.entries(by).sort()) {
      const a = summarize(ts.map((t) => t.byStop["10%"].alert));
      const bm = ts.reduce((x, t) => x + t.byStop["10%"].baseline.meanNet, 0) / ts.length;
      L.push(`| ${k} | ${a.n} | ${f1(a.targetPct)}% | ${f1(a.winPct)}% | ${sign(a.meanNet)} | ${sign(bm)} |`);
    }
    L.push("");
  }
  const why = {};
  for (const s of skipped) { const k = s.skip.replace(/\d+ min/, "N min").replace(/candles: (\d+).*/, "candles: $1"); why[k] = (why[k] ?? 0) + 1; }
  L.push(`## Skipped`, "", `Expired-contract API: ${expiredApi}.`, "", ...Object.entries(why).map(([k, n]) => `- ${n} × ${k}`), "");
  return L.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}
