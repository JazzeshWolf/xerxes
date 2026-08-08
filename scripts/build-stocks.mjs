#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Xerxes — single-stock F&O screener builder (runs in GitHub Actions, separate
// from the index build-data.mjs which it does NOT import or modify).
//
// For every NSE F&O stock in scripts/stocks-universe.mjs it fetches the option
// chain (nearest 1-2 monthlies), spot/future quote and daily closes, then
// computes the SAME Snapshot shape the index dashboard renders — so the
// per-stock view reuses the index tab components verbatim. It also writes a
// screener index (liquidity + structure + verdict per stock) and a cross-
// universe list of the best premium-selling candidates.
//
// Stock adaptations vs indices (to stay within Upstox rate limits):
//   - market structure uses the OPTION CHAIN's total OI day-change (prevOi is
//     already in each row) instead of a separate futures-OI candle call;
//   - India VIX (market-wide) is fetched once and shared as each stock's vix,
//     so the VIX-trend factor works and the "India VIX" strip stays accurate.
//
// Everything fails soft: a stock that can't be fetched is skipped, never faked.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as upstox from "./upstox.mjs";
import * as nse from "./nse.mjs";
import * as A from "./analytics.mjs";
import { fetchStockNews, mergeEvents, impliedEvent } from "./stock-news.mjs";
import { STOCKS } from "./stocks-universe.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../public/data");
const STOCKS_DIR = resolve(DATA_DIR, "stocks");

const VIX_KEY = "NSE_INDEX|India VIX";
const YEAR_MS = 365 * 86400000;
const MONTHLIES = 2; // nearest N monthly expiries per stock (current + next)
const CONCURRENCY = 5; // chains in flight at once — respect Upstox limits
const CHAIN_WINDOW = 0.3; // keep strikes within ±30% of spot (trims size)
const CANDLE_LOOKBACK_DAYS = 260; // ~180 trading bars — enough for YZ(120) + gap stats
const IV_HISTORY_DAYS = 252; // trailing ATM-IV points kept per stock (→ IV rank)
const IV_RANK_MIN_POINTS = 20; // below this, ivRank stays null and its weight redistributes
const EXPIRY_SLOTS = ["current", "next"]; // ordered[0], ordered[1]

// A far-month strike is not tradeable just because the name's near month is, so
// each expiry is ranked against its OWN cohort and gated on its own numbers.
const TRADEABLE_BUCKETS = ["Medium", "Medium-High", "High"];
const MIN_STRIKE_OI = 250; // hard floor: below this the strike is a quote, not a market
const THIN_EXPIRY_CANDIDATES = 8; // fewer than this in a slot → warn the user loudly
// Per-stock news is fetched for the STALEST few names each full run, not all of
// them — one Google News query per symbol across the universe every 20 minutes
// would be rate-limited into uselessness. Picking by staleness means the
// universe cycles on its own with no counter to keep, and cached news survives
// because the workflow seeds public/data/stocks from the published branch on
// every run (the same mechanism ivHistory relies on). The single-symbol refresh
// path always fetches, so the in-app "Fetch latest news" button is immediate.
const NEWS_PER_RUN = 15;
// One name's strike ladder is a handful of near-identical trades, and without a
// cap a single high-VRP stock crowds out the whole cross-universe list.
const MAX_PER_SYMBOL = 2;

// On-demand single-stock refresh: SYMBOL=INDIGO rebuilds only that stock and
// merges it into the already-published set (the workflow seeds public/data/stocks
// from the stocks-data branch first, so force_orphan keeps the other files).
const ONLY_SYMBOL = (process.env.SYMBOL || "").toUpperCase();

// --- shared date/compute helpers (mirrors build-data.mjs; kept separate on
//     purpose so the index pipeline is never touched) ------------------------
const todayIso = () => new Date().toISOString().slice(0, 10);
function timeToExpiryYears(expiryIso) {
  const cutoff = new Date(`${expiryIso}T10:00:00Z`).getTime();
  return Math.max((cutoff - Date.now()) / YEAR_MS, 0.25 / 365);
}
function dteCalendar(expiryIso) {
  const exp = Date.parse(`${expiryIso}T00:00:00Z`);
  const today = Date.parse(`${todayIso()}T00:00:00Z`);
  return Math.max(0, Math.round((exp - today) / 86400000));
}
const slimChain = (chain) =>
  chain.map((o) => ({
    strike: o.strike,
    type: o.type,
    ltp: o.ltp,
    iv: o.iv != null ? A.round(o.iv, 4) : null,
    oi: o.oi,
    prevOi: o.prevOi,
    volume: o.volume,
    delta: o.delta != null ? A.round(o.delta, 3) : null,
  }));

