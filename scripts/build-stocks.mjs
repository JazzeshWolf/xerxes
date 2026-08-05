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
import { STOCKS } from "./stocks-universe.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../public/data");
const STOCKS_DIR = resolve(DATA_DIR, "stocks");

const VIX_KEY = "NSE_INDEX|India VIX";
const YEAR_MS = 365 * 86400000;
const MONTHLIES = 2; // nearest N monthly expiries per stock (1M / 2M horizons)
const CONCURRENCY = 5; // chains in flight at once — respect Upstox limits
const CHAIN_WINDOW = 0.3; // keep strikes within ±30% of spot (trims size)

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

/** Per-expiry analytics block (same fields as the index build). */
function computeExpiry(chain, spot, expiryIso, label) {
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
      ivRank: null,
      ivPercentile: null,
      rv20: null,
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
  };
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
  const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);

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
    chainsByExpiry,
    orderedExpiries: gotExpiries,
    lotSize: picked.lotSize,
    future: futQ?.lastPrice != null && picked.future ? { price: futQ.lastPrice, expiry: picked.future.expiry, oi: futQ.oi } : null,
    prevClose: (closesC.history ?? []).map((p) => p).filter((p) => p.t < today).pop()?.v ?? uq?.prevClose ?? null,
  };
}

function buildStock(name, raw, vix) {
  const spot = raw.spot;
  const expiries = {};
  const ordered = raw.orderedExpiries.filter((e) => raw.chainsByExpiry[e]);
  for (const e of ordered) {
    const trimmed = trimToWindow(raw.chainsByExpiry[e], spot);
    expiries[e] = computeExpiry(trimmed, spot, e, "monthly");
  }
  const defaultExpiry = ordered[0];
  const dflt = expiries[defaultExpiry];

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

  const liquidity = A.liquidityScore(nearChain, raw.lotSize ?? 1, 0);

  const publicExpiries = {};
  for (const [e, b] of Object.entries(expiries)) {
    const { _flow, _pcr, _maxPain, _skew, _em, ...pub } = b;
    void _flow, void _pcr, void _maxPain, void _skew, void _em;
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
    ivHistory: [],
    verdict,
    structure,
  };
  return { snap, liquidityRaw: liquidity, dfltMetrics: dflt.metrics };
}

const fileSlug = (symbol) => symbol.replace(/[^A-Za-z0-9]/g, "_");

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
async function buildOneSymbol(token, symbol, instruments, nameBySym, equityKeys, vix) {
  const name = nameBySym[symbol] ?? symbol;
  const raw = await fetchStock(token, symbol, instruments, equityKeys[symbol]);
  if (!raw) {
    console.error(`single: ${symbol} could not be built (no chain?) — leaving published data as-is.`);
    process.exit(0);
  }
  const { snap } = buildStock(name, raw, vix);
  const slug = fileSlug(symbol);
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
    liquidity: existing?.liquidity ?? { bucket: "None", score: 0 },
    structure: snap.structure ? { label: snap.structure.label, bias: snap.structure.bias } : null,
    verdict: { verdict: snap.verdict.verdict, score: snap.verdict.score },
    topCandidate: top ? { type: top.type, strike: top.strike, probProfit: top.probProfit } : null,
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
  const nameBySym = Object.fromEntries(STOCKS);
  const equityKeys = upstox.pickEquityKeys(instruments, symbols);
  const vix = await fetchVix(token);

  // On-demand single-stock refresh path.
  if (ONLY_SYMBOL) {
    await buildOneSymbol(token, ONLY_SYMBOL, instruments, nameBySym, equityKeys, vix);
    return;
  }

  const built = await pool(STOCKS, CONCURRENCY, async ([symbol, name]) => {
    const raw = await fetchStock(token, symbol, instruments, equityKeys[symbol]);
    if (!raw) return { symbol, name, ok: false };
    const { snap, liquidityRaw, dfltMetrics } = buildStock(name, raw, vix);
    await writeFile(resolve(STOCKS_DIR, `${fileSlug(symbol)}.json`), JSON.stringify(snap));
    return { symbol, name, ok: true, snap, liquidityRaw, dfltMetrics };
  });

  const ok = built.filter((b) => b && b.ok);
  // Cross-universe liquidity percentile → bucket.
  const scores = ok.map((b) => b.liquidityRaw).sort((a, b) => a - b);
  const rankOf = (x) => (scores.length ? scores.filter((v) => v <= x).length / scores.length : 0);

  const rows = ok
    .map((b) => {
      const rank = rankOf(b.liquidityRaw);
      const bucket = A.liquidityBucket(rank, b.liquidityRaw);
      const top = (b.snap.expiries[b.snap.defaultExpiry].candidates ?? [])[0] ?? null;
      return {
        symbol: b.symbol,
        name: b.name,
        file: fileSlug(b.symbol),
        spot: b.snap.spot.price,
        changePct: b.snap.spot.changePct,
        liquidity: { bucket, score: A.round(rank * 100, 0) },
        structure: b.snap.structure ? { label: b.snap.structure.label, bias: b.snap.structure.bias } : null,
        verdict: { verdict: b.snap.verdict.verdict, score: b.snap.verdict.score },
        topCandidate: top ? { type: top.type, strike: top.strike, probProfit: top.probProfit } : null,
      };
    })
    .sort((a, b) => b.liquidity.score - a.liquidity.score);

  // Top premium-selling candidates across the universe (liquidity ≥ Medium).
  const liquidEnough = new Set(
    rows.filter((r) => ["Medium", "Medium-High", "High"].includes(r.liquidity.bucket)).map((r) => r.symbol),
  );
  const candScore = (c) => c.ltp * c.probProfit * (c.cushionSigma ?? 0.5);
  const candidates = [];
  for (const b of ok) {
    if (!liquidEnough.has(b.symbol)) continue;
    const exp = b.snap.expiries[b.snap.defaultExpiry];
    for (const c of exp.candidates ?? []) {
      candidates.push({
        symbol: b.symbol,
        name: b.name,
        file: fileSlug(b.symbol),
        expiry: exp.date,
        dte: exp.dte,
        type: c.type,
        strike: c.strike,
        ltp: c.ltp,
        delta: c.delta,
        iv: c.iv,
        distancePct: c.distancePct,
        cushionSigma: c.cushionSigma,
        probProfit: c.probProfit,
        probTouch: c.probTouch,
        creditPerLot: A.round(c.ltp * (b.snap.lotSize ?? 1), 0),
        liquidity: rows.find((r) => r.symbol === b.symbol)?.liquidity.bucket ?? null,
        _rank: candScore(c),
      });
    }
  }
  candidates.sort((a, b) => b._rank - a._rank);
  const topCandidates = candidates.slice(0, 24).map(({ _rank, ...c }) => (void _rank, c));

  const asOf = new Date().toISOString();
  await writeFile(resolve(STOCKS_DIR, "index.json"), JSON.stringify({ asOf, count: rows.length, vix: vix.value, stocks: rows }));
  await writeFile(resolve(STOCKS_DIR, "candidates.json"), JSON.stringify({ asOf, candidates: topCandidates }));

  console.log(`stocks: built ${ok.length}/${STOCKS.length}; ${topCandidates.length} top candidates; vix=${vix.value}`);
}

// Only run the pipeline when invoked as a script (not when imported for tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-stocks fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}

export { buildStock, computeExpiry, buildHorizons, fileSlug };
