#!/usr/bin/env node
// Backfill of snapshots that predate this archiver.
//
// These rows were transcribed by hand from the live app before the archiver
// existed. Upstream force_orphans `stocks-data` on every build, so THESE
// SNAPSHOTS EXIST NOWHERE ELSE ON EARTH — they cannot be re-derived from any
// source, at any price. Treat this file as primary data, not as code: do not
// "clean up" the literals, and do not delete a row because it looks sparse.
//
// They are written with src='backfill' and a fill-NULLs-only merge, so a real
// capture landing on the same key always wins and re-running is a no-op.
//
// Field coverage is thin by nature — a hand transcription carries the ranked
// candidate fields and nothing else. iv, delta, oi, volume, fair, cvar, worst,
// tail_reliance, pcr_oi, max_pain, call/put walls and gap_share are all NULL
// here. Any query that assumes full coverage must filter src='archive'.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, makeInserter } from './db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH ?? path.join(ROOT, 'xerxes.db');

// Lot sizes are a static contract attribute (they do not change within an
// expiry), so the values stated in the 08-07 / 08-10 snapshots are carried
// into the 08-11 mark rather than left NULL.
const LOT = {
  MANAPPURAM: 3000, BSE: 200, MCX: 225, RVNL: 1925, DELHIVERY: 2075,
  ADANIGREEN: 600, BHARATFORG: 500, BHEL: 2625,
};

/** "NEUTRAL 0.8" -> { verdict: 'NEUTRAL', score: 0.8 }; "NEUTRAL" -> score null. */
function parseVerdict(s) {
  if (!s) return { verdict: null, score: null };
  const m = /^([A-Z]+)(?:\s+(-?[\d.]+))?$/.exec(s.trim());
  if (!m) return { verdict: s.trim(), score: null };
  return { verdict: m[1], score: m[2] === undefined ? null : Number(m[2]) };
}

// ---------------------------------------------------------------------------
// 2026-08-07 13:44 UTC — expiry 2026-08-25, 18 DTE
// ---------------------------------------------------------------------------
const SNAP_2026_08_07 = {
  ts: '2026-08-07T13:44:00Z',
  tradeDate: '2026-08-07',
  expiry: '2026-08-25',
  dte: 18,
  // symbol, side, strike, ltp, lot, spot, conviction, p_keep, edge_pct, verdict, vrp
  rows: `
MANAPPURAM,PE,335,3.65,3000,366.75,79,0.890,4.09,NEUTRAL 0.8,1.17
BSE,CE,3800,29.15,200,3457.10,74,0.920,3.81,NEUTRAL -1.8,1.19
MANAPPURAM,CE,400,3.65,3000,366.75,74,0.890,4.20,NEUTRAL 0.8,1.17
MCX,CE,2900,16.95,225,2638.00,68,0.940,3.10,BEARISH -5.0,0.99
RVNL,CE,265,1.14,1925,233.38,67,0.960,1.90,NEUTRAL -0.1,1.24
MCX,CE,2850,22.30,225,2638.00,67,0.900,3.40,BEARISH -5.0,0.99
RVNL,PE,215,2.05,1925,233.38,66,0.890,3.70,NEUTRAL -0.1,1.24
DELHIVERY,CE,515,4.20,2075,473.30,66,0.910,3.60,BEARISH -3.3,1.27
ADANIGREEN,CE,1700,1.75,600,1372.40,65,0.990,0.50,BEARISH -3.5,0.91
DELHIVERY,CE,505,5.80,2075,473.30,65,0.860,4.30,BEARISH -3.3,1.27
BSE,CE,3900,19.10,200,3457.10,63,0.960,2.90,NEUTRAL -1.8,1.19
BHARATFORG,CE,2440,22.35,500,2265.20,62,0.890,3.90,BULLISH 3.4,1.18
`,
};

// ---------------------------------------------------------------------------
// 2026-08-10 06:01 UTC — expiry 2026-08-25, 15 DTE
// Verdicts carry no score in this snapshot; verdict_score stays NULL rather
// than being invented.
// ---------------------------------------------------------------------------
const SNAP_2026_08_10 = {
  ts: '2026-08-10T06:01:00Z',
  tradeDate: '2026-08-10',
  expiry: '2026-08-25',
  dte: 15,
  rows: `
MANAPPURAM,PE,340,3.40,3000,370.80,80,0.895,3.95,NEUTRAL,1.27
RVNL,CE,250,2.35,1925,231.60,74,0.914,4.87,NEUTRAL,1.44
BHARATFORG,CE,2460,20.00,500,2283.50,72,0.919,4.02,NEUTRAL,1.36
MCX,CE,2950,18.85,225,2711.70,67,0.929,3.12,NEUTRAL,1.07
BHEL,CE,465,1.30,2625,406.65,60,0.965,1.31,NEUTRAL,0.99
BHEL,CE,470,1.15,2625,406.65,63,0.975,1.30,NEUTRAL,0.99
`,
};