/**
 * Per-expiry analytics block. Everything here is a same-instant read of the
 * chain; the forward-looking scoring (`scoreCandidates`) is a second pass,
 * because it needs the term structure and the direction verdict, neither of
 * which exists until every expiry has been through this function.
 */
function computeExpiry(chain, spot, expiryIso, label, ctx = {}) {
  const t = timeToExpiryYears(expiryIso);
  const dte = dteCalendar(expiryIso);
  const pcr = A.pcr(chain);
  const maxPain = A.maxPain(chain);
  const walls = A.walls(chain, spot);
  const flow = A.oiFlow(chain);
  const atmK = A.atmStrike(chain, spot);
  const atmIv = A.atmIv(chain, spot, t);
  const straddle = A.straddlePrice(chain, spot);
  const expectedMove = straddle ?? (atmIv != null ? spot * atmIv * Math.sqrt(t) : null);
  const skew = A.ivSkew(chain, spot);
  const gex = A.computeGex(chain, spot, t);

  // Horizon-matched realized-vol forecast — the yardstick the option's price is
  // judged against. Gap-aware (Yang-Zhang) because overnight risk is what
  // actually costs a short-premium position on an Indian single stock.
  const fc = A.forecastVol(ctx.ohlc ?? [], dte);
  const sigmaForecast = fc?.sigma ?? null;

  const candidates = A.sellCandidates(chain, spot, t, expectedMove, {
    maxDelta: 0.25,
    minPremium: Math.max(1, spot * 0.0004),
  });
  return {
    label,
    date: expiryIso,
    dte,
    tYears: A.round(t, 5),
    metrics: {
      pcrOi: pcr.oi,
      pcrVolume: pcr.volume,
      totalCallOi: pcr.totalCallOi,
      totalPutOi: pcr.totalPutOi,
      maxPain,
      callWall: walls.callWall,
      putWall: walls.putWall,
      supports: walls.supports,
      resistances: walls.resistances,
      oiFlow: flow,
      atmStrike: atmK,
      atmIv: A.round(atmIv, 4),
      // Filled by the scoring pass once the ATM-IV history is known.
      ivRank: null,
      ivPercentile: null,
      rv20: fc?.rv20 ?? null,
      rv60: fc?.rv60 ?? null,
      rv120: fc?.rv120 ?? null,
      sigmaForecast,
      // > 1 means the market is charging more than this name has been doing.
      // Individual-equity variance risk is not reliably priced (Driessen,
      // Maenhout & Vilkov 2009), so this has to be measured per name.
      vrp: atmIv > 0 && sigmaForecast > 0 ? A.round(atmIv / sigmaForecast, 2) : null,
      gapShare: fc?.gapShare ?? null,
      cpIvSpread: A.cpIvSpread(chain, spot),
      smirk: A.putSmirk(chain, spot),
      termSlope: null, // needs the neighbouring expiry — filled in buildStock
      straddle: A.round(straddle, 1),
      expectedMove: A.round(expectedMove, 0),
      skew: A.round(skew, 4),
      gex,
    },
    candidates: candidates.slice(0, 24),
    chain: slimChain(chain),
    _pcr: pcr.oi,
    _maxPain: maxPain,
    _skew: skew,
    _em: expectedMove,
    _flow: flow,
    _t: t,
    _sigmaForecast: sigmaForecast,
    _rawChain: chain,
  };
}

/**
 * Second pass: attach a forward-looking conviction score to every candidate in
 * one expiry block, and drop strikes that are quotes rather than markets.
 *
 * Ranked by conviction rather than by raw premium. The old rank
 * (`ltp × (1−|delta|) × cushion`) was three restatements of the option's own
 * price: raw rupees favour expensive stocks, `1−|delta|` is the risk-neutral
 * P(OTM) which is fair by construction, and dividing distance by the straddle
 * made high-IV names look safe *because* their IV was high.
 */
