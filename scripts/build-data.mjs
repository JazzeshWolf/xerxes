#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Xerxes — server-side data builder (runs in GitHub Actions).
//
// Fetches the index option chain + spot + VIX + history, computes everything
// (PCR, max pain, OI walls, IV, expected move, direction verdict, sell
// candidates) and writes a single self-contained snapshot the browser
// renders directly: public/data/<index>.json
//
// Source order (fail-soft at every step):
//   1. Upstox API v2 (UPSTOX_ACCESS_TOKEN secret) — chain w/ OI+prev OI+IV+
//      greeks, spot, VIX, daily history. Preferred.
//   2. NSE public API (token-less, bot-protected, works intermittently).
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

// Multi-index ready: BANKNIFTY / SENSEX get enabled in later passes.
const INDEXES = {
  NIFTY: {
    name: "NIFTY 50",
    underlyingKey: "NSE_INDEX|Nifty 50",
    assetSymbol: "NIFTY",
    foSegment: "NSE_FO",
    nseSymbol: "NIFTY",
    yahoo: "^NSEI",
    expiryKind: "weekly (Tue)",
    file: "nifty.json",
  },
};
const INDEX = (process.env.INDEX || "NIFTY").toUpperCase();
const VIX_KEY = "NSE_INDEX|India VIX";
const YEAR_MS = 365 * 86400000;

// Expiry cutoff: 15:30 IST = 10:00 UTC on the expiry date.
function timeToExpiryYears(expiryIso) {
  const cutoff = new Date(`${expiryIso}T10:00:00Z`).getTime();
  return Math.max((cutoff - Date.now()) / YEAR_MS, 0.25 / 365);
}
function dteCalendar(expiryIso) {
  const cutoff = new Date(`${expiryIso}T10:00:00Z`).getTime();
  return Math.max(0, Math.ceil((cutoff - Date.now()) / 86400000));
}

const todayIso = () => new Date().toISOString().slice(0, 10);

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

// --- Source A: Upstox --------------------------------------------------------
async function fetchViaUpstox(cfg) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) return null;
  try {
    const today = todayIso();
    const instruments = await upstox.fetchInstruments();
    const picked = upstox.pickIndex(instruments, cfg.assetSymbol, cfg.foSegment, today);
    if (!picked || !picked.optionExpiries.length) {
      console.warn(`upstox: no ${cfg.assetSymbol} contracts found`);
      return null;
    }
    const expiry = picked.optionExpiries[0];
    const from = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const [{ chain, spot: chainSpot }, q, spotHist, vixHist] = await Promise.all([
      upstox.optionChain(token, cfg.underlyingKey, expiry),
      upstox.quotes(token, [cfg.underlyingKey, VIX_KEY, ...(picked.future ? [picked.future.key] : [])]),
      upstox.dailyCandles(token, cfg.underlyingKey, from, today),
      upstox.dailyCandles(token, VIX_KEY, from, today),
    ]);
    if (chain.length < 10) {
      console.warn(`upstox: thin chain (${chain.length} rows)`);
      return null;
    }
    const spotQ = q[cfg.underlyingKey];
    const futQ = picked.future ? q[picked.future.key] : null;
    const spot = spotQ?.lastPrice ?? chainSpot ?? null;
    console.log(
      `upstox: ${cfg.assetSymbol} spot=${spot} chain=${chain.length} expiry=${expiry} ` +
        `fut=${futQ?.lastPrice ?? "-"} vix=${q[VIX_KEY]?.lastPrice ?? "-"} hist=${spotHist.length}`,
    );
    return {
      source: "upstox",
      chain,
      spot,
      prevClose: spotQ?.prevClose ?? null,
      vix: q[VIX_KEY]?.lastPrice ?? null,
      vixHistory: vixHist,
      spotHistory: spotHist,
      expiry,
      optionExpiries: picked.optionExpiries.slice(0, 8),
      future: futQ?.lastPrice != null && picked.future
        ? { price: futQ.lastPrice, expiry: picked.future.expiry, oi: futQ.oi }
        : null,
      lotSize: picked.lotSize,
    };
  } catch (e) {
    console.warn(`upstox failed: ${e.message}`);
    return null;
  }
}

// --- Source B: NSE public API ------------------------------------------------
async function fetchViaNse(cfg) {
  const res = await nse.fetchNseChain(cfg.nseSymbol);
  if (!res) return null;
  const [vix, spotHist, vixHist] = await Promise.all([
    nse.fetchNseVix(),
    nse.yahooHistory(cfg.yahoo),
    nse.yahooHistory("^INDIAVIX"),
  ]);
  return {
    source: "nse",
    chain: res.chain,
    spot: res.spot,
    prevClose: spotHist.length > 1 ? spotHist[spotHist.length - 2].v : null,
    vix,
    vixHistory: vixHist,
    spotHistory: spotHist,
    expiry: res.expiry,
    optionExpiries: res.optionExpiries.slice(0, 8),
    future: null,
    lotSize: null,
  };
}

// --- Source C: local fixture (dev/testing only, XERXES_FIXTURE=path) --------
async function fetchViaFixture() {
  const f = process.env.XERXES_FIXTURE;
  if (!f) return null;
  try {
    const src = JSON.parse(await readFile(resolve(f), "utf8"));
    console.log(`fixture: loaded ${f}`);
    return src;
  } catch (e) {
    console.warn(`fixture ${f}: ${e.message}`);
    return null;
  }
}

