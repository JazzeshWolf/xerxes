#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Xerxes — server-side data builder (runs in GitHub Actions).
//
// Loops over every configured index (NIFTY / BANKNIFTY / SENSEX), fetches the
// option chain for the nearest few expiries + spot + VIX + history, computes
// everything (PCR, max pain, OI walls, IV, expected move, direction verdict,
// sell candidates) per expiry, and writes one self-contained snapshot per
// index the browser renders directly: public/data/<index>.json
//
// Source order per index (fail-soft at every step):
//   1. Upstox API v2 (UPSTOX_ACCESS_TOKEN secret) — chain w/ OI+prev OI+IV+
//      greeks, spot, VIX, daily history, futures OI. Preferred.
//   2. NSE public API (token-less, bot-protected, works intermittently). NSE
//      indices only — does NOT cover SENSEX (BSE).
//   3. Yahoo Finance for daily index/VIX history.
//   4. Last-good snapshot, flagged `stale:true` — never fabricated numbers.
// ---------------------------------------------------------------------------

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as upstox from "./upstox.mjs";
import * as nse from "./nse.mjs";
import * as A from "./analytics.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../public/data");

// Index registry. `expirySelect` = how many of each cadence to fetch chains for
// (BANKNIFTY has no weeklies since Nov-2024). `exchange` picks the Upstox
// instrument master. NSE fallback only applies to `nseSymbol` indices.
const INDEXES = {
  NIFTY: {
    name: "NIFTY 50",
    exchange: "NSE",
    underlyingKey: "NSE_INDEX|Nifty 50",
    assetSymbol: "NIFTY",
    foSegment: "NSE_FO",
    nseSymbol: "NIFTY",
    yahoo: "^NSEI",
    expiryKind: "weekly (Tue)",
    expirySelect: { weeklies: 2, monthlies: 1 },
    file: "nifty.json",
  },
  BANKNIFTY: {
    name: "BANK NIFTY",
    exchange: "NSE",
    underlyingKey: "NSE_INDEX|Nifty Bank",
    assetSymbol: "BANKNIFTY",
    foSegment: "NSE_FO",
    nseSymbol: "BANKNIFTY",
    yahoo: "^NSEBANK",
    expiryKind: "monthly (last Tue)",
    expirySelect: { weeklies: 0, monthlies: 2 },
    file: "banknifty.json",
  },
  SENSEX: {
    name: "SENSEX",
    exchange: "BSE",
    underlyingKey: "BSE_INDEX|SENSEX",
    assetSymbol: "SENSEX",
    foSegment: "BSE_FO",
    nseSymbol: null, // BSE — no NSE public-API fallback
    yahoo: "^BSESN",
    expiryKind: "weekly (Thu)",
    expirySelect: { weeklies: 2, monthlies: 1 },
    file: "sensex.json",
  },
};

// Only build these (env override for local/testing, e.g. INDEX=NIFTY).
const ONLY = (process.env.INDEX || "").toUpperCase();
const TARGETS = ONLY ? [ONLY] : Object.keys(INDEXES);

const VIX_KEY = "NSE_INDEX|India VIX";
const YEAR_MS = 365 * 86400000;
const MAX_EXPIRIES = 4;

// Expiry cutoff: 15:30 IST = 10:00 UTC on the expiry date.
function timeToExpiryYears(expiryIso) {
  const cutoff = new Date(`${expiryIso}T10:00:00Z`).getTime();
  return Math.max((cutoff - Date.now()) / YEAR_MS, 0.25 / 365);
}
const todayIso = () => new Date().toISOString().slice(0, 10);
// Calendar days to expiry = difference of the two dates (NOT ceil of the raw
// time delta — that reads an expiry with a few hours left as "1 day", turning
// today's expiry into "tomorrow"). Runner is in market hours so UTC date = IST.
function dteCalendar(expiryIso) {
  const exp = Date.parse(`${expiryIso}T00:00:00Z`);
  const today = Date.parse(`${todayIso()}T00:00:00Z`);
  return Math.max(0, Math.round((exp - today) / 86400000));
}

/** Union of date-keyed series (later lists win), sorted ascending. */
function mergeByDate(...lists) {
  const m = new Map();
  for (const list of lists) for (const p of list || []) if (p && p.t && Number.isFinite(p.v)) m.set(p.t, p.v);
  return [...m.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => (a.t < b.t ? -1 : 1));
}

async function loadPrev(file) {
  try {
    return JSON.parse(await readFile(resolve(DATA_DIR, file), "utf8"));
  } catch {
    return null;
  }
}

