#!/usr/bin/env node
// Rebuild xerxes.db from scratch out of archive/.
//
// This is what makes the gzipped JSON the source of truth and the database a
// derived index: if the schema changes, or the DB is corrupted, or a mapping
// turns out to be wrong, nothing is lost — edit normalise.mjs and re-run this.
// Keep it working. A derived artifact you cannot regenerate is just a liability.
//
//   node scripts/rebuild.mjs [--out other.db]
//
// Backfilled rows are re-applied afterwards, since they have no archive files
// to be rebuilt from (that is the whole reason they are backfill).

import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openDb, makeInserter, recordRun } from './db.mjs';
import { flattenSnapshot } from './normalise.mjs';
import { backfillRows } from './backfill.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = process.env.ARCHIVE_DIR ?? path.join(ROOT, 'archive');

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : path.join(ROOT, 'xerxes.db');

if (fs.existsSync(OUT)) {
  fs.rmSync(OUT, { force: true });
  console.log(`removed existing ${path.basename(OUT)}`);
}
const db = openDb(OUT);

const readGz = (p) => JSON.parse(gunzipSync(fs.readFileSync(p)).toString('utf8'));

const days = fs.existsSync(ARCHIVE)
  ? fs.readdirSync(ARCHIVE).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  : [];

// Insert in date order so the primary key (trade_date first) stays append-only.
// This is not cosmetic: it is what lets git delta-compress the daily commits
// instead of storing a fresh multi-megabyte blob every day.
let total = 0;
for (const day of days) {
  const dayDir = path.join(ARCHIVE, day);
  const snaps = [];
  for (const kind of ['stocks', 'indices']) {
    const dir = path.join(dayDir, kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json.gz')) continue;
      const base = f.replace(/\.json\.gz$/, '');
      if (base === 'index' || base === 'candidates' || base === 'market') continue;
      snaps.push(readGz(path.join(dir, f)));
    }
  }
  const insert = makeInserter(db, 'archive');
  let n = 0;
  db.exec('BEGIN');
  for (const s of snaps) for (const row of flattenSnapshot(s)) { insert(row); n++; }
  db.exec('COMMIT');

  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dayDir, 'meta.json'), 'utf8')); } catch { /* pre-meta day */ }
  recordRun(db, {
    tradeDate: day, asOf: meta.asOf,
    stocksSha: meta.upstream?.stocksSha, indicesSha: meta.upstream?.indicesSha,
    stockFiles: meta.stockFiles, indexFiles: meta.indexFiles, rowsWritten: n,
  });
  total += n;
  console.log(`  ${day}: ${n.toLocaleString()} rows`);
}

const bf = makeInserter(db, 'backfill');
const rows = backfillRows();
db.exec('BEGIN');
for (const r of rows) bf(r);
db.exec('COMMIT');

console.log(`rebuilt ${path.basename(OUT)}: ${days.length} days, ${total.toLocaleString()} archived rows + ${rows.length} backfill rows`);
db.close();
