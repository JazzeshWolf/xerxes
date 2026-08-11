import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, makeInserter, recordMissedDay, recordRun, hasSnapshot } from '../scripts/db.mjs';
import { flattenSnapshot, tradeDateOf, resolveTradeDate } from '../scripts/normalise.mjs';
import { backfillRows } from '../scripts/backfill.mjs';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xeod-')), 'test.db');

// A miniature but structurally faithful snapshot: two chain strikes, one of
// which is also a ranked candidate.
const SNAP = {
  asOf: '2026-08-11T07:15:45.014Z',
  index: 'MANAPPURAM',
  name: 'Manappuram Finance',
  lotSize: 3000,
  spot: { price: 365.85, prevClose: 369.3, changePct: -0.93, history: [] },
  term: { slopePts: 7.57, regime: 'backwardation', nearIv: 0.4895, farIv: 0.4138 },
  gap: { gapShare: 0.219 },
  expiries: {
    '2026-08-25': {
      date: '2026-08-25',
      dte: 14,
      metrics: { pcrOi: 0.54, maxPain: 360, callWall: 370, putWall: 360, vrp: 1.4, gapShare: 0.219, termSlope: 7.57 },
      verdict: { verdict: 'NEUTRAL', score: 0.9, confidence: 0.73 },
      chain: [
        { strike: 400, type: 'CE', ltp: 3.95, iv: 0.5029, oi: 1497000, volume: 2517000, delta: 0.203 },
        { strike: 350, type: 'CE', ltp: 24.65, iv: 0.5273, oi: 951000, volume: 180000, delta: 0.692 },
      ],
      candidates: [
        {
          strike: 400, type: 'CE', ltp: 3.95, iv: 0.5029, oi: 1497000, delta: 0.203,
          conviction: 73, band: 'HIGH', edge: 2.82, edgePct: 0.0513, fair: 1.13,
          probProfit: 0.797, pProfit: 0.916,
          cushionSigma: 1.22, cushionSigmaF: 1.35, probTouch: 0.367, probTouchF: 0.195,
          deliveryRisk: false, tailReliance: 0.71, empirical: true, cvar: -16.31, worst: -63.07,
        },
      ],
    },
  },
};

test('tradeDateOf takes the UTC date', () => {
  assert.equal(tradeDateOf('2026-08-11T07:15:45.014Z'), '2026-08-11');
  // Late-evening IST is still the same UTC date for this data's build window.
  assert.equal(tradeDateOf('2026-08-07T13:44:00Z'), '2026-08-07');
});

// REGRESSION (found on the first production run): GitHub Actions renders an
// unset workflow input as an EMPTY STRING, and a `schedule` event has no inputs
// at all, so TRADE_DATE arrived as '' rather than undefined. `??` let it
// through, the trade date came out blank, and the freshness check compared
// asOf against '' — so every scheduled run would have failed as STALE_UPSTREAM
// and archived nothing, permanently.
test('an empty TRADE_DATE is not an override', () => {
  const now = new Date('2026-08-11T10:35:00Z');
  assert.equal(resolveTradeDate('', now), '2026-08-11');
  assert.equal(resolveTradeDate(undefined, now), '2026-08-11');
  assert.equal(resolveTradeDate(null, now), '2026-08-11');
  assert.equal(resolveTradeDate('   ', now), '2026-08-11', 'whitespace is not a date either');
});

test('a real TRADE_DATE overrides, a malformed one throws', () => {
  const now = new Date('2026-08-11T10:35:00Z');
  assert.equal(resolveTradeDate('2026-08-07', now), '2026-08-07');
  // Fail loudly rather than archiving into a junk directory name.
  assert.throws(() => resolveTradeDate('yesterday', now), /YYYY-MM-DD/);
  assert.throws(() => resolveTradeDate('11-08-2026', now), /YYYY-MM-DD/);
});

test('flattenSnapshot uses the chain as the row source', () => {
  const rows = flattenSnapshot(SNAP);
  assert.equal(rows.length, 2, 'one row per chain leg');
  const byStrike = Object.fromEntries(rows.map((r) => [r.strike, r]));

  // volume exists only on chain rows — proving we did not key off candidates.
  assert.equal(byStrike[350].volume, 180000);
  assert.equal(byStrike[400].volume, 2517000);
  // The non-candidate strike carries no conviction fields.
  assert.equal(byStrike[350].conviction, undefined);
});