/** Pick which upcoming expiries to fetch chains for, per the index's cadence. */
function selectExpiries(optionExpiries, select) {
  const labels = A.labelExpiries(optionExpiries);
  const weeklies = optionExpiries.filter((e) => labels[e] === "weekly");
  const monthlies = optionExpiries.filter((e) => labels[e] === "monthly");
  const chosen = [...weeklies.slice(0, select.weeklies), ...monthlies.slice(0, select.monthlies)];
  const ordered = [...new Set(chosen)].sort().slice(0, MAX_EXPIRIES);
  return { ordered, labels };
}

// --- Source A: Upstox --------------------------------------------------------
async function fetchViaUpstox(cfg, instruments) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token || !instruments?.length) return null;
  try {
    const today = todayIso();
    const picked = upstox.pickIndex(instruments, cfg.assetSymbol, cfg.foSegment, today);
    if (!picked || !picked.optionExpiries.length) {
      console.warn(`upstox: no ${cfg.assetSymbol} contracts found`);
      return null;
    }
    const { ordered, labels } = selectExpiries(picked.optionExpiries, cfg.expirySelect);
    if (!ordered.length) {
      console.warn(`upstox: no selectable ${cfg.assetSymbol} expiries`);
      return null;
    }
    const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const [chainResults, q, spot, vixC, futC] = await Promise.all([
      Promise.all(ordered.map((e) => upstox.optionChain(token, cfg.underlyingKey, e))),
      upstox.quotes(token, [cfg.underlyingKey, VIX_KEY, ...(picked.future ? [picked.future.key] : [])]),
      upstox.dailyCandles(token, cfg.underlyingKey, from, today),
      upstox.dailyCandles(token, VIX_KEY, from, today),
      picked.future
        ? upstox.dailyCandles(token, picked.future.key, from, today)
        : Promise.resolve({ history: [], oiHistory: [] }),
    ]);
    const chainsByExpiry = {};
    let chainSpot = null;
    ordered.forEach((e, i) => {
      const { chain, spot: cs } = chainResults[i];
      if (chain.length >= 10) chainsByExpiry[e] = chain;
      if (cs > 0) chainSpot = cs;
    });
    const gotExpiries = ordered.filter((e) => chainsByExpiry[e]);
    if (!gotExpiries.length) {
      console.warn(`upstox: all ${cfg.assetSymbol} chains too thin`);
      return null;
    }
    const spotQ = q[cfg.underlyingKey];
    const futQ = picked.future ? q[picked.future.key] : null;
    const spotPx = spotQ?.lastPrice ?? chainSpot ?? null;
    console.log(
      `upstox: ${cfg.assetSymbol} spot=${spotPx} expiries=${gotExpiries.join(",")} ` +
        `fut=${futQ?.lastPrice ?? "-"} vix=${q[VIX_KEY]?.lastPrice ?? "-"} hist=${spot.history.length}`,
    );
    return {
      source: "upstox",
      spot: spotPx,
      prevClose: spotQ?.prevClose ?? null,
      vix: q[VIX_KEY]?.lastPrice ?? null,
      vixHistory: vixC.history,
      spotHistory: spot.history,
      future:
        futQ?.lastPrice != null && picked.future
          ? { price: futQ.lastPrice, expiry: picked.future.expiry, oi: futQ.oi, oiHistory: futC.oiHistory }
          : null,
      chainsByExpiry,
      orderedExpiries: gotExpiries,
      labels,
      lotSize: picked.lotSize,
    };
  } catch (e) {
    console.warn(`upstox ${cfg.assetSymbol} failed: ${e.message}`);
    return null;
  }
}

// --- Source B: NSE public API (NSE indices only, nearest expiry only) --------
async function fetchViaNse(cfg) {
  if (!cfg.nseSymbol) return null;
  const res = await nse.fetchNseChain(cfg.nseSymbol);
  if (!res) return null;
  const [vix, spotHist, vixHist] = await Promise.all([
    nse.fetchNseVix(),
    nse.yahooHistory(cfg.yahoo),
    nse.yahooHistory("^INDIAVIX"),
  ]);
  const labels = A.labelExpiries(res.optionExpiries);
  return {
    source: "nse",
    spot: res.spot,
    prevClose: spotHist.length > 1 ? spotHist[spotHist.length - 2].v : null,
    vix,
    vixHistory: vixHist,
    spotHistory: spotHist,
    future: null,
    chainsByExpiry: { [res.expiry]: res.chain },
    orderedExpiries: [res.expiry],
    labels,
    lotSize: null,
  };
}