function scoreCandidates(block, { spot, lotSize, verdict, gap, term, ivRank, returns }) {
  const t = block._t;
  const sf = block._sigmaForecast;
  const mu = A.driftFromVerdict(verdict);
  const smirk = block.metrics.smirk;
  // One bootstrap per (stock, expiry), reused for every strike on it — which is
  // what keeps filtered historical simulation affordable across ~157 names.
  const sample = sf > 0 ? A.terminalSample(returns ?? [], A.tradingDaysTo(block.dte), sf) : null;
  const byStrike = new Map();
  for (const o of block._rawChain ?? []) byStrike.set(`${o.type}:${o.strike}`, o);

  const scored = [];
  for (const c of block.candidates) {
    const row = byStrike.get(`${c.type}:${c.strike}`);
    if ((row?.oi ?? c.oi ?? 0) < MIN_STRIKE_OI) continue;
    const conv = A.sellConviction({
      type: c.type,
      strike: c.strike,
      ltp: c.ltp,
      iv: c.iv,
      oi: row?.oi ?? c.oi,
      volume: row?.volume ?? 0,
      lotSize,
      spot,
      t,
      sigmaForecast: sf,
      mu,
      verdict,
      ivRank,
      gap,
      term,
      smirk,
      sample,
    });
    if (!conv) continue;
    scored.push({
      ...c,
      conviction: conv.conviction,
      band: conv.band,
      edge: conv.edge,
      edgePct: conv.edgePct,
      fair: conv.fair,
      // Real-world P(expire OTM) under the forecast vol + drift. Deliberately
      // kept alongside `probProfit` (the risk-neutral 1−|delta|) so the two can
      // be compared — where they disagree is where the edge is.
      pProfit: conv.pProfit,
      cushionSigmaF: conv.cushionSigmaF,
      probTouchF: conv.probTouchF,
      deliveryRisk: conv.deliveryRisk,
      tailReliance: conv.tailReliance,
      empirical: conv.empirical,
      cvar: conv.cvar,
      worst: conv.worst,
      factors: conv.factors,
      notes: conv.notes,
    });
  }
  scored.sort((a, b) => b.conviction - a.conviction);
  block.candidates = scored;
  return scored;
}

const HORIZONS = [{ key: "1W", target: 7 }, { key: "1M", target: 30 }, { key: "2M", target: 60 }];
function buildHorizons(ordered, expiries) {
  const out = {};
  for (const { key, target } of HORIZONS) {
    let best = null;
    for (const e of ordered) {
      const d = Math.abs(expiries[e].dte - target);
      if (!best || d < best.d) best = { date: e, dte: expiries[e].dte, d };
    }
    if (best) out[key] = { date: best.date, dte: best.dte, fallback: best.d > target * 0.6 };
  }
  return out;
}

