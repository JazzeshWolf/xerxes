// SQLite schema + upserts for the Xerxes EOD archive.
//
// Uses node:sqlite (Node >= 22) on purpose: zero dependencies, no native
// compilation step in CI. The archive must keep working years from now with
// nobody maintaining it, so the dependency count is deliberately zero.

import { DatabaseSync } from 'node:sqlite';

// The column list is fixed by the archive spec. Order matters: INSERT_SQL and
// both upsert modes are generated from it, so adding a field here is the only
// edit needed.
export const SNAPSHOT_COLS = [
  'ts',
  'trade_date',
  'symbol',
  'expiry',
  'dte',
  'spot',
  'prev_close',
  'change_pct',
  'lot_size',
  'strike',
  'type',
  'ltp',
  'iv',
  'delta',
  'oi',
  'volume',
  'conviction',
  'band',
  'p_profit',
  'edge_pct',
  'fair',
  'cushion_sigma',
  'prob_touch',
  'cvar',
  'worst',
  'tail_reliance',
  'empirical',
  'delivery_risk',
  'vrp',
  'pcr_oi',
  'max_pain',
  'call_wall',
  'put_wall',
  'near_iv',
  'far_iv',
  'term_slope',
  'term_regime',
  'gap_share',
  'verdict',
  'verdict_score',
  'verdict_confidence',
];

// Columns that identify a row. Everything else is a measurement.
const KEY_COLS = ['trade_date', 'symbol', 'expiry', 'strike', 'type'];