// --- Source C: local fixture (dev/testing only, XERXES_FIXTURE=path) --------
async function fetchViaFixture(cfg) {
  const f = process.env.XERXES_FIXTURE;
  if (!f) return null;
  try {
    const src = JSON.parse(await readFile(resolve(f), "utf8"));
    // Support both the new multi-expiry fixture and a legacy single-chain one.
    if (!src.chainsByExpiry && src.chain && src.expiry) {
      src.chainsByExpiry = { [src.expiry]: src.chain };
      src.orderedExpiries = [src.expiry];
    }
    src.labels = src.labels ?? A.labelExpiries(src.orderedExpiries ?? []);
    console.log(`fixture: loaded ${f} (${(src.orderedExpiries ?? []).length} expiries)`);
    return src;
  } catch (e) {
    console.warn(`fixture ${f}: ${e.message}`);
    return null;
  }
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

/** Per-expiry analytics block. */
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
    minPremium: Math.max(2, spot * 0.0004),
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
      ivRank: null, // filled for the default expiry only
      ivPercentile: null,
      rv20: null,
      straddle: A.round(straddle, 1),
      expectedMove: A.round(expectedMove, 0),
      skew: A.round(skew, 4),
      gex,
    },
    candidates: candidates.slice(0, 24),
    chain: slimChain(chain),
    _flow: flow,
    _pcr: pcr.oi,
    _maxPain: maxPain,
    _skew: skew,
    _em: expectedMove,
  };
}

/** Build one index's full snapshot from a normalized `raw` source. */
function buildIndex(cfg, raw, prev) {
  const spot = raw.spot;
  const today = todayIso();
  const spotHistory = mergeByDate(prev?.spot?.history ?? [], raw.spotHistory, [{ t: today, v: spot }]).slice(-300);
  const vixHistory = mergeByDate(
    prev?.vix?.history ?? [],
    raw.vixHistory,
    raw.vix != null ? [{ t: today, v: raw.vix }] : [],
  ).slice(-300);
  const closes = spotHistory.map((p) => p.v);
  const vixCloses = vixHistory.map((p) => p.v);
  const rv20 = A.realizedVol(closes, 20);

  // Previous close = last daily close BEFORE today (the live quote's ohlc.close
  // mirrors the current price for indices, so it can't give the day change).
  const priorPt = [...spotHistory].reverse().find((p) => p.t < today);
  const prevClose = priorPt?.v ?? raw.prevClose ?? null;

  // Per-expiry blocks (nearest first).
  const ordered = raw.orderedExpiries.filter((e) => raw.chainsByExpiry[e]);
  const expiries = {};
  for (const e of ordered) {
    expiries[e] = computeExpiry(raw.chainsByExpiry[e], spot, e, raw.labels[e] ?? "weekly");
  }
  // Default to the nearest expiry — on expiry day that's today's contract
  // (dte 0), which is what a seller is watching; the dropdown still offers the
  // later expiries for a cleaner directional read. The verdict card flags the
  // extreme 0-DTE gamma risk.
  const defaultExpiry = ordered[0];
  const dflt = expiries[defaultExpiry];

  // IV rank/percentile: accumulate the DEFAULT (near) expiry's ATM IV across
  // runs so the regime is tracked on a consistent tenor.
  let ivHistory = prev?.ivHistory ?? [];
  if (dflt.metrics.atmIv != null) {
    ivHistory = mergeByDate(ivHistory, [{ t: today, v: dflt.metrics.atmIv }]).slice(-370);
  }
  const ivSample = ivHistory.map((p) => p.v);
  dflt.metrics.rv20 = A.round(rv20, 4);
  if (ivSample.length >= 20 && dflt.metrics.atmIv != null) {
    dflt.metrics.ivRank = A.round(A.rangeRank(dflt.metrics.atmIv, ivSample), 1);
    dflt.metrics.ivPercentile = A.percentile(dflt.metrics.atmIv, ivSample);
  }

  const basisPts = raw.future?.price != null ? raw.future.price - spot : null;

  // Market structure: front-future OI day-change × price direction. OI history
  // comes from the futures daily candles (candle[6]); absent → structure=null
  // (fail honest). Index and front future move together intraday, so the index
  // % change is a fair price-direction proxy.
  const foi = raw.future?.oiHistory ?? [];
  const prevFutOi = foi.length > 1 ? foi[foi.length - 2].v : null;
  const curFutOi = raw.future?.oi ?? (foi.length ? foi[foi.length - 1].v : null);
  const futOiChgPct = prevFutOi > 0 && curFutOi != null ? (curFutOi - prevFutOi) / prevFutOi : null;
  const priceChgPct = prevClose > 0 ? (spot - prevClose) / prevClose : null;
  const structure = A.futuresStructure(priceChgPct, futOiChgPct);

  // Verdict on the decision-horizon (nearest) expiry.
  const verdict = A.directionScore({
    closes,
    vixHistory: vixCloses,
    pcrOi: dflt._pcr,
    maxPainStrike: dflt._maxPain,
    spot,
    expectedMove: dflt._em,
    flow: dflt._flow,
    skew: dflt._skew,
    basisPts,
  });

  // Strip the private `_*` helper fields before serialising.
  const publicExpiries = {};
  for (const [e, b] of Object.entries(expiries)) {
    const { _flow, _pcr, _maxPain, _skew, _em, ...pub } = b;
    void _flow, void _pcr, void _maxPain, void _skew, void _em;
    publicExpiries[e] = pub;
  }

  const changePct = prevClose > 0 ? A.round(((spot - prevClose) / prevClose) * 100, 2) : null;

  return {
    asOf: new Date().toISOString(),
    stale: false,
    source: raw.source,
    index: cfg.assetSymbol,
    name: cfg.name,
    expiryKind: cfg.expiryKind,
    lotSize: raw.lotSize ?? prev?.lotSize ?? null,
    spot: { price: A.round(spot, 2), prevClose: A.round(prevClose, 2), changePct, history: spotHistory },
    vix: { value: A.round(raw.vix, 2), history: vixHistory },
    future: raw.future
      ? { price: A.round(raw.future.price, 2), expiry: raw.future.expiry, oi: raw.future.oi, basisPts: A.round(basisPts, 1) }
      : null,
    defaultExpiry,
    expiries: publicExpiries,
    ivHistory,
    verdict,
    structure,
  };
}

