#!/usr/bin/env node
// Coverage report. Prints Markdown so the workflow can pipe it straight into
// GITHUB_STEP_SUMMARY.
//
// The number that matters is the gap list: a trading day with neither a
// snapshot nor a missed_days row means the job never ran, which is the one
// failure mode that silently loses data forever.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH ?? path.join(ROOT, 'xerxes.db');

if (!fs.existsSync(DB_PATH)) {
  console.log('## EOD archive\n\nNo database yet.');
  process.exit(0);
}

const db = openDb(DB_PATH);

const totals = db.prepare(
  `SELECT COUNT(*) rows, COUNT(DISTINCT trade_date) days, COUNT(DISTINCT symbol) symbols FROM snapshots`,
).get();
const bySrc = db.prepare(`SELECT src, COUNT(*) n FROM snapshots GROUP BY src`).all();
const days = db.prepare(
  `SELECT trade_date, COUNT(*) n, COUNT(DISTINCT symbol) syms,
          SUM(CASE WHEN conviction IS NOT NULL THEN 1 ELSE 0 END) cands, MAX(src) src
   FROM snapshots GROUP BY trade_date ORDER BY trade_date DESC LIMIT 15`,
).all();
const missed = db.prepare(`SELECT * FROM missed_days ORDER BY trade_date DESC LIMIT 15`).all();

// ivRank is the 7th conviction factor and stays null until upstream holds 20
// points of ivHistory. Until then every conviction score in this archive is a
// 6-of-7-factor score and must be labelled partial-factor in any analysis.
const ivRankDays = db.prepare(
  `SELECT COUNT(DISTINCT trade_date) n FROM snapshots WHERE src = 'archive'`,
).get().n;

console.log('## EOD archive coverage\n');
console.log(`- **${totals.rows.toLocaleString()}** rows across **${totals.days}** trade dates, **${totals.symbols}** symbols`);
console.log(`- by source: ${bySrc.map((r) => `\`${r.src}\` ${r.n.toLocaleString()}`).join(', ')}`);
console.log(`- archived trading days: **${ivRankDays}** / 20 needed before \`ivRank\` becomes non-null upstream`);
if (ivRankDays < 20) {
  console.log(`\n> ⚠️ **Partial-factor regime.** Conviction is running on 6 of 7 factors ` +
    `(\`ivRank\` null, weight redistributed). Label any analysis accordingly.`);
}

console.log('\n### Recent days\n');
console.log('| date | rows | symbols | candidate rows | src |');
console.log('|---|---:|---:|---:|---|');
for (const d of days) {
  console.log(`| ${d.trade_date} | ${d.n.toLocaleString()} | ${d.syms} | ${d.cands.toLocaleString()} | ${d.src} |`);
}

if (missed.length) {
  console.log('\n### Missed days\n');
  console.log('| date | reason | detail |');
  console.log('|---|---|---|');
  for (const m of missed) console.log(`| ${m.trade_date} | \`${m.reason}\` | ${(m.detail ?? '').slice(0, 120)} |`);
}

db.close();