test('candidate fields are layered onto the matching chain leg', () => {
  const r = flattenSnapshot(SNAP).find((x) => x.strike === 400);
  assert.equal(r.conviction, 73);
  assert.equal(r.band, 'HIGH');
  // edgePct is a FRACTION upstream and PERCENT here.
  assert.equal(r.edge_pct, 5.13);
  // p_profit must be the real-world pProfit, never the risk-neutral probProfit
  // (which is 1-|delta| by construction and carries no information).
  assert.equal(r.p_profit, 0.916);
  // Forecast-vol variants win over the IV-based ones, which are circular.
  assert.equal(r.cushion_sigma, 1.35);
  assert.equal(r.prob_touch, 0.195);
  assert.equal(r.empirical, 1);
  assert.equal(r.delivery_risk, 0);
});

test('per-expiry verdict and metrics ride on every row of that expiry', () => {
  for (const r of flattenSnapshot(SNAP)) {
    assert.equal(r.verdict, 'NEUTRAL');
    assert.equal(r.verdict_score, 0.9);
    assert.equal(r.verdict_confidence, 0.73);
    assert.equal(r.pcr_oi, 0.54);
    assert.equal(r.max_pain, 360);
    assert.equal(r.vrp, 1.4);
    assert.equal(r.term_regime, 'backwardation');
    assert.equal(r.near_iv, 0.4895);
    assert.equal(r.gap_share, 0.219);
    assert.equal(r.lot_size, 3000);
    assert.equal(r.prev_close, 369.3);
  }
});

test('an index-shaped snapshot (no term/gap block) still normalises', () => {
  const idx = structuredClone(SNAP);
  idx.index = 'NIFTY';
  delete idx.term;
  delete idx.gap;
  delete idx.expiries['2026-08-25'].candidates[0].deliveryRisk;
  const r = flattenSnapshot(idx).find((x) => x.strike === 400);
  assert.equal(r.near_iv, null);
  assert.equal(r.term_regime, null, 'no regime label invented for indices');
  assert.equal(r.term_slope, 7.57, 'falls back to metrics.termSlope');
  assert.equal(r.gap_share, 0.219, 'falls back to metrics.gapShare');
  // Cash-settled: delivery risk must stay NULL, never 0/false.
  assert.equal(r.delivery_risk, null);
});

test('inserts are idempotent and re-running never duplicates rows', () => {
  const db = openDb(tmpDb());
  const insert = makeInserter(db, 'archive');
  const rows = flattenSnapshot(SNAP);
  for (const r of rows) insert(r);
  for (const r of rows) insert(r);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM snapshots').get().n, 2);
  db.close();
});

test('archive mode prefers fresh values but never erases with NULL', () => {
  const db = openDb(tmpDb());
  const insert = makeInserter(db, 'archive');
  const [row] = flattenSnapshot(SNAP);
  insert({ ...row, ltp: 3.95, conviction: 73 });
  // A later partial capture: new ltp, conviction absent.
  insert({ ...row, ltp: 4.10, conviction: null });
  const got = db.prepare('SELECT ltp, conviction FROM snapshots WHERE strike = 400').get();
  assert.equal(got.ltp, 4.10, 'fresh value wins');
  assert.equal(got.conviction, 73, 'existing value survives a NULL');
  db.close();
});

test('backfill mode fills only NULLs and never overwrites captured data', () => {
  const db = openDb(tmpDb());
  const [row] = flattenSnapshot(SNAP);
  makeInserter(db, 'archive')({ ...row, ltp: 3.95, vrp: 1.4, conviction: null });

  makeInserter(db, 'backfill')({ ...row, ltp: 99.99, vrp: null, conviction: 60 });
  const got = db.prepare("SELECT ltp, vrp, conviction, src FROM snapshots WHERE strike = 400").get();
  assert.equal(got.ltp, 3.95, 'captured ltp must survive a backfill replay');
  assert.equal(got.vrp, 1.4);
  assert.equal(got.conviction, 60, 'a NULL column is still fillable');
  assert.equal(got.src, 'archive', 'backfill must not demote provenance');
  db.close();
});