async function main() {
  const cfg = INDEXES[INDEX];
  if (!cfg) throw new Error(`Unknown INDEX ${INDEX}`);
  await mkdir(DATA_DIR, { recursive: true });
  const prev = await loadPrev(cfg.file);

  const src = (await fetchViaFixture()) ?? (await fetchViaUpstox(cfg)) ?? (await fetchViaNse(cfg));
  if (!src || !(src.spot > 0)) {
    if (prev) {
      await writeFile(resolve(DATA_DIR, cfg.file), JSON.stringify({ ...prev, stale: true }, null, 2) + "\n");
      console.warn("All sources failed; preserved last-good snapshot as stale.");
    } else {
      console.warn("All sources failed and no prior snapshot exists.");
    }
    return;
  }

  const { chain, spot } = src;
  const t = timeToExpiryYears(src.expiry);
  const dte = dteCalendar(src.expiry);

  // Histories: persist across runs so gaps in any one source never wipe them.
  const today = todayIso();
  const spotHistory = mergeByDate(prev?.spot?.history ?? [], src.spotHistory, [{ t: today, v: spot }]).slice(-300);
  const vixHistory = mergeByDate(
    prev?.vix?.history ?? [],
    src.vixHistory,
    src.vix != null ? [{ t: today, v: src.vix }] : [],
  ).slice(-300);
  const closes = spotHistory.map((p) => p.v);
  const vixCloses = vixHistory.map((p) => p.v);

  // --- Chain analytics -------------------------------------------------------
  const pcr = A.pcr(chain);
  const maxPain = A.maxPain(chain);
  const walls = A.walls(chain, spot);
  const flow = A.oiFlow(chain);
  const atmK = A.atmStrike(chain, spot);
  const atmIv = A.atmIv(chain, spot, t);
  const straddle = A.straddlePrice(chain, spot);
  // Expected move to expiry: the ATM straddle is the market's own estimate;
  // fall back to F·σ·√t when the straddle isn't quoted.
  const expectedMove =
    straddle ?? (atmIv != null ? spot * atmIv * Math.sqrt(t) : null);
  const skew = A.ivSkew(chain, spot);
  const gex = A.computeGex(chain, spot, t);
  const rv20 = A.realizedVol(closes, 20);

  // Real ATM-IV history for IV rank (accumulated across runs; one point/day).
  let ivHistory = prev?.metrics?.ivHistory ?? [];
  if (atmIv != null) ivHistory = mergeByDate(ivHistory, [{ t: today, v: A.round(atmIv, 4) }]).slice(-370);
  const ivSample = ivHistory.map((p) => p.v);
  const ivRank = ivSample.length >= 20 ? A.round(A.rangeRank(atmIv, ivSample), 1) : null;
  const ivPercentile = ivSample.length >= 20 ? A.percentile(atmIv, ivSample) : null;

  const basisPts = src.future?.price != null ? src.future.price - spot : null;

  // --- Verdict + candidates --------------------------------------------------
  const verdict = A.directionScore({
    closes,
    vixHistory: vixCloses,
    pcrOi: pcr.oi,
    maxPainStrike: maxPain,
    spot,
    expectedMove,
    flow,
    skew,
    basisPts,
  });
  const candidates = A.sellCandidates(chain, spot, t, expectedMove, {
    maxDelta: 0.25,
    minPremium: Math.max(2, spot * 0.0004), // ≥ ~10pts on NIFTY — worth selling
  });

  const changePct =
    src.prevClose > 0 ? A.round(((spot - src.prevClose) / src.prevClose) * 100, 2) : null;

  const snapshot = {
    asOf: new Date().toISOString(),
    stale: false,
    source: src.source,
    index: INDEX,
    name: cfg.name,
    expiryKind: cfg.expiryKind,
    lotSize: src.lotSize ?? prev?.lotSize ?? null,
    spot: { price: A.round(spot, 2), prevClose: A.round(src.prevClose, 2), changePct, history: spotHistory },
    vix: { value: A.round(src.vix, 2), history: vixHistory },
    future: src.future
      ? { price: A.round(src.future.price, 2), expiry: src.future.expiry, oi: src.future.oi, basisPts: A.round(basisPts, 1) }
      : null,
    expiry: { date: src.expiry, dte, tYears: A.round(t, 5), all: src.optionExpiries },
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
      ivRank,
      ivPercentile,
      ivHistory,
      rv20: A.round(rv20, 4),
      straddle: A.round(straddle, 1),
      expectedMove: A.round(expectedMove, 0),
      skew: A.round(skew, 4),
      gex,
    },
    verdict,
    candidates: candidates.slice(0, 24),
    chain: chain.map((o) => ({
      strike: o.strike,
      type: o.type,
      ltp: o.ltp,
      iv: o.iv != null ? A.round(o.iv, 4) : null,
      oi: o.oi,
      prevOi: o.prevOi,
      volume: o.volume,
      delta: o.delta != null ? A.round(o.delta, 3) : null,
    })),
  };

  await writeFile(resolve(DATA_DIR, cfg.file), JSON.stringify(snapshot, null, 2) + "\n");
  console.log(
    `Wrote ${cfg.file}: spot=${snapshot.spot.price} (${changePct}%) pcr=${pcr.oi} ` +
      `maxPain=${maxPain} em=${snapshot.metrics.expectedMove} verdict=${verdict.verdict} ` +
      `${verdict.score} conf=${verdict.confidence} candidates=${candidates.length} [${src.source}]`,
  );
}

main().catch((e) => {
  console.error("build-data failed:", e);
  process.exit(1);
});
