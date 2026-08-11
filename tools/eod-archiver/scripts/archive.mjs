#!/usr/bin/env node
// Daily EOD capture for the Xerxes options screener.
//
// WHY THIS EXISTS: upstream publishes to the `stocks-data` branch with
// peaceiris force_orphan:true. That branch holds exactly ONE commit — every
// build replaces it, so yesterday's snapshot is gone permanently the moment
// today's build runs. Nothing else on earth keeps that history. This job is
// the only copy.
//
// Consequences that shape every decision below:
//   * A missed day is UNRECOVERABLE. Prefer capturing something over failing
//     clean; prefer failing loudly over capturing silently-wrong data.
//   * NEVER force-push. NEVER use force_orphan. Rewriting this archive's own
//     history would reproduce the exact bug it exists to work around.

import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, makeInserter, recordMissedDay, recordRun, hasSnapshot } from './db.mjs';
import { flattenSnapshot, tradeDateOf } from './normalise.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CFG = {
  sourceRepo: process.env.SOURCE_REPO ?? 'https://github.com/JazzeshWolf/xerxes.git',
  stocksBranch: process.env.STOCKS_BRANCH ?? 'stocks-data',
  // NOTE: the task brief said indices live on `main`. They do not — the
  // upstream repo has NO main branch. Its de-facto trunk (Pages deploys and
  // data commits both target it) is the branch below. Verified with
  // `git ls-remote --heads`. Fallbacks are tried in order if it ever moves.
  indicesBranch: process.env.INDICES_BRANCH ?? 'claude/nifty-option-screener-93xv0y',
  indicesFallbacks: ['main', 'master'],
  indexFiles: ['nifty', 'banknifty', 'sensex'],
  retries: Number(process.env.RETRIES ?? 6),          // attempts AFTER the first
  retryMinutes: Number(process.env.RETRY_MINUTES ?? 5),
  // Earliest upstream asOf time-of-day (UTC) accepted as an end-of-day
  // snapshot. 10:00 UTC is the 15:30 IST close. Guards the archive's core
  // invariant: one POST-CLOSE snapshot per trading day. Without it, a manual
  // dispatch at lunchtime would capture mid-session prices, and idempotency
  // would then lock that in as the day's close forever.
  // FORCE_INTRADAY=1 overrides, deliberately and per-run.
  minAsOfUtc: process.env.MIN_ASOF_UTC ?? '10:00',
  forceIntraday: process.env.FORCE_INTRADAY === '1',
  archiveDir: process.env.ARCHIVE_DIR ?? path.join(ROOT, 'archive'),
  dbPath: process.env.DB_PATH ?? path.join(ROOT, 'xerxes.db'),
  workDir: process.env.WORK_DIR ?? path.join(ROOT, '.work'),
  dryRun: process.env.DRY_RUN === '1',
};

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

/** Today's trade date. Uses UTC because every upstream build lands between
 *  03:00 and 11:00 UTC, so the UTC date and the IST trade date always agree —
 *  no midnight straddle to get wrong. TRADE_DATE overrides it for backfills. */