// `src` is not in the archive spec's column list but is load-bearing for any
// later analysis: without it there is no way to tell a hand-entered backfill
// row (a handful of fields, typed from a screenshot) from a captured row (the
// full chain, machine-derived). Analyses that assume full-field coverage must
// filter on src='archive'.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  ts                 TEXT,     -- upstream asOf, ISO8601 UTC (the build time, ~10 min delayed)
  trade_date         TEXT NOT NULL,  -- YYYY-MM-DD, UTC date of ts (== IST trade date; see note below)
  symbol             TEXT NOT NULL,  -- NSE symbol, or NIFTY/BANKNIFTY/SENSEX for indices
  expiry             TEXT NOT NULL,  -- YYYY-MM-DD
  dte                INTEGER,
  spot               REAL,
  prev_close         REAL,
  change_pct         REAL,
  lot_size           INTEGER,
  strike             REAL NOT NULL,
  type               TEXT NOT NULL,  -- 'CE' | 'PE'
  ltp                REAL,
  iv                 REAL,     -- fraction, e.g. 0.4895 = 48.95%
  delta              REAL,
  oi                 INTEGER,
  volume             INTEGER,
  conviction         REAL,     -- 0-100 sell-conviction; NULL for non-candidate strikes
  band               TEXT,     -- HIGH | MEDIUM | LOW
  p_profit           REAL,     -- real-world P(keep premium) at forecast vol; NOT the 1-|delta| proxy
  edge_pct           REAL,     -- PERCENT units (4.09 = 4.09% of margin proxy); upstream stores a fraction
  fair               REAL,
  cushion_sigma      REAL,     -- forecast-vol cushion (cushionSigmaF), not the IV-based one
  prob_touch         REAL,     -- forecast-vol P(touch) (probTouchF)
  cvar               REAL,
  worst              REAL,
  tail_reliance      REAL,
  empirical          INTEGER,  -- 0/1
  delivery_risk      INTEGER,  -- 0/1; always NULL for indices (cash settled)
  vrp                REAL,
  pcr_oi             REAL,
  max_pain           REAL,
  call_wall          REAL,
  put_wall           REAL,
  near_iv            REAL,
  far_iv             REAL,
  term_slope         REAL,
  term_regime        TEXT,
  gap_share          REAL,
  verdict            TEXT,
  verdict_score      REAL,
  verdict_confidence REAL,
  src                TEXT NOT NULL DEFAULT 'archive',  -- 'archive' | 'backfill'
  captured_at        TEXT,     -- when THIS archiver wrote the row
  PRIMARY KEY (trade_date, symbol, expiry, strike, type)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_symbol   ON snapshots(symbol, trade_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_expiry   ON snapshots(symbol, expiry, strike, type);
CREATE INDEX IF NOT EXISTS idx_snapshots_convictn ON snapshots(trade_date, conviction);

-- One row per scheduled run that could NOT produce a snapshot. A gap in
-- snapshots with no matching missed_days row means the job never ran at all —
-- that distinction is the whole point of recording these.
CREATE TABLE IF NOT EXISTS missed_days (
  trade_date     TEXT PRIMARY KEY,
  reason         TEXT NOT NULL,     -- STALE_UPSTREAM | CLONE_FAILED | ...
  detail         TEXT,
  upstream_as_of TEXT,              -- the asOf we saw, if we got that far
  attempts       INTEGER,
  checked_at     TEXT NOT NULL
);

-- One row per successful capture: lets you audit coverage without walking the
-- archive/ tree.
CREATE TABLE IF NOT EXISTS runs (
  trade_date    TEXT PRIMARY KEY,
  as_of         TEXT,
  stocks_sha    TEXT,
  indices_sha   TEXT,
  stock_files   INTEGER,
  index_files   INTEGER,
  rows_written  INTEGER,
  captured_at   TEXT
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = DELETE');   // keep the committed file self-contained (no -wal sidecar)
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const cols = SNAPSHOT_COLS.join(', ');
const placeholders = SNAPSHOT_COLS.map(() => '?').join(', ');
const updatable = SNAPSHOT_COLS.filter((c) => !KEY_COLS.includes(c));

// Two merge modes, both idempotent:
//
//   'archive'  — a fresh capture. Prefers the new value, but keeps an existing
//                one where the new is NULL, so a partial re-run never erases
//                data. Promotes src to 'archive'.
//   'backfill' — hand-entered history. Fills only NULL columns and never
//                overwrites anything already present, so replaying the backfill
//                after a real capture landed is a no-op. Never demotes src.
//
// This asymmetry is what lets 2026-08-11 hold both a backfilled 05:30 mark and
// the richer live 07:15 capture without either clobbering the other.
const UPSERT = {
  archive: `INSERT INTO snapshots (${cols}, src, captured_at)
    VALUES (${placeholders}, 'archive', ?)
    ON CONFLICT (trade_date, symbol, expiry, strike, type) DO UPDATE SET
      ${updatable.map((c) => `${c} = COALESCE(excluded.${c}, snapshots.${c})`).join(',\n      ')},
      src = 'archive',
      captured_at = excluded.captured_at`,

  backfill: `INSERT INTO snapshots (${cols}, src, captured_at)
    VALUES (${placeholders}, 'backfill', ?)
    ON CONFLICT (trade_date, symbol, expiry, strike, type) DO UPDATE SET
      ${updatable.map((c) => `${c} = COALESCE(snapshots.${c}, excluded.${c})`).join(',\n      ')},
      captured_at = COALESCE(snapshots.captured_at, excluded.captured_at)`,
};

export function makeInserter(db, mode = 'archive') {
  const sql = UPSERT[mode];
  if (!sql) throw new Error(`unknown insert mode: ${mode}`);
  const stmt = db.prepare(sql);
  const now = new Date().toISOString();
  return (row) => {
    const values = SNAPSHOT_COLS.map((c) => normaliseValue(row[c]));
    stmt.run(...values, now);
  };
}

// node:sqlite rejects undefined/booleans/NaN; map them to what the column means.
function normaliseValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

export function recordMissedDay(db, { tradeDate, reason, detail, upstreamAsOf, attempts }) {
  db.prepare(
    `INSERT INTO missed_days (trade_date, reason, detail, upstream_as_of, attempts, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (trade_date) DO UPDATE SET
       reason = excluded.reason, detail = excluded.detail,
       upstream_as_of = excluded.upstream_as_of, attempts = excluded.attempts,
       checked_at = excluded.checked_at`,
  ).run(tradeDate, reason, detail ?? null, upstreamAsOf ?? null, attempts ?? null, new Date().toISOString());
}

export function recordRun(db, r) {
  db.prepare(
    `INSERT INTO runs (trade_date, as_of, stocks_sha, indices_sha, stock_files, index_files, rows_written, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (trade_date) DO UPDATE SET
       as_of = excluded.as_of, stocks_sha = excluded.stocks_sha,
       indices_sha = excluded.indices_sha, stock_files = excluded.stock_files,
       index_files = excluded.index_files, rows_written = excluded.rows_written,
       captured_at = excluded.captured_at`,
  ).run(
    r.tradeDate, r.asOf ?? null, r.stocksSha ?? null, r.indicesSha ?? null,
    r.stockFiles ?? null, r.indexFiles ?? null, r.rowsWritten ?? null,
    new Date().toISOString(),
  );
  // A day that succeeds is no longer missed (e.g. a manual re-run that catches
  // up after the scheduled attempt found stale data).
  db.prepare('DELETE FROM missed_days WHERE trade_date = ?').run(r.tradeDate);
}

export function hasSnapshot(db, tradeDate) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM snapshots WHERE trade_date = ? AND src = 'archive'`,
  ).get(tradeDate);
  return Number(row?.n ?? 0) > 0;
}