async function buildOne(cfg, masters) {
  const prev = await loadPrev(cfg.file);
  const instruments = masters.get(cfg.exchange) ?? [];
  const raw =
    (await fetchViaFixture(cfg)) ?? (await fetchViaUpstox(cfg, instruments)) ?? (await fetchViaNse(cfg));

  if (!raw || !(raw.spot > 0) || !raw.orderedExpiries?.length) {
    if (prev) {
      await writeFile(resolve(DATA_DIR, cfg.file), JSON.stringify({ ...prev, stale: true }, null, 2) + "\n");
      console.warn(`${cfg.assetSymbol}: all sources failed; preserved last-good as stale.`);
    } else {
      console.warn(`${cfg.assetSymbol}: all sources failed and no prior snapshot.`);
    }
    return false;
  }

  const snap = buildIndex(cfg, raw, prev);
  await writeFile(resolve(DATA_DIR, cfg.file), JSON.stringify(snap, null, 2) + "\n");
  const d = snap.expiries[snap.defaultExpiry];
  console.log(
    `Wrote ${cfg.file}: spot=${snap.spot.price} (${snap.spot.changePct}%) ` +
      `expiries=${Object.keys(snap.expiries).length} pcr=${d.metrics.pcrOi} maxPain=${d.metrics.maxPain} ` +
      `em=${d.metrics.expectedMove} verdict=${snap.verdict.verdict} ${snap.verdict.score} [${raw.source}]`,
  );
  return true;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const cfgs = TARGETS.map((k) => INDEXES[k]).filter(Boolean);
  if (!cfgs.length) throw new Error(`No valid index in TARGETS: ${TARGETS}`);

  // Fetch each needed exchange's instrument master once, reused across indices.
  const masters = new Map();
  if (process.env.UPSTOX_ACCESS_TOKEN && !process.env.XERXES_FIXTURE) {
    for (const ex of [...new Set(cfgs.map((c) => c.exchange))]) {
      masters.set(ex, await upstox.fetchInstruments(ex));
    }
  }

  let ok = 0;
  for (const cfg of cfgs) {
    try {
      if (await buildOne(cfg, masters)) ok++;
    } catch (e) {
      console.error(`${cfg.assetSymbol} build error: ${e.message}`);
    }
  }
  console.log(`Done: ${ok}/${cfgs.length} indices built.`);
}

main().catch((e) => {
  console.error("build-data failed:", e);
  process.exit(1);
});