function todayUtc() {
  return process.env.TRADE_DATE ?? new Date().toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- source acquisition ----------------------------------------------------

function cloneBranch(branch, dest, fallbacks = []) {
  fs.rmSync(dest, { recursive: true, force: true });
  const tried = [];
  for (const b of [branch, ...fallbacks]) {
    try {
      sh('git', ['clone', '--depth', '1', '--single-branch', '--branch', b, CFG.sourceRepo, dest]);
      const sha = sh('git', ['-C', dest, 'rev-parse', 'HEAD']);
      if (b !== branch) log(`WARNING: branch '${branch}' unavailable, fell back to '${b}'`);
      return { branch: b, sha };
    } catch (err) {
      tried.push(`${b}: ${String(err.stderr ?? err.message).trim().split('\n').pop()}`);
    }
  }
  throw new Error(`could not clone any of [${[branch, ...fallbacks].join(', ')}]\n  ${tried.join('\n  ')}`);
}

/** One acquisition attempt. Returns the clones plus the freshness verdict. */
function attemptFetch(tradeDate) {
  const stocksDir = path.join(CFG.workDir, 'stocks');
  const indicesDir = path.join(CFG.workDir, 'indices');
  fs.mkdirSync(CFG.workDir, { recursive: true });

  const stocks = cloneBranch(CFG.stocksBranch, stocksDir);
  const indexJsonPath = path.join(stocksDir, 'index.json');
  if (!fs.existsSync(indexJsonPath)) {
    return { fresh: false, reason: 'NO_INDEX_JSON', detail: 'stocks-data has no index.json', stocks };
  }

  const idx = JSON.parse(fs.readFileSync(indexJsonPath, 'utf8'));
  const asOf = idx.asOf ?? null;
  // THE freshness gate. A build that failed upstream leaves the PREVIOUS day's
  // files in place and they look perfectly valid — only asOf gives it away.
  // Committing those would silently record stale prices as today's close,
  // which is worse than recording nothing.
  const asOfDate = asOf ? tradeDateOf(asOf) : null;
  if (asOfDate !== tradeDate) {
    return {
      fresh: false, reason: 'STALE_UPSTREAM',
      detail: `index.json asOf=${asOf} (${asOfDate}), expected ${tradeDate}`,
      asOf, stocks,
    };
  }

  // Right date, but is it actually the post-close build? The 15:45 IST build is
  // the one that carries closing prices; an earlier one is a mid-session mark
  // and must not be filed as the day's EOD.
  if (!CFG.forceIntraday) {
    const [h, m] = CFG.minAsOfUtc.split(':').map(Number);
    const d = new Date(asOf);
    const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (minutes < h * 60 + m) {
      return {
        fresh: false, reason: 'PRE_CLOSE',
        detail: `index.json asOf=${asOf} is before ${CFG.minAsOfUtc} UTC ` +
          `(market closes 10:00 UTC / 15:30 IST) — mid-session data, not an EOD snapshot`,
        asOf, stocks,
      };
    }
  }

  // Indices are captured best-effort: the stocks build is the one the schedule
  // is pinned to, and an index outage should not cost us the stock snapshot.
  let indices = null;
  try {
    indices = cloneBranch(CFG.indicesBranch, indicesDir, CFG.indicesFallbacks);
  } catch (err) {
    log(`WARNING: indices clone failed, continuing with stocks only — ${err.message}`);
  }

  return { fresh: true, asOf, stocks, indices, stocksDir, indicesDir };
}

// --- writing the archive ---------------------------------------------------

function writeSnapshot(tradeDate, res) {
  const dayDir = path.join(CFG.archiveDir, tradeDate);
  const stocksOut = path.join(dayDir, 'stocks');
  const indicesOut = path.join(dayDir, 'indices');
  fs.mkdirSync(stocksOut, { recursive: true });
  fs.mkdirSync(indicesOut, { recursive: true });

  // Gzipped at rest: these files are ~7 MB/day raw and are written once and
  // then never touched, so git stores each day's blobs exactly once.
  const gz = (srcFile, destDir) => {
    const buf = fs.readFileSync(srcFile);
    fs.writeFileSync(path.join(destDir, path.basename(srcFile) + '.gz'), gzipSync(buf, { level: 9 }));
    return JSON.parse(buf.toString('utf8'));
  };

  const stockSnaps = [];
  let stockFiles = 0;
  for (const f of fs.readdirSync(res.stocksDir)) {
    if (!f.endsWith('.json')) continue;
    const parsed = gz(path.join(res.stocksDir, f), stocksOut);
    stockFiles++;
    // index.json / candidates.json are roll-ups, not per-symbol snapshots;
    // they are archived but contribute no `snapshots` rows.
    if (f !== 'index.json' && f !== 'candidates.json') stockSnaps.push(parsed);
  }

  const indexSnaps = [];
  let indexFiles = 0;
  let indicesAsOf = null;
  if (res.indices) {
    const dataDir = path.join(res.indicesDir, 'public', 'data');
    for (const name of CFG.indexFiles) {
      const p = path.join(dataDir, `${name}.json`);
      if (!fs.existsSync(p)) { log(`WARNING: missing index file ${name}.json`); continue; }
      const parsed = gz(p, indicesOut);
      indexFiles++;
      indexSnaps.push(parsed);
      if (!indicesAsOf || parsed.asOf > indicesAsOf) indicesAsOf = parsed.asOf;
    }
    // market.json carries the macro news/outlook block. Archived for context;
    // it has no option chain so it produces no rows.
    const mkt = path.join(dataDir, 'market.json');
    if (fs.existsSync(mkt)) { gz(mkt, indicesOut); indexFiles++; }
  }

  const meta = {
    tradeDate,
    asOf: res.asOf,
    indicesAsOf,
    // Indices are captured ~20 min before their own final build of the day
    // (10:57 UTC). Both are post-close (15:30 IST = 10:00 UTC), so both carry
    // closing prices; the index snapshot is simply not the very last one.
    indicesNote: 'captured at run time; upstream indices build again at 10:57 UTC',
    capturedAt: new Date().toISOString(),
    stockFiles,
    indexFiles,
    fileCount: stockFiles + indexFiles,
    upstream: {
      repo: CFG.sourceRepo,
      stocksBranch: res.stocks.branch,
      stocksSha: res.stocks.sha,
      indicesBranch: res.indices?.branch ?? null,
      indicesSha: res.indices?.sha ?? null,
    },
    attempts: res.attempts ?? 1,
    compression: 'gzip -9, per file, .json.gz',
  };
  fs.writeFileSync(path.join(dayDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

  return { meta, stockSnaps, indexSnaps };
}

function normaliseInto(db, snaps) {
  const insert = makeInserter(db, 'archive');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const snap of snaps) for (const row of flattenSnapshot(snap)) { insert(row); n++; }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

// --- committing ------------------------------------------------------------

function commitAndPush(message) {
  if (CFG.dryRun) { log(`DRY_RUN: would commit "${message}"`); return; }
  sh('git', ['-C', ROOT, 'add', '--', 'archive', 'xerxes.db']);
  const staged = sh('git', ['-C', ROOT, 'status', '--porcelain', '--', 'archive', 'xerxes.db']);
  if (!staged) { log('nothing to commit'); return; }
  sh('git', ['-C', ROOT, 'commit', '-m', message]);

  // Plain fast-forward push, retried for transient network failures only.
  // There is deliberately no --force / --force-with-lease anywhere in this
  // file: destroying history is the bug this repo exists to fix.
  const branch = sh('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD']);
  let delay = 2000;
  for (let i = 0; i < 5; i++) {
    try { sh('git', ['-C', ROOT, 'push', 'origin', `HEAD:${branch}`]); log(`pushed to ${branch}`); return; }
    catch (err) {
      if (i === 4) throw err;
      log(`push failed, retrying in ${delay / 1000}s — ${String(err.stderr ?? err.message).trim()}`);
      execFileSync('sleep', [String(delay / 1000)]);
      delay *= 2;
    }
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  const tradeDate = todayUtc();
  log(`EOD capture for ${tradeDate}`);
  fs.mkdirSync(CFG.archiveDir, { recursive: true });
  const db = openDb(CFG.dbPath);

  // Idempotency: re-running the workflow (manually or after a retry) must never
  // produce a second commit or double-count rows.
  const dayDir = path.join(CFG.archiveDir, tradeDate);
  if (fs.existsSync(path.join(dayDir, 'meta.json')) && hasSnapshot(db, tradeDate)) {
    log(`snapshot for ${tradeDate} already exists — nothing to do`);
    db.close();
    return;
  }

  let res = null;
  const maxAttempts = CFG.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`attempt ${attempt}/${maxAttempts}`);
    try {
      res = attemptFetch(tradeDate);
    } catch (err) {
      res = { fresh: false, reason: 'CLONE_FAILED', detail: err.message };
      log(`clone failed: ${err.message}`);
    }
    if (res.fresh) { res.attempts = attempt; break; }
    log(`not fresh (${res.reason}): ${res.detail}`);
    if (attempt < maxAttempts) {
      log(`waiting ${CFG.retryMinutes} min before retry`);
      await sleep(CFG.retryMinutes * 60_000);
    }
  }

  if (!res?.fresh) {
    // Market holiday or a failed upstream build. Record it and exit 0: this is
    // an expected outcome, not a job failure, and a red X every holiday trains
    // everyone to ignore the alerts that matter.
    log(`MISSED_DAY ${tradeDate} reason=${res?.reason ?? 'UNKNOWN'} — ${res?.detail ?? ''}`);
    recordMissedDay(db, {
      tradeDate, reason: res?.reason ?? 'UNKNOWN', detail: res?.detail,
      upstreamAsOf: res?.asOf, attempts: maxAttempts,
    });
    db.close();
    commitAndPush(`MISSED_DAY ${tradeDate} (${res?.reason ?? 'UNKNOWN'})`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### MISSED_DAY ${tradeDate}\n\n\`${res?.reason}\` — ${res?.detail ?? ''}\n`);
    }
    console.log(`::warning::MISSED_DAY ${tradeDate} (${res?.reason}) — no snapshot captured`);
    return;
  }

  log(`upstream asOf ${res.asOf} — fresh`);
  const { meta, stockSnaps, indexSnaps } = writeSnapshot(tradeDate, res);
  log(`archived ${meta.stockFiles} stock files + ${meta.indexFiles} index files`);

  const rows = normaliseInto(db, [...stockSnaps, ...indexSnaps]);
  recordRun(db, {
    tradeDate, asOf: res.asOf,
    stocksSha: meta.upstream.stocksSha, indicesSha: meta.upstream.indicesSha,
    stockFiles: meta.stockFiles, indexFiles: meta.indexFiles, rowsWritten: rows,
  });
  db.close();
  log(`normalised ${rows} rows into ${path.basename(CFG.dbPath)}`);

  fs.rmSync(CFG.workDir, { recursive: true, force: true });
  commitAndPush(`EOD ${tradeDate}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### EOD ${tradeDate}\n\n- asOf \`${res.asOf}\`\n- ${meta.stockFiles} stock + ${meta.indexFiles} index files\n- ${rows} rows\n- attempts: ${meta.attempts}\n`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