test('backfill data parses to the expected shape', () => {
  const rows = backfillRows();
  const d0807 = rows.filter((r) => r.trade_date === '2026-08-07');
  const d0810 = rows.filter((r) => r.trade_date === '2026-08-10');
  const d0811 = rows.filter((r) => r.trade_date === '2026-08-11');
  assert.equal(d0807.length, 12);
  assert.equal(d0810.length, 6);
  // 2 + 3 + 3 + 2 + 2 + 3 + 2 + 1 legs across the eight marked underlyings.
  assert.equal(d0811.length, 18);

  // Verdict with a score.
  const man = d0807.find((r) => r.symbol === 'MANAPPURAM' && r.strike === 335);
  assert.equal(man.type, 'PE');
  assert.equal(man.ltp, 3.65);
  assert.equal(man.lot_size, 3000);
  assert.equal(man.conviction, 79);
  assert.equal(man.p_profit, 0.890);
  assert.equal(man.edge_pct, 4.09);
  assert.equal(man.verdict, 'NEUTRAL');
  assert.equal(man.verdict_score, 0.8);
  assert.equal(man.dte, 18);

  // Verdict without a score must leave verdict_score NULL, not 0.
  const bhel = d0810.find((r) => r.symbol === 'BHEL' && r.strike === 465);
  assert.equal(bhel.verdict, 'NEUTRAL');
  assert.equal(bhel.verdict_score, null);

  // The 08-11 mark carries term structure for the two names it was taken for.
  const bf = d0811.find((r) => r.symbol === 'BHARATFORG' && r.strike === 2440);
  assert.equal(bf.term_regime, 'contango');
  assert.equal(bf.term_slope, -23.78);
  assert.equal(bf.verdict_score, -4.5);
  assert.equal(bf.lot_size, 500, 'static lot size carried from the same expiry');
  // ...and none for the names it was not.
  assert.equal(d0811.find((r) => r.symbol === 'MCX').term_regime, null);
});

test('all backfill rows have a complete primary key', () => {
  for (const r of backfillRows()) {
    for (const k of ['trade_date', 'symbol', 'expiry', 'strike', 'type']) {
      assert.ok(r[k] !== undefined && r[k] !== null, `${k} missing on ${JSON.stringify(r)}`);
    }
    assert.ok(['CE', 'PE'].includes(r.type));
  }
});

test('missed days are recorded and cleared by a later successful run', () => {
  const db = openDb(tmpDb());
  recordMissedDay(db, { tradeDate: '2026-08-12', reason: 'STALE_UPSTREAM', detail: 'asOf 08-11', attempts: 7 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM missed_days').get().n, 1);
  // Replaying the same day must not create a second row.
  recordMissedDay(db, { tradeDate: '2026-08-12', reason: 'STALE_UPSTREAM', attempts: 7 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM missed_days').get().n, 1);
  // A catch-up run that succeeds clears the miss.
  recordRun(db, { tradeDate: '2026-08-12', asOf: '2026-08-12T10:15:00Z', rowsWritten: 10 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM missed_days').get().n, 0);
  db.close();
});

test('hasSnapshot only counts real captures, not backfill', () => {
  const db = openDb(tmpDb());
  const [row] = flattenSnapshot(SNAP);
  makeInserter(db, 'backfill')({ ...row, trade_date: '2026-08-07' });
  assert.equal(hasSnapshot(db, '2026-08-07'), false, 'a backfilled day still needs capturing');
  makeInserter(db, 'archive')({ ...row, trade_date: '2026-08-07' });
  assert.equal(hasSnapshot(db, '2026-08-07'), true);
  db.close();
});

// The entire reason this repo exists is that upstream destroys its own history
// with force_orphan. If a force-push ever creeps into this codebase it would
// reproduce that exact bug on the one copy of the data that survives.
test('no force-push or force_orphan anywhere in the archiver', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const banned = [/--force\b/, /\bforce_orphan\b/, /push\s+-f\b/, /\+refs\//];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // `test` is skipped because this file necessarily contains the very
      // patterns it bans; the invariant covers the shipped scripts + workflow.
      const skip = ['node_modules', '.git', 'archive', '.work', 'test'];
      if (skip.includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js|yml|yaml|sh)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const re of banned) {
        // The prohibition is quoted in prose in several places; only flag it
        // outside comments.
        const hits = src.split('\n').filter((l) => re.test(l) && !/^\s*(#|\/\/|\*)/.test(l));
        assert.equal(hits.length, 0, `${path.relative(root, p)} contains ${re}: ${hits.join(' | ')}`);
      }
    }
  };
  walk(root);
});
