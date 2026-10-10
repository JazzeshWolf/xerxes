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
import * as A from "./analytics.mjs";
import { fetchCompanyBundle, mergeEvents, impliedEvent, pruneEvents, pruneNews, pruneFilings } from "./stock-news.mjs";
import { STOCKS } from "./stocks-universe.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../public/data");
const STOCKS_DIR = resolve(DATA_DIR, "stocks");

const VIX_KEY = "NSE_INDEX|India VIX";
// The benchmark every stock is measured against on its Outlook tab.
const BENCH_KEY = "NSE_INDEX|Nifty 50";
const BENCH_NAME = "NIFTY 50";
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
const THIN_EXPIRY_CANDIDATES = 8; // fewer than this in a slot → warn the user loudly
// Per-stock news is fetched for the STALEST few names each full run, not all of
// them — one Google News query per symbol across the universe every 20 minutes
// would be rate-limited into uselessness. Picking by staleness means the
// universe cycles on its own with no counter to keep, and cached news survives
// because the workflow seeds public/data/stocks from the published branch on
// every run (the same mechanism ivHistory relies on). The single-symbol refresh
// path always fetches, so the in-app "Fetch latest news" button is immediate.
//
// The budget is split. Priority slots go to the names that matter right now —
// the previous run's sell candidates and stocks moving on their own story —
// and the rest keep the staleness rotation. Plain rotation took a ~2-3 h lap,
// so the name you were about to sell could carry 2 h-old news; prioritising it
// is what made a live "fetch news" button (and the Worker it needed) unneeded.
//
// Candidates are refreshed once their news is older than CANDIDATE_NEWS_MAX_AGE
// — every other run, so all ~25 candidate names stay under ~40 min old for ~13
// fetches a run. Every-run for all of them would eat the whole budget, and the
// conviction scores are too bunched (21 names at 60-75 on 9 Oct) to justify
// refreshing only a top few. Movers are refreshed every run: they are the names
// where something is happening now.
const NEWS_PER_RUN = 40;
const NEWS_CANDIDATES_MAX = 16;
const NEWS_MOVERS_MAX = 4;
const CANDIDATE_NEWS_MAX_AGE_MS = 35 * 60 * 1000;
// Movers skip only a back-to-back run (cron-job.org and the in-repo schedule
// backups can land minutes apart).
const MOVER_NEWS_MAX_AGE_MS = 10 * 60 * 1000;
// A "mover": the part of today's move that neither NIFTY (× beta) nor the
// sector explains is at least this big, or volume is running this far above
// its usual pace. Same split as the Outlook tab (src/lib/outlook.ts).
const MOVER_OWN_PCT = 2;
const MOVER_VOLUME_PACE = 2.5;
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
    // Top of book. Published because the per-strike quote gate is only
    // auditable from the artifact if the evidence ships with it. bidQty/askQty/
    // close stay on the raw row (`_rawChain`), which scoring already reaches.
    bid: o.bid ?? null,
    ask: o.ask ?? null,
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

  const gate = {};
  const candidates = A.sellCandidates(chain, spot, t, expectedMove, {
    maxDelta: 0.25,
    minPremium: Math.max(1, spot * 0.0004),
    // The per-strike quote gate lives HERE, upstream of the `.slice(0, 24)`
    // below. Gating after the slice would take a block of 24 stale strikes down
    // to a handful; gating before it lets 24 *tradable* strikes be picked in the
    // first place. `lotSize` is required because the OI floor is in lots.
    lotSize: ctx.lotSize ?? 1,
    stats: gate,
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
    _gate: gate,
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
    const conv = A.sellConviction({
      type: c.type,
      strike: c.strike,
      // Score the price a seller is actually credited at. Identical to `ltp`
      // while markAt is "ltp"; the substitution is what carries the bid through
      // to edge, edgePct, fair, tailReliance and vrp in one place.
      ltp: c.mark ?? c.ltp,
      iv: c.iv,
      oi: row?.oi ?? c.oi,
      volume: c.volume ?? row?.volume ?? 0,
      // Per-strike quote verdict from the gate in `sellCandidates`.
      quote: c.quoteQuality != null
        ? { quality: c.quoteQuality, spreadPct: c.spreadPct, oiLots: c.oiLots, volume: c.volume ?? 0 }
        : null,
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
        // Items are `[symbol, …]` tuples in the fetch pass and `{symbol, …}`
        // objects in the scoring pass — label either, so a thrown error names
        // the stock instead of logging "stock undefined".
        const it = items[idx];
        console.warn(`stock ${(Array.isArray(it) ? it[0] : it?.symbol) ?? "?"}: ${e.message}`);
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
    volume: uq?.volume ?? null,
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

/**
 * The "what's moving this stock" context: trailing returns, beta to NIFTY and
 * today's volume pace, plus the benchmark's own numbers so the client can split
 * the day's move without another fetch. Every field is null-safe — a run where
 * the benchmark fetch failed still publishes the stock's own returns.
 */
function buildOutlook(raw, spot, changePct, bench) {
  const today = todayIso();
  const prior = (raw.ohlc ?? []).filter((b) => b.t < today);
  const perf = { d1: changePct, ...A.trailingReturns(prior, spot) };
  return {
    perf,
    beta: bench?.history?.length ? A.betaTo(prior, bench.history.filter((p) => p.t < today)) : null,
    volume: A.volumePace(raw.volume, prior),
    benchmark: bench ? { name: BENCH_NAME, perf: bench.perf } : null,
  };
}

function buildStock(name, raw, vix, prevIvHistory = [], newsBundle = null, bench = null) {
  const spot = raw.spot;
  const expiries = {};
  const ordered = raw.orderedExpiries.filter((e) => raw.chainsByExpiry[e]);
  const gap = A.gapProfile(raw.ohlc ?? [], 60);
  for (const e of ordered) {
    const trimmed = trimToWindow(raw.chainsByExpiry[e], spot);
    expiries[e] = computeExpiry(trimmed, spot, e, "monthly", { ohlc: raw.ohlc, lotSize: raw.lotSize ?? 1 });
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

  const outlook = buildOutlook(raw, spot, changePct, bench);

  const publicExpiries = {};
  for (const [e, b] of Object.entries(expiries)) {
    const { _flow, _pcr, _maxPain, _skew, _em, _t, _sigmaForecast, _rawChain, _gate, ...pub } = b;
    void _flow, void _pcr, void _maxPain, void _skew, void _em, void _t, void _sigmaForecast, void _rawChain, void _gate;
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
      // Cached events are pruned every run, so a build that doesn't re-fetch
      // still drops what has gone by. The options-implied entry is excluded
      // from the carry-forward because it is recomputed below from today's
      // term structure.
      newsBundle?.events ?? pruneEvents(raw.prevEvents?.filter((e) => e.source !== "options") ?? []),
      pruneEvents(newsBundle?.nseEvents ?? []),
      // NSE is bot-walled and fails more often than not. When this pass got
      // nothing back from it, keep the NSE dates we already had — a failed
      // fetch is not evidence that the results date went away.
      newsBundle && !newsBundle.nseOk ? pruneEvents(raw.prevEvents?.filter((e) => e.source === "nse") ?? []) : [],
      [impliedEvent(term?.slopePts ?? null, defaultExpiry)].filter(Boolean),
    ).slice(0, 10),
    // Cached news is re-filtered every build, so tightening the relevance guard
    // takes effect immediately rather than when the name next cycles through
    // the fetch queue.
    news: newsBundle?.news ?? pruneNews(raw.prevNews ?? [], raw.symbol, name),
    newsAsOf: newsBundle ? new Date().toISOString() : raw.prevNewsAsOf ?? null,
    // Recent price-sensitive exchange filings (con-call schedules, AGM notices,
    // order wins). Carried forward like news, and when NSE didn't answer.
    filings: newsBundle?.nseOk ? newsBundle.filings : pruneFilings(raw.prevFilings ?? []),
    // How the name has traded against NIFTY — the stock Outlook tab.
    outlook,
    verdict,
    structure,
  };
  // Quote-gate counters, summed across this name's expiries. Routed out
  // separately because `_gate` is stripped from the published block above.
  const gate = {};
  for (const b of Object.values(expiries))
    for (const [k, v] of Object.entries(b._gate ?? {})) gate[k] = (gate[k] ?? 0) + v;

  return { snap, liquidityRaw: liquidity, liquidityByExpiry, dfltMetrics: dflt.metrics, gate };
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
      filings: Array.isArray(j?.filings) ? j.filings : [],
    };
  } catch {
    return { ivHistory: [], news: [], events: [], newsAsOf: null, filings: [] };
  }
}

/**
 * Which names get their news re-fetched this run: the `limit` stalest by
 * `newsAsOf`, a stock that has never been fetched sorting first.
 *
 * ⚠️ `symbols` must be the names that ACTUALLY RESOLVED to a chain this run,
 * never the raw universe. A symbol with no live F&O contracts (delisted,
 * renamed — ZOMATO→ETERNAL, LTIM→LTM, and ~33 others in the shipped list)
 * never writes a per-stock file, so its `newsAsOf` is null on every future run
 * too. Feed the universe in and those dead names win the staleness sort
 * *permanently*, taking every slot on every build.
 *
 * That is not hypothetical — it is what production did. The same 15 dead
 * tickers were fetched every 20 minutes for days while 48 live names,
 * DELHIVERY among them, never got news at all. The queue looked busy in the
 * logs, which is exactly why it went unnoticed.
 */
export function pickNewsQueue(symbols, newsAsOfBySymbol, limit) {
  return new Set(
    [...symbols]
      // Ties must compare equal: a comparator that returns ±1 for equal keys is
      // inconsistent, and with every never-fetched name tying at "" that is
      // most of the list.
      .sort((a, b) => String(newsAsOfBySymbol[a] ?? "").localeCompare(String(newsAsOfBySymbol[b] ?? "")))
      .slice(0, limit),
  );
}

/**
 * Symbols on the previous run's sell-candidate lists, best conviction first,
 * each once. Read from the SEEDED candidates.json: this run's list doesn't
 * exist until scoring, which comes after news. One run (~20 min) old is fine
 * for deciding whose headlines to refresh.
 */
export function candidateSymbols(candidatesJson) {
  const rows = (candidatesJson?.expiries ?? []).flatMap((e) => e?.candidates ?? []);
  if (!rows.length) rows.push(...(candidatesJson?.candidates ?? [])); // older shape
  const best = new Map();
  for (const c of rows) {
    if (!c?.symbol) continue;
    const v = Number(c.conviction) || 0;
    if (!best.has(c.symbol) || v > best.get(c.symbol)) best.set(c.symbol, v);
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/**
 * Stocks moving on their own story today, biggest first. `rows` are
 * `{ symbol, sector, changePct, beta, pace }` from the chain pass; the split is
 * the Outlook tab's: own = move − beta × NIFTY − (sector median − NIFTY). Volume alone also
 * qualifies — heavy trading with a flat price is often news not yet in the move.
 */
export function findMovers(rows, benchD1, { minOwn = MOVER_OWN_PCT, minPace = MOVER_VOLUME_PACE } = {}) {
  const bySector = new Map();
  for (const r of rows) {
    if (r.sector == null || r.changePct == null) continue;
    if (!bySector.has(r.sector)) bySector.set(r.sector, []);
    bySector.get(r.sector).push(r);
  }
  const median = (xs) => {
    const v = [...xs].sort((a, b) => a - b);
    if (!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const out = [];
  for (const r of rows) {
    if (r.changePct == null) continue;
    // Median of the WHOLE sector, the stock included, and only for 3+ names.
    // Excluding the stock looks purer but lets one big mover contaminate its
    // neighbours: in a 3-name sector BHEL +5% made LT and ABB read as −2%
    // "own" moves. With the stock in, a lone outlier can't move the median.
    const sectorMoves = (bySector.get(r.sector) ?? []).map((p) => p.changePct);
    const sectorMed = sectorMoves.length >= 3 ? median(sectorMoves) : null;
    const market = benchD1 != null ? (r.beta ?? 1) * benchD1 : 0;
    const sector = sectorMed != null ? sectorMed - (benchD1 ?? 0) : 0;
    const own = r.changePct - market - sector;
    const heavy = r.pace != null && r.pace >= minPace;
    if (Math.abs(own) >= minOwn || heavy) out.push({ symbol: r.symbol, own, pace: r.pace ?? null, score: Math.abs(own) + (heavy ? minOwn : 0) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * This run's priority news set: movers (refreshed every run, capped) and the
 * previous list's candidates whose news has gone stale (best conviction first,
 * capped). Dead tickers never take a slot. Returns the set plus the breakdown
 * for the run log.
 */
export function pickNewsPriority(
  { candidates = [], movers = [], live, newsAsOfBySymbol = {}, now = Date.now() },
  {
    candidatesMax = NEWS_CANDIDATES_MAX,
    moversMax = NEWS_MOVERS_MAX,
    candidateMaxAgeMs = CANDIDATE_NEWS_MAX_AGE_MS,
    moverMaxAgeMs = MOVER_NEWS_MAX_AGE_MS,
  } = {},
) {
  const olderThan = (s, ms) => {
    if (!live.has(s)) return false;
    const t = Date.parse(newsAsOfBySymbol[s] ?? "");
    return !Number.isFinite(t) || now - t >= ms;
  };
  const set = new Set();
  const fromMovers = [];
  for (const m of movers) {
    if (fromMovers.length >= moversMax) break;
    if (!set.has(m.symbol) && olderThan(m.symbol, moverMaxAgeMs)) {
      set.add(m.symbol);
      fromMovers.push(m.symbol);
    }
  }
  const fromCandidates = [];
  for (const s of candidates) {
    if (fromCandidates.length >= candidatesMax) break;
    if (!set.has(s) && olderThan(s, candidateMaxAgeMs)) {
      set.add(s);
      fromCandidates.push(s);
    }
  }
  return { set, fromCandidates, fromMovers };
}

/**
 * News, events and exchange filings for one symbol — `fetchCompanyBundle`,
 * which the refresh Worker's live /news endpoint also calls, so the build and
 * the button can never disagree. Each source inside it settles separately; one
 * failing never costs the others.
 */
async function fetchNewsBundle(symbol, name) {
  return fetchCompanyBundle(symbol, name).catch(() => ({ news: [], events: [], nseEvents: [], filings: [], nseOk: false }));
}

/**
 * NIFTY 50 once per run: live quote + daily closes. Gives every stock its
 * benchmark returns and the history beta is measured on. Fails soft to null —
 * the Outlook then shows the stock's own numbers without the comparison.
 */
async function fetchBenchmark(token) {
  const today = todayIso();
  const from = new Date(Date.now() - CANDLE_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const [q, c] = await Promise.all([
    upstox.quotes(token, [BENCH_KEY]),
    upstox.dailyCandles(token, BENCH_KEY, from, today),
  ]);
  const history = (c.history ?? []).filter((p) => p.v > 0);
  const quote = q[BENCH_KEY] ?? Object.values(q)[0] ?? null;
  const last = quote?.lastPrice ?? null;
  const prior = history.filter((p) => p.t < today);
  const prev = prior.at(-1)?.v ?? quote?.prevClose ?? null;
  if (!(last > 0) || !prior.length) {
    console.warn("benchmark: NIFTY unavailable — Outlook will publish without the comparison.");
    return null;
  }
  return {
    history,
    perf: { d1: prev > 0 ? A.round((last / prev - 1) * 100, 2) : null, ...A.trailingReturns(prior, last) },
  };
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
async function buildOneSymbol(token, symbol, instruments, nameBySym, equityKeys, vix, sectorBySym = {}, bench = null) {
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
  raw.prevFilings = prev.filings;
  const { snap } = buildStock(name, raw, vix, prev.ivHistory, newsBundle, bench);
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
    perf: snap.outlook?.perf ?? null,
    beta: snap.outlook?.beta ?? null,
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
  const [vix, bench] = await Promise.all([fetchVix(token), fetchBenchmark(token)]);

  // On-demand single-stock refresh path.
  if (ONLY_SYMBOL) {
    await buildOneSymbol(token, ONLY_SYMBOL, instruments, nameBySym, equityKeys, vix, sectorBySym, bench);
    return;
  }

  // Read every previous file up front: it carries each name's ivHistory, its
  // cached news/events, and the `newsAsOf` the news rotation is ordered by.
  const prevBySlug = Object.fromEntries(
    await Promise.all(STOCKS.map(async ([sym]) => [fileSlug(sym), await readPrevStock(fileSlug(sym))])),
  );
  // Pass 1 — chains only. The news slice deliberately cannot be chosen yet:
  // picking it before we know which symbols resolved is what let dead tickers
  // monopolise the queue forever (see `pickNewsQueue`).
  const fetched = await pool(STOCKS, CONCURRENCY, async ([symbol, name, sector]) => {
    const raw = await fetchStock(token, symbol, instruments, equityKeys[symbol]);
    if (!raw) return null;
    raw.sector = sector ?? null;
    return { symbol, name, raw };
  });
  const live = fetched.filter(Boolean);

  // Pass 2 — news. First the priority set (last run's candidates + today's
  // own-story movers, refreshed every run), then the stalest of everyone else
  // with what's left of the budget. Only these do any network work; the rest
  // is CPU.
  const newsAsOfBySymbol = Object.fromEntries(live.map((s) => [s.symbol, prevBySlug[fileSlug(s.symbol)].newsAsOf]));
  const today = todayIso();
  const moverRows = live.map(({ symbol, raw }) => {
    const prior = (raw.ohlc ?? []).filter((b) => b.t < today);
    return {
      symbol,
      sector: raw.sector,
      changePct: raw.prevClose > 0 ? ((raw.spot - raw.prevClose) / raw.prevClose) * 100 : null,
      beta: bench?.history?.length ? A.betaTo(prior, bench.history.filter((p) => p.t < today)) : null,
      pace: A.volumePace(raw.volume, prior).pace,
    };
  });
  const prevCandidates = await readFile(resolve(STOCKS_DIR, "candidates.json"), "utf8")
    .then((t) => JSON.parse(t))
    .catch(() => null);
  const priority = pickNewsPriority({
    candidates: candidateSymbols(prevCandidates),
    movers: findMovers(moverRows, bench?.perf?.d1 ?? null),
    live: new Set(live.map((s) => s.symbol)),
    newsAsOfBySymbol,
  });
  const rotation = pickNewsQueue(
    live.map((s) => s.symbol).filter((s) => !priority.set.has(s)),
    newsAsOfBySymbol,
    NEWS_PER_RUN - priority.set.size,
  );
  const newsQueue = new Set([...priority.set, ...rotation]);

  const built = await pool(live, CONCURRENCY, async ({ symbol, name, raw }) => {
    const slug = fileSlug(symbol);
    // Read BEFORE writing — the seeded file is the previous run's published copy.
    const prev = prevBySlug[slug];
    raw.prevNews = prev.news;
    raw.prevEvents = prev.events;
    raw.prevNewsAsOf = prev.newsAsOf;
    raw.prevFilings = prev.filings;
    const newsBundle = newsQueue.has(symbol) ? await fetchNewsBundle(symbol, name) : null;
    const { snap, liquidityRaw, liquidityByExpiry, dfltMetrics, gate } = buildStock(name, raw, vix, prev.ivHistory, newsBundle, bench);
    await writeFile(resolve(STOCKS_DIR, `${slug}.json`), JSON.stringify(snap));
    return { symbol, name, ok: true, snap, liquidityRaw, liquidityByExpiry, dfltMetrics, gate };
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
        // Multi-period returns + beta, so a stock's Outlook can rank its whole
        // sector over 1W/1M/3M from index.json without fetching every peer.
        perf: b.snap.outlook?.perf ?? null,
        beta: b.snap.outlook?.beta ?? null,
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
          // The mark, not the last print. With markAt:"ltp" (today) these are
          // identical; when the bid becomes the mark this is what stops the
          // screen quoting a credit nobody could collect.
          creditPerLot: A.round((c.mark ?? c.ltp) * (b.snap.lotSize ?? 1), 0),
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
  await writeFile(
    resolve(STOCKS_DIR, "index.json"),
    JSON.stringify({
      asOf,
      count: rows.length,
      vix: vix.value,
      benchmark: bench ? { name: BENCH_NAME, perf: bench.perf } : null,
      stocks: rows,
    }),
  );
  await writeFile(
    resolve(STOCKS_DIR, "candidates.json"),
    // `candidates` stays at the top level as the current-expiry list so a
    // cached older frontend keeps rendering while the new one reads `expiries`.
    JSON.stringify({ asOf, expiries: expiryBlocks, candidates: expiryBlocks[0]?.candidates ?? [] }),
  );

  // Report the news backlog, not just who was fetched. The starved-queue bug
  // was invisible because the log happily listed 15 names every run; what it
  // never said was that the same 15 came back next time and nobody else moved.
  const neverFetched = live.filter(
    (s) => !newsQueue.has(s.symbol) && !prevBySlug[fileSlug(s.symbol)].newsAsOf,
  ).length;

  // Quote-gate telemetry, for the same reason the news backlog is printed: a
  // gate that silently over-fires is indistinguishable from a thin market. If
  // `kept` collapses on the post-close run, `bookOpen` is misfiring.
  const gate = {};
  for (const b of ok) for (const [k, v] of Object.entries(b.gate ?? {})) gate[k] = (gate[k] ?? 0) + v;
  const gateLine = Object.entries(gate)
    .filter(([k]) => k !== "kept")
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

  console.log(
    `stocks: built ${ok.length}/${STOCKS.length}; ` +
      `news priority: ${priority.set.size} (candidates ${priority.fromCandidates.length}: ${priority.fromCandidates.join(",") || "-"}; ` +
      `movers ${priority.fromMovers.length}: ${priority.fromMovers.join(",") || "-"}); ` +
      `rotation ${rotation.size}: ${[...rotation].join(",")} ` +
      `(${neverFetched} live names still awaiting first fetch); ` +
      `quote gate: kept ${gate.kept ?? 0}${gateLine ? ` (dropped ${gateLine})` : ""}; ` +
      expiryBlocks.map((e) => `${e.slot} ${e.date} ${e.candidates.length} cand${e.thin ? " (thin)" : ""}`).join("; ") +
      `; vix=${vix.value}; nifty=${bench ? `${bench.perf.d1}%` : "n/a"}`,
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
