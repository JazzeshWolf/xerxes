// Flatten an upstream Xerxes snapshot JSON into flat `snapshots` rows.
//
// Row source is the CHAIN, not the candidate list. Two reasons:
//   1. Only chain rows carry `volume` (candidates omit it).
//   2. A strike that is a ranked candidate today may drop off the list
//      tomorrow. Keying off the chain keeps an unbroken LTP path for every
//      strike from entry to expiry, which is the whole point of the archive —
//      candidate-only rows would leave holes exactly where a trade got
//      interesting.
// Candidate fields are then layered onto the matching (strike, type).

// ---------------------------------------------------------------------------
// KNOWN DATA LIMITS — encoded here so nobody rediscovers them the hard way.
//
// * `spot.history` is EMPTY in every stock file, so there is NO intraday
//   high/low anywhere in this source. probTouch / prob_touch can therefore
//   NEVER be validated from this archive. Do not build that test — you would
//   only be measuring your own assumption. (Index files DO carry a daily close
//   history, but daily closes are still not intraday extremes.)
//
// * `ivRank`/`ivPercentile` are null across the board: upstream needs 20 points
//   of ivHistory and currently holds ~4. Conviction is therefore running on
//   6 of its 7 factors, with the ivRank weight redistributed pro-rata. Any
//   analysis run before ~20 trading days of archive have accumulated must be
//   flagged partial-factor. `vrp` carries related information from day one.
//
// * Data is ~10 minutes delayed, and the 15:45 IST build is a post-close
//   snapshot, NOT a settlement print. Do not treat `ltp` as a settlement price.
// ---------------------------------------------------------------------------

/** UTC date (YYYY-MM-DD) of an ISO timestamp.
 *
 * UTC date == IST trade date for this data because every upstream build fires
 * between 03:00 and 11:00 UTC (08:30-16:30 IST) — the window never straddles a
 * UTC midnight, so no timezone correction is needed or wanted. */
export function tradeDateOf(isoTs) {
  return new Date(isoTs).toISOString().slice(0, 10);
}

/** Resolve the trade date to capture, given a raw TRADE_DATE override.
 *
 * Lives here rather than in archive.mjs so it is importable by tests without
 * executing the capture. The empty-string case is the one that matters: GitHub
 * Actions renders an unset workflow input as '', and a `schedule` event has no
 * inputs at all, so the override arrives as '' rather than undefined. Treating
 * that as a real value produced a blank trade date and broke every scheduled
 * run. A malformed override throws rather than silently archiving to a junk
 * directory name. */
export function resolveTradeDate(raw, now = new Date()) {
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (v === '') return now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`TRADE_DATE must be YYYY-MM-DD, got '${raw}'`);
  }
  return v;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
const bool = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : null);

/**
 * @param {object} snap  parsed upstream snapshot (a stock file or an index file)
 * @returns {object[]}   flat rows ready for makeInserter()
 */
export function flattenSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return [];
  const ts = snap.asOf;
  if (!ts) return [];

  const symbol = snap.index;          // NSE symbol for stocks, index key for indices
  if (!symbol) return [];

  const tradeDate = tradeDateOf(ts);
  const spot = num(snap.spot?.price);
  const prevClose = num(snap.spot?.prevClose);
  const changePct = num(snap.spot?.changePct);
  const lotSize = int(snap.lotSize);

  // Term structure lives at the top level for stocks. Index files have no
  // `term` block at all, so fall back to the per-expiry metric for the slope
  // and leave the regime label NULL rather than inventing one.
  const term = snap.term ?? null;
  const nearIv = num(term?.nearIv);
  const farIv = num(term?.farIv);
  const termRegime = term?.regime ?? null;

  // `gap` is stock-only by design: an index has no earnings and barely gaps,
  // so upstream passes gap as null for indices and the haircut is skipped.
  const gapShareTop = num(snap.gap?.gapShare);

  const rows = [];
  for (const [expiryDate, block] of Object.entries(snap.expiries ?? {})) {
    if (!block) continue;
    const m = block.metrics ?? {};
    const v = block.verdict ?? {};

    // Per-expiry shared context. Verdicts are computed per expiry upstream, so
    // the read follows the horizon — do NOT substitute the top-level verdict.
    const ctx = {
      ts,
      trade_date: tradeDate,
      symbol,
      expiry: block.date ?? expiryDate,
      dte: int(block.dte),
      spot,
      prev_close: prevClose,
      change_pct: changePct,
      lot_size: lotSize,
      vrp: num(m.vrp),
      pcr_oi: num(m.pcrOi),
      max_pain: num(m.maxPain),
      call_wall: num(m.callWall),
      put_wall: num(m.putWall),
      near_iv: nearIv,
      far_iv: farIv,
      term_slope: num(term?.slopePts) ?? num(m.termSlope),
      term_regime: termRegime,
      gap_share: gapShareTop ?? num(m.gapShare),
      verdict: v.verdict ?? null,
      verdict_score: num(v.score),
      verdict_confidence: num(v.confidence),
    };

    // Index candidates by strike|type so chain rows can pick them up in O(1).
    const candByKey = new Map();
    for (const c of block.candidates ?? []) {
      if (c?.strike == null || !c.type) continue;
      candByKey.set(`${c.strike}|${c.type}`, c);
    }

    const seen = new Set();
    for (const leg of block.chain ?? []) {
      if (leg?.strike == null || !leg.type) continue;
      const key = `${leg.strike}|${leg.type}`;
      seen.add(key);
      rows.push({ ...ctx, ...legFields(leg), ...candFields(candByKey.get(key)) });
    }

    // A candidate with no chain row shouldn't happen, but if upstream ever
    // truncates the chain we keep the ranked trade rather than dropping it.
    for (const [key, c] of candByKey) {
      if (seen.has(key)) continue;
      rows.push({ ...ctx, ...legFields(c), ...candFields(c) });
    }
  }
  return rows;
}

function legFields(leg) {
  return {
    strike: num(leg.strike),
    type: leg.type,
    ltp: num(leg.ltp),
    iv: num(leg.iv),
    delta: num(leg.delta),
    oi: int(leg.oi),
    volume: int(leg.volume),
  };
}

function candFields(c) {
  if (!c) return {};
  return {
    conviction: num(c.conviction),
    band: c.band ?? null,
    // pProfit is the real-world (forecast-vol + drift) probability of keeping
    // the premium. Deliberately NOT probProfit, which is the risk-neutral
    // 1-|delta| proxy and carries zero information by construction.
    p_profit: num(c.pProfit) ?? num(c.probProfit),
    // Upstream stores edgePct as a FRACTION (0.0513). Stored here in percent
    // units (5.13) so it matches how the app reads it out and how the
    // backfilled rows were recorded.
    edge_pct: c.edgePct == null ? null : num(c.edgePct) * 100,
    fair: num(c.fair),
    // Prefer the forecast-vol variants: the IV-based cushion/touch are circular
    // for a seller (high IV makes a strike look safe precisely because it is
    // priced as risky).
    cushion_sigma: num(c.cushionSigmaF) ?? num(c.cushionSigma),
    prob_touch: num(c.probTouchF) ?? num(c.probTouch),
    cvar: num(c.cvar),
    worst: num(c.worst),
    tail_reliance: num(c.tailReliance),
    empirical: bool(c.empirical),
    // Physically-settled NSE stock options only. Indices are cash settled, so
    // this stays NULL for them — it is a badge, never a filter.
    delivery_risk: bool(c.deliveryRisk),
  };
}