function parseCsvSnapshot(snap) {
  const out = [];
  for (const line of snap.rows.trim().split('\n')) {
    const [symbol, type, strike, ltp, lot, spot, conviction, pKeep, edgePct, verdict, vrp] =
      line.split(',');
    const v = parseVerdict(verdict);
    out.push({
      ts: snap.ts,
      trade_date: snap.tradeDate,
      symbol,
      expiry: snap.expiry,
      dte: snap.dte,
      spot: Number(spot),
      lot_size: Number(lot),
      strike: Number(strike),
      type,
      ltp: Number(ltp),
      conviction: Number(conviction),
      p_profit: Number(pKeep),
      edge_pct: Number(edgePct),   // already in percent units
      vrp: Number(vrp),
      verdict: v.verdict,
      verdict_score: v.score,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2026-08-11 05:30 UTC mark — expiry 2026-08-25, 14 DTE
//
// A price mark, not a full snapshot: LTPs for the strikes being tracked, plus
// term-structure context for the two names it was recorded for. No conviction,
// no edge — those were not captured at the time.
//
// NOTE ON SUPERSESSION: 2026-08-11 also has a full archived capture (upstream
// asOf 07:15 UTC). Where the two overlap, the 07:15 capture wins — it is later,
// closer to the close, and machine-derived. This mark therefore survives mainly
// as the 05:30 record for strikes the capture also holds; it is kept because
// discarding a primary observation to avoid a merge is the wrong trade.
// ---------------------------------------------------------------------------
const MARK_2026_08_11 = {
  ts: '2026-08-11T05:30:00Z',
  tradeDate: '2026-08-11',
  expiry: '2026-08-25',
  dte: 14,
  symbols: [
    {
      symbol: 'BHARATFORG', spot: 2068.70, verdict: 'BEARISH -4.5',
      near_iv: 0.3009, far_iv: 0.5387, term_slope: -23.78, term_regime: 'contango', vrp: 0.94,
      legs: [['CE', 2440, 1.75], ['CE', 2460, 1.60]],
    },
    {
      symbol: 'MANAPPURAM', spot: 367.00, verdict: 'NEUTRAL 1.5',
      near_iv: 0.4895, far_iv: 0.5054, term_slope: -1.59, term_regime: 'flat', vrp: 1.40,
      legs: [['PE', 335, 3.40], ['PE', 340, 4.25], ['CE', 400, 4.30]],
    },
    { symbol: 'MCX', spot: 2815.00, legs: [['CE', 2850, 65.20], ['CE', 2900, 48.65], ['CE', 2950, 36.00]] },
    { symbol: 'DELHIVERY', spot: 480.40, legs: [['CE', 505, 4.30], ['CE', 515, 2.80]] },
    { symbol: 'BSE', spot: 3576.10, legs: [['CE', 3800, 41.25], ['CE', 3900, 25.50]] },
    { symbol: 'RVNL', spot: 230.26, legs: [['PE', 215, 2.47], ['CE', 250, 2.17], ['CE', 265, 0.84]] },
    { symbol: 'BHEL', spot: 405.90, legs: [['CE', 465, 1.10], ['CE', 470, 1.05]] },
    { symbol: 'ADANIGREEN', spot: 1375.00, legs: [['CE', 1700, 1.60]] },
  ],
};

function parseMark(mark) {
  const out = [];
  for (const s of mark.symbols) {
    const v = parseVerdict(s.verdict);
    for (const [type, strike, ltp] of s.legs) {
      out.push({
        ts: mark.ts,
        trade_date: mark.tradeDate,
        symbol: s.symbol,
        expiry: mark.expiry,
        dte: mark.dte,
        spot: s.spot,
        lot_size: LOT[s.symbol] ?? null,
        strike, type, ltp,
        vrp: s.vrp ?? null,
        near_iv: s.near_iv ?? null,
        far_iv: s.far_iv ?? null,
        term_slope: s.term_slope ?? null,
        term_regime: s.term_regime ?? null,
        verdict: v.verdict,
        verdict_score: v.score,
      });
    }
  }
  return out;
}

export function backfillRows() {
  return [
    ...parseCsvSnapshot(SNAP_2026_08_07),
    ...parseCsvSnapshot(SNAP_2026_08_10),
    ...parseMark(MARK_2026_08_11),
  ];
}

function main() {
  const db = openDb(DB_PATH);
  const insert = makeInserter(db, 'backfill');
  const rows = backfillRows();
  db.exec('BEGIN');
  try {
    for (const r of rows) insert(r);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const byDate = db.prepare(
    `SELECT trade_date, COUNT(*) n, COUNT(DISTINCT symbol) syms
     FROM snapshots WHERE trade_date IN ('2026-08-07','2026-08-10','2026-08-11')
     GROUP BY trade_date ORDER BY trade_date`,
  ).all();
  db.close();
  console.log(`backfilled ${rows.length} rows into ${DB_PATH}`);
  for (const r of byDate) console.log(`  ${r.trade_date}: ${r.n} rows, ${r.syms} symbols`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