/** Simple bounded-concurrency map. */
async function pool(items, n, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        console.warn(`stock ${items[idx]?.[0]}: ${e.message}`);
        results[idx] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

const trimToWindow = (chain, spot) =>
  spot > 0 ? chain.filter((o) => Math.abs(o.strike - spot) / spot <= CHAIN_WINDOW) : chain;

// --- fetch + build one stock -----------------------------------------------
async function fetchStock(token, symbol, instruments, equityKey) {
  const today = todayIso();
  const picked = upstox.pickIndex(instruments, symbol, "NSE_FO", today);
  if (!picked || !picked.optionExpiries.length) return null;
  // Stock options are monthly-only; take the nearest MONTHLIES expiries.
  const ordered = picked.optionExpiries.slice(0, MONTHLIES);
  const underlyingKey = equityKey ?? picked.future?.underlyingKey ?? null;
  const from = new Date(Date.now() - CANDLE_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

  const quoteKeys = [
    ...(underlyingKey ? [underlyingKey] : []),
    ...(picked.future ? [picked.future.key] : []),
  ];
  const [chainResults, q, closesC] = await Promise.all([
    Promise.all(ordered.map((e) => upstox.optionChain(token, underlyingKey ?? picked.future?.key ?? symbol, e))),
    quoteKeys.length ? upstox.quotes(token, quoteKeys) : Promise.resolve({}),
    underlyingKey ? upstox.dailyCandles(token, underlyingKey, from, today) : Promise.resolve({ history: [] }),
  ]);

  const chainsByExpiry = {};
  let chainSpot = null;
  ordered.forEach((e, i) => {
    const { chain, spot: cs } = chainResults[i];
    if (chain.length >= 6) chainsByExpiry[e] = chain;
    if (cs > 0) chainSpot = cs;
  });
  const gotExpiries = ordered.filter((e) => chainsByExpiry[e]);
  if (!gotExpiries.length) return null;

  const uq = underlyingKey ? q[underlyingKey] : null;
  const futQ = picked.future ? q[picked.future.key] : null;
  const spot = uq?.lastPrice ?? chainSpot ?? null;
  if (!(spot > 0)) return null;

  return {
    symbol,
    spot,
    closes: (closesC.history ?? []).map((p) => p.v),
    // Full bars (same API call) — needed for gap-aware realized vol.
    ohlc: closesC.ohlc ?? [],
    chainsByExpiry,
    orderedExpiries: gotExpiries,
    lotSize: picked.lotSize,
    future: futQ?.lastPrice != null && picked.future ? { price: futQ.lastPrice, expiry: picked.future.expiry, oi: futQ.oi } : null,
    prevClose: (closesC.history ?? []).map((p) => p).filter((p) => p.t < today).pop()?.v ?? uq?.prevClose ?? null,
  };
}

/**
 * Append today's ATM IV to the stock's own IV history (one point per calendar
 * day, last write wins) and keep a trailing year. The workflow seeds
 * public/data/stocks from the published `stocks-data` branch before every run,
 * which is what carries this forward across a force-pushed orphan branch.
 */
function appendIvPoint(prev, t, iv) {
  const clean = (Array.isArray(prev) ? prev : []).filter((p) => p && p.t && p.v > 0);
  if (!(iv > 0)) return clean.slice(-IV_HISTORY_DAYS);
  return [...clean.filter((p) => p.t !== t), { t, v: A.round(iv, 4) }]
    .sort((a, b) => (a.t < b.t ? -1 : 1))
    .slice(-IV_HISTORY_DAYS);
}

function buildStock(name, raw, vix, prevIvHistory = [], newsBundle = null) {
  const spot = raw.spot;
  const expiries = {};
  const ordered = raw.orderedExpiries.filter((e) => raw.chainsByExpiry[e]);
  const gap = A.gapProfile(raw.ohlc ?? [], 60);
  for (const e of ordered) {
    const trimmed = trimToWindow(raw.chainsByExpiry[e], spot);
    expiries[e] = computeExpiry(trimmed, spot, e, "monthly", { ohlc: raw.ohlc });
  }
  const defaultExpiry = ordered[0];
  const dflt = expiries[defaultExpiry];

  // Term structure across the two monthlies: front bid over back = the market
  // pricing a near-term event. Same slope is stamped on both blocks so either
  // expiry's view carries the context.
  const term =
    ordered.length >= 2
      ? A.termStructure(
          expiries[ordered[0]].metrics.atmIv,
          expiries[ordered[1]].metrics.atmIv,
          expiries[ordered[0]].dte,
          expiries[ordered[1]].dte,
        )
      : null;
  for (const b of Object.values(expiries)) b.metrics.termSlope = term?.slopePts ?? null;

  // ATM IV history → IV rank / percentile. Null (and its conviction weight
  // redistributed) until enough points have accrued — nothing is invented.
  const ivHistory = appendIvPoint(prevIvHistory, todayIso(), dflt.metrics.atmIv);
  const ivSample = ivHistory.map((p) => p.v);
  const enoughIv = ivSample.length >= IV_RANK_MIN_POINTS;
  const ivRank = enoughIv ? A.round(A.rangeRank(dflt.metrics.atmIv, ivSample), 0) : null;
  const ivPercentile = enoughIv ? A.percentile(dflt.metrics.atmIv, ivSample) : null;
  for (const b of Object.values(expiries)) {
    b.metrics.ivRank = ivRank;
    b.metrics.ivPercentile = ivPercentile;
  }

  const prevClose = raw.prevClose;
  const changePct = prevClose > 0 ? A.round(((spot - prevClose) / prevClose) * 100, 2) : null;
  const priceChgPct = prevClose > 0 ? (spot - prevClose) / prevClose : null;
  const basisPts = raw.future?.price != null ? raw.future.price - spot : null;

  // Structure from the near chain's total OI day-change (prevOi is in-row).
  const nearChain = raw.chainsByExpiry[defaultExpiry];
  let oiNow = 0, oiPrev = 0, have = 0;
  for (const o of nearChain) {
    if (o.prevOi != null) { oiNow += o.oi; oiPrev += o.prevOi; have++; }
  }
  const oiChgPct = have && oiPrev > 0 ? (oiNow - oiPrev) / oiPrev : null;
  const structure = A.futuresStructure(priceChgPct, oiChgPct);

  const verdictFor = (b) =>
    A.directionScore({
      closes: raw.closes,
      vixHistory: vix.closes,
      pcrOi: b._pcr,
      maxPainStrike: b._maxPain,
      spot,
      expectedMove: b._em,
      flow: b._flow,
      skew: b._skew,
      basisPts,
    });
  for (const b of Object.values(expiries)) b.verdict = verdictFor(b);
  const verdict = expiries[defaultExpiry].verdict;
  const horizons = buildHorizons(ordered, expiries);

  // Scoring pass — now that each expiry has its own verdict and the term
  // structure is known, every candidate gets a conviction score.
  const returns = A.dailyLogReturns(raw.ohlc ?? []);
  for (const e of ordered) {
    scoreCandidates(expiries[e], {
      spot,
      lotSize: raw.lotSize ?? 1,
      verdict: expiries[e].verdict,
      gap,
      term,
      ivRank,
      returns,
    });
  }

  const liquidity = A.liquidityScore(nearChain, raw.lotSize ?? 1, 0);
  // Per-expiry raw liquidity, so the far month is later ranked against far
  // months rather than inheriting the near month's (much better) numbers.
  const liquidityByExpiry = {};
  ordered.forEach((e, i) => {
    liquidityByExpiry[EXPIRY_SLOTS[i] ?? `x${i}`] = {
      date: e,
      dte: expiries[e].dte,
      raw: A.liquidityScore(raw.chainsByExpiry[e], raw.lotSize ?? 1, 0),
    };
  });

  const publicExpiries = {};
  for (const [e, b] of Object.entries(expiries)) {
    const { _flow, _pcr, _maxPain, _skew, _em, _t, _sigmaForecast, _rawChain, ...pub } = b;
    void _flow, void _pcr, void _maxPain, void _skew, void _em, void _t, void _sigmaForecast, void _rawChain;
    publicExpiries[e] = pub;
  }

  const snap = {
    asOf: new Date().toISOString(),
    stale: false,
    source: "upstox",
    index: raw.symbol,
    name,
    expiryKind: "monthly (F&O)",
    lotSize: raw.lotSize ?? null,
    spot: { price: A.round(spot, 2), prevClose: A.round(prevClose, 2), changePct, history: [] },
    vix: { value: vix.value, history: [] },
    future: raw.future ? { price: A.round(raw.future.price, 2), expiry: raw.future.expiry, oi: raw.future.oi, basisPts: A.round(basisPts, 1) } : null,
    defaultExpiry,
    horizons,
    expiries: publicExpiries,
    ivHistory,
    gap,
    term,
    sector: raw.sector ?? null,
    // Merged from every source that answered. News-derived and NSE events only
    // exist on a run that fetched them, but the options-implied window is
    // recomputed every run from the term structure, so the list is never bare
    // even when both scrapes fail.
    events: mergeEvents(
      newsBundle?.events ?? raw.prevEvents?.filter((e) => e.source !== "options") ?? [],
      newsBundle?.nseEvents ?? [],
      [impliedEvent(term?.slopePts ?? null, defaultExpiry)].filter(Boolean),
    ),
    news: newsBundle?.news ?? raw.prevNews ?? [],
    newsAsOf: newsBundle ? new Date().toISOString() : raw.prevNewsAsOf ?? null,
    verdict,
    structure,
  };
  return { snap, liquidityRaw: liquidity, liquidityByExpiry, dfltMetrics: dflt.metrics };
}

const fileSlug = (symbol) => symbol.replace(/[^A-Za-z0-9]/g, "_");

/** Compact best-candidate summary for a screener row. */
const topCandidateRow = (c) => ({
  type: c.type,
  strike: c.strike,
  probProfit: c.probProfit,
  pProfit: c.pProfit ?? null,
  conviction: c.conviction ?? null,
  band: c.band ?? null,
});

/**
 * The stock's previously published state, read from the seeded copy of the
 * `stocks-data` branch: ATM-IV history plus cached news/events. A missing file
 * (first ever run, or a seed failure) is not an error — it simply restarts.
 */
async function readPrevStock(slug) {
  try {
    const j = JSON.parse(await readFile(resolve(STOCKS_DIR, `${slug}.json`), "utf8"));
    return {
      ivHistory: Array.isArray(j?.ivHistory) ? j.ivHistory : [],
      news: Array.isArray(j?.news) ? j.news : [],
      events: Array.isArray(j?.events) ? j.events : [],
      newsAsOf: typeof j?.newsAsOf === "string" ? j.newsAsOf : null,
    };
  } catch {
    return { ivHistory: [], news: [], events: [], newsAsOf: null };
  }
}

/**
 * News + corporate events for one symbol. Google News and the NSE calendar are
 * independent and both flaky, so they're settled separately — one failing must
 * not cost us the other.
 */
async function fetchNewsBundle(symbol, name) {
  const [feed, nseEvents] = await Promise.all([
    fetchStockNews(symbol, name).catch(() => ({ news: [], events: [] })),
    nse.fetchEventCalendar(symbol).catch(() => []),
  ]);
  return { news: feed.news, events: feed.events, nseEvents };
}

/** Shared India VIX (market-wide) — one quote + one history call. */
async function fetchVix(token) {
  const today = todayIso();
  const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const [vixQ, vixC] = await Promise.all([
    upstox.quotes(token, [VIX_KEY]),
    upstox.dailyCandles(token, VIX_KEY, from, today),
  ]);
  return { value: A.round(vixQ[VIX_KEY]?.lastPrice ?? null, 2), closes: (vixC.history ?? []).map((p) => p.v) };
}

/**
 * Rebuild ONE stock and merge it into the already-published set. Rewrites its
 * per-stock file and patches its row in index.json (spot/structure/verdict/top
 * candidate). Liquidity is a cross-universe percentile — it can't be recomputed
 * from one name, and it's stable intraday, so the existing bucket is kept. The
 * screener's own `asOf` (last full run) is left as-is; the fresh per-stock file
 * carries its own timestamp for the detail view. candidates.json is left to the
 * next full cron.
 */
async function buildOneSymbol(token, symbol, instruments, nameBySym, equityKeys, vix, sectorBySym = {}) {
  const name = nameBySym[symbol] ?? symbol;
  const raw = await fetchStock(token, symbol, instruments, equityKeys[symbol]);
  if (raw) raw.sector = sectorBySym[symbol] ?? null;
  if (!raw) {
    console.error(`single: ${symbol} could not be built (no chain?) — leaving published data as-is.`);
    process.exit(0);
  }
  const slug = fileSlug(symbol);
  const prev = await readPrevStock(slug);
  // The on-demand path ALWAYS fetches — this is the "Fetch latest news" button.
  const newsBundle = await fetchNewsBundle(symbol, name);
  raw.prevNews = prev.news;
  raw.prevEvents = prev.events;
  raw.prevNewsAsOf = prev.newsAsOf;
  const { snap } = buildStock(name, raw, vix, prev.ivHistory, newsBundle);
  await writeFile(resolve(STOCKS_DIR, `${slug}.json`), JSON.stringify(snap));

  const idxPath = resolve(STOCKS_DIR, "index.json");
  let idx;
  try {
    idx = JSON.parse(await readFile(idxPath, "utf8"));
  } catch {
    idx = { asOf: new Date().toISOString(), count: 0, vix: vix.value, stocks: [] };
  }
  const existing = idx.stocks.find((r) => r.symbol === symbol);
  const top = (snap.expiries[snap.defaultExpiry].candidates ?? [])[0] ?? null;
  const row = {
    symbol,
    name,
    file: slug,
    spot: snap.spot.price,
    changePct: snap.spot.changePct,
    sector: snap.sector ?? existing?.sector ?? null,
    liquidity: existing?.liquidity ?? { bucket: "None", score: 0 },
    structure: snap.structure ? { label: snap.structure.label, bias: snap.structure.bias } : null,
    verdict: { verdict: snap.verdict.verdict, score: snap.verdict.score },
    topCandidate: top ? topCandidateRow(top) : null,
    conviction: top?.conviction ?? null,
    vrp: snap.expiries[snap.defaultExpiry].metrics.vrp ?? null,
    ivRank: snap.expiries[snap.defaultExpiry].metrics.ivRank ?? null,
  };
  idx.stocks = [...idx.stocks.filter((r) => r.symbol !== symbol), row].sort((a, b) => b.liquidity.score - a.liquidity.score);
  idx.count = idx.stocks.length;
  idx.vix = vix.value;
  await writeFile(idxPath, JSON.stringify(idx));
  console.log(`stocks(single): refreshed ${symbol} spot=${snap.spot.price} verdict=${snap.verdict.verdict} ${snap.verdict.score}`);
}

async function main() {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) {
    console.error("UPSTOX_ACCESS_TOKEN missing — cannot build stocks.");
    process.exit(0);
  }
  await mkdir(STOCKS_DIR, { recursive: true });

  const instruments = await upstox.fetchInstruments("NSE");
  if (!instruments.length) {
    console.error("no NSE instrument master — aborting (last-good preserved).");
    process.exit(0);
  }
  const symbols = STOCKS.map(([s]) => s);
  const nameBySym = Object.fromEntries(STOCKS.map(([s, n]) => [s, n]));
  const sectorBySym = Object.fromEntries(STOCKS.map(([s, , sec]) => [s, sec ?? null]));
  const equityKeys = upstox.pickEquityKeys(instruments, symbols);
  const vix = await fetchVix(token);

  // On-demand single-stock refresh path.
  if (ONLY_SYMBOL) {
    await buildOneSymbol(token, ONLY_SYMBOL, instruments, nameBySym, equityKeys, vix, sectorBySym);
    return;
  }

  // Read every previous file up front, because the news slice is chosen from
  // them: the STALEST names by `newsAsOf`. That cycles the universe with no
  // cursor to persist, and a stock that has never been fetched (no newsAsOf)
  // sorts first, so new listings fill in immediately.
  const prevBySlug = Object.fromEntries(
    await Promise.all(STOCKS.map(async ([sym]) => [fileSlug(sym), await readPrevStock(fileSlug(sym))])),
  );
  const newsQueue = new Set(
    [...STOCKS]
      .sort((a, b) =>
        (prevBySlug[fileSlug(a[0])].newsAsOf ?? "") < (prevBySlug[fileSlug(b[0])].newsAsOf ?? "") ? -1 : 1,
      )
      .slice(0, NEWS_PER_RUN)
      .map(([sym]) => sym),
  );

  const built = await pool(STOCKS, CONCURRENCY, async ([symbol, name, sector]) => {
    const slug = fileSlug(symbol);
    // Read BEFORE writing — the seeded file is the previous run's published copy.
    const prev = prevBySlug[slug];
    const raw = await fetchStock(token, symbol, instruments, equityKeys[symbol]);
    if (!raw) return { symbol, name, ok: false };
    raw.sector = sector ?? null;
    raw.prevNews = prev.news;
    raw.prevEvents = prev.events;
    raw.prevNewsAsOf = prev.newsAsOf;
    const newsBundle = newsQueue.has(symbol) ? await fetchNewsBundle(symbol, name) : null;
    const { snap, liquidityRaw, liquidityByExpiry, dfltMetrics } = buildStock(name, raw, vix, prev.ivHistory, newsBundle);
    await writeFile(resolve(STOCKS_DIR, `${slug}.json`), JSON.stringify(snap));
    return { symbol, name, ok: true, snap, liquidityRaw, liquidityByExpiry, dfltMetrics };
  });

  const ok = built.filter((b) => b && b.ok);
  // Cross-universe liquidity percentile → bucket.
  const scores = ok.map((b) => b.liquidityRaw).sort((a, b) => a - b);
  const rankOf = (x) => (scores.length ? scores.filter((v) => v <= x).length / scores.length : 0);

  const rows = ok
    .map((b) => {
      const rank = rankOf(b.liquidityRaw);
      const bucket = A.liquidityBucket(rank, b.liquidityRaw);
      const dfltBlock = b.snap.expiries[b.snap.defaultExpiry];
      const top = (dfltBlock.candidates ?? [])[0] ?? null;
      return {
        symbol: b.symbol,
        name: b.name,
        file: fileSlug(b.symbol),
        spot: b.snap.spot.price,
        changePct: b.snap.spot.changePct,
        sector: b.snap.sector ?? null,
        liquidity: { bucket, score: A.round(rank * 100, 0) },
        structure: b.snap.structure ? { label: b.snap.structure.label, bias: b.snap.structure.bias } : null,
        verdict: { verdict: b.snap.verdict.verdict, score: b.snap.verdict.score },
        topCandidate: top ? topCandidateRow(top) : null,
        // Best conviction available on this name, so the list can be sorted by it.
        conviction: top?.conviction ?? null,
        vrp: dfltBlock.metrics.vrp ?? null,
        ivRank: dfltBlock.metrics.ivRank ?? null,
      };
    })
    .sort((a, b) => b.liquidity.score - a.liquidity.score);

  // --- Cross-universe candidates, one block PER EXPIRY SLOT -----------------
  // Each slot is gated on its own chain's liquidity cohort. Far-month NSE
  // single-stock options are genuinely thin, so the "next" list is often much
  // shorter than the current one — that is the honest answer, not a bug, and
  // `thin` tells the UI to say so.
  const bucketBySymbol = new Map(rows.map((r) => [r.symbol, r.liquidity.bucket]));
  const expiryBlocks = [];

  for (const slot of EXPIRY_SLOTS) {
    const cohort = ok.filter((b) => b.liquidityByExpiry?.[slot]?.raw > 0);
    if (!cohort.length) continue;
    // Rank this slot against ITSELF, never against the near month.
    const slotScores = cohort.map((b) => b.liquidityByExpiry[slot].raw).sort((a, b) => a - b);
    const slotRank = (x) => slotScores.filter((v) => v <= x).length / slotScores.length;

    const list = [];
    let date = null, dte = null;
    for (const b of cohort) {
      const meta = b.liquidityByExpiry[slot];
      const bucket = A.liquidityBucket(slotRank(meta.raw), meta.raw);
      if (!TRADEABLE_BUCKETS.includes(bucket)) continue;
      const exp = b.snap.expiries[meta.date];
      if (!exp) continue;
      date ??= meta.date;
      dte ??= meta.dte;
      for (const c of exp.candidates ?? []) {
        // SPREAD the scored candidate rather than re-listing its fields. An
        // explicit list silently dropped tailReliance/cvar/worst on their first
        // run — the per-stock files had them, candidates.json didn't, and the UI
        // reads candidates.json. Spreading makes that class of bug impossible.
        list.push({
          ...c,
          symbol: b.symbol,
          name: b.name,
          file: fileSlug(b.symbol),
          expiry: exp.date,
          dte: exp.dte,
          creditPerLot: A.round(c.ltp * (b.snap.lotSize ?? 1), 0),
          liquidity: bucket,
          vrp: exp.metrics.vrp ?? null,
          ivRank: exp.metrics.ivRank ?? null,
        });
      }
    }
    list.sort((a, b) => b.conviction - a.conviction);
    // Diversify: keep only each name's best few strikes. Adjacent strikes on one
    // stock are the same trade at slightly different odds, and one rich name
    // would otherwise fill the entire list.
    const perSymbol = new Map();
    const top = [];
    for (const c of list) {
      const n = perSymbol.get(c.symbol) ?? 0;
      if (n >= MAX_PER_SYMBOL) continue;
      perSymbol.set(c.symbol, n + 1);
      top.push(c);
      if (top.length >= 24) break;
    }
    expiryBlocks.push({
      slot,
      label: slot === "current" ? "Current expiry" : "Next expiry",
      date: date ?? null,
      dte: dte ?? null,
      liquidNames: cohort.filter((b) => TRADEABLE_BUCKETS.includes(A.liquidityBucket(slotRank(b.liquidityByExpiry[slot].raw), b.liquidityByExpiry[slot].raw))).length,
      candidateCount: list.length,
      thin: top.length < THIN_EXPIRY_CANDIDATES,
      candidates: top,
    });
  }

  const asOf = new Date().toISOString();
  await writeFile(resolve(STOCKS_DIR, "index.json"), JSON.stringify({ asOf, count: rows.length, vix: vix.value, stocks: rows }));
  await writeFile(
    resolve(STOCKS_DIR, "candidates.json"),
    // `candidates` stays at the top level as the current-expiry list so a
    // cached older frontend keeps rendering while the new one reads `expiries`.
    JSON.stringify({ asOf, expiries: expiryBlocks, candidates: expiryBlocks[0]?.candidates ?? [] }),
  );

  console.log(
    `stocks: built ${ok.length}/${STOCKS.length}; news refreshed for ${[...newsQueue].join(",")}; ` +
      expiryBlocks.map((e) => `${e.slot} ${e.date} ${e.candidates.length} cand${e.thin ? " (thin)" : ""}`).join("; ") +
      `; vix=${vix.value}`,
  );
}

// Only run the pipeline when invoked as a script (not when imported for tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-stocks fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}

export { buildStock, computeExpiry, buildHorizons, fileSlug };
