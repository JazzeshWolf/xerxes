// ---------------------------------------------------------------------------
// Pure analytics for the index option screener. No I/O — everything here is
// unit-tested against fixtures (analytics.test.mjs).
//
// Chain row shape (both sources normalize to this):
//   { strike, type: "CE"|"PE", ltp, iv, oi, prevOi, volume, delta }
//
// Honesty note: the direction engine's weights are hand-set PRIORS, not
// backtested. The output is a structured opinion for an option SELLER —
// trust the verdict band + confidence, not the decimal.
// ---------------------------------------------------------------------------

export function round(x, d = 0) {
  if (x == null || !Number.isFinite(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Tag each ISO expiry "weekly" or "monthly". An expiry is the MONTHLY when it
 * is the last one in its calendar month (index monthlies expire on the last
 * weekly of the month). Works for weekly indices (NIFTY/SENSEX) and
 * monthly-only ones (BANKNIFTY — every expiry ends up "monthly").
 */
export function labelExpiries(expiries) {
  const sorted = [...new Set(expiries)].sort();
  const out = {};
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    out[cur] = !next || next.slice(0, 7) !== cur.slice(0, 7) ? "monthly" : "weekly";
  }
  return out;
}

// --- Black-Scholes (index options on spot, r≈0 over weekly tenors) ---------
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function bsPrice(F, K, t, vol, type) {
  if (t <= 0 || vol <= 0 || F <= 0 || K <= 0) return type === "CE" ? Math.max(F - K, 0) : Math.max(K - F, 0);
  const sT = Math.sqrt(t);
  const d1 = (Math.log(F / K) + ((vol * vol) / 2) * t) / (vol * sT);
  const d2 = d1 - vol * sT;
  return type === "CE" ? F * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - F * normCdf(-d1);
}

export function bsDelta(F, K, t, vol, type) {
  if (t <= 0 || vol <= 0 || F <= 0 || K <= 0) return null;
  const d1 = (Math.log(F / K) + ((vol * vol) / 2) * t) / (vol * Math.sqrt(t));
  return type === "CE" ? normCdf(d1) : normCdf(d1) - 1;
}

/** Solve implied vol from an option price (bisection; null when unsolvable). */
export function impliedVol(price, F, K, t, type) {
  if (!(price > 0) || t <= 0 || F <= 0 || K <= 0) return null;
  const intrinsic = type === "CE" ? Math.max(F - K, 0) : Math.max(K - F, 0);
  if (price < intrinsic - 1e-6) return null;
  let lo = 0.001, hi = 5, flo = bsPrice(F, K, t, lo, type) - price;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fm = bsPrice(F, K, t, mid, type) - price;
    if (Math.abs(fm) < 1e-4) return mid;
    if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
  }
  return null;
}

/** Probability the underlying TOUCHES strike K before expiry (≈ 2×P(ITM)). */
export function probTouch(F, K, t, vol) {
  if (!(F > 0) || !(K > 0) || !(t > 0) || !(vol > 0)) return null;
  const d = Math.abs(Math.log(K / F)) / (vol * Math.sqrt(t));
  return clamp(2 * (1 - normCdf(d)), 0, 1);
}

// --- Chain aggregates -------------------------------------------------------

export function pcr(chain) {
  let ce = 0, pe = 0, ceV = 0, peV = 0;
  for (const o of chain) {
    if (o.type === "CE") { ce += o.oi; ceV += o.volume ?? 0; }
    else { pe += o.oi; peV += o.volume ?? 0; }
  }
  return {
    oi: ce > 0 ? round(pe / ce, 2) : null,
    volume: ceV > 0 ? round(peV / ceV, 2) : null,
    totalCallOi: ce,
    totalPutOi: pe,
  };
}

/** Strike minimizing total option-writer payout (where sellers want to pin). */
export function maxPain(chain) {
  const strikes = [...new Set(chain.map((o) => o.strike))].sort((a, b) => a - b);
  if (strikes.length < 3) return null;
  let best = null, bestPay = Infinity;
  for (const s of strikes) {
    let pay = 0;
    for (const o of chain) pay += o.oi * (o.type === "CE" ? Math.max(0, s - o.strike) : Math.max(0, o.strike - s));
    if (pay < bestPay) { bestPay = pay; best = s; }
  }
  return best;
}

/**
 * OI walls: the biggest call-OI strike above spot (resistance magnet) and the
 * biggest put-OI strike below spot (support magnet), plus ranked top-N lists.
 */
export function walls(chain, spot, n = 3) {
  const ce = chain.filter((o) => o.type === "CE" && o.oi > 0);
  const pe = chain.filter((o) => o.type === "PE" && o.oi > 0);
  const above = ce.filter((o) => o.strike >= spot).sort((a, b) => b.oi - a.oi);
  const below = pe.filter((o) => o.strike <= spot).sort((a, b) => b.oi - a.oi);
  const top = (list) => list.slice(0, n).map((o) => ({ strike: o.strike, oi: o.oi }));
  return {
    callWall: above[0]?.strike ?? ce.sort((a, b) => b.oi - a.oi)[0]?.strike ?? null,
    putWall: below[0]?.strike ?? pe.sort((a, b) => b.oi - a.oi)[0]?.strike ?? null,
    resistances: top(above),
    supports: top(below),
  };
}

/** Day's OI build-up per side (needs prevOi). Positive = fresh writing. */
export function oiFlow(chain) {
  let ceChg = 0, peChg = 0, have = 0;
  for (const o of chain) {
    if (o.prevOi == null) continue;
    have++;
    const chg = o.oi - o.prevOi;
    if (o.type === "CE") ceChg += chg;
    else peChg += chg;
  }
  if (!have) return null;
  return { callOiChg: ceChg, putOiChg: peChg };
}

export function atmStrike(chain, spot) {
  const strikes = [...new Set(chain.map((o) => o.strike))];
  if (!strikes.length || !(spot > 0)) return null;
  return strikes.reduce((b, s) => (Math.abs(s - spot) < Math.abs(b - spot) ? s : b), strikes[0]);
}

/** ATM IV = mean of ATM CE/PE IVs (falls back to solving from straddle LTPs). */
export function atmIv(chain, spot, t) {
  const k = atmStrike(chain, spot);
  if (k == null) return null;
  const legs = chain.filter((o) => o.strike === k);
  const ivs = legs.map((o) => o.iv).filter((v) => v != null && v > 0);
  if (ivs.length) return ivs.reduce((a, b) => a + b, 0) / ivs.length;
  const solved = legs
    .map((o) => (o.ltp > 0 ? impliedVol(o.ltp, spot, k, t, o.type) : null))
    .filter((v) => v != null);
  return solved.length ? solved.reduce((a, b) => a + b, 0) / solved.length : null;
}

/** ATM straddle price — the market's own expected move to expiry (in points). */
export function straddlePrice(chain, spot) {
  const k = atmStrike(chain, spot);
  if (k == null) return null;
  const ce = chain.find((o) => o.strike === k && o.type === "CE")?.ltp;
  const pe = chain.find((o) => o.strike === k && o.type === "PE")?.ltp;
  return ce > 0 && pe > 0 ? ce + pe : null;
}

/**
 * IV skew: OTM put IV minus OTM call IV at ~2.5% out. Positive = puts bid
 * (downside fear), negative = calls bid (upside chase).
 */
export function ivSkew(chain, spot, pct = 0.025) {
  if (!(spot > 0)) return null;
  const nearestIv = (target, type) => {
    const c = chain
      .filter((o) => o.type === type && o.iv != null && o.iv > 0)
      .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
    return c && Math.abs(c.strike - target) / spot < 0.02 ? c.iv : null;
  };
  const pe = nearestIv(spot * (1 - pct), "PE");
  const ce = nearestIv(spot * (1 + pct), "CE");
  return pe != null && ce != null ? pe - ce : null;
}

/**
 * Gamma-exposure read — is the market PINNING (dealers long gamma, price
 * dampened toward big strikes) or prone to fast moves? BS gamma × OI per
 * strike, calls +, puts − (standard dealer convention). A lean, not a law.
 */
export function computeGex(chain, F, t) {
  const rows = chain.filter((o) => o.iv != null && o.iv > 0 && o.oi > 0 && o.strike > 0);
  if (!(F > 0) || !(t > 0) || rows.length < 6) return null;
  const perStrike = new Map();
  let callG = 0, putG = 0;
  for (const o of rows) {
    const sT = o.iv * Math.sqrt(t);
    const d1 = (Math.log(F / o.strike) + ((o.iv * o.iv) / 2) * t) / sT;
    const gamma = Math.exp(-(d1 * d1) / 2) / Math.sqrt(2 * Math.PI) / (F * sT);
    const g = gamma * o.oi;
    perStrike.set(o.strike, (perStrike.get(o.strike) ?? 0) + g);
    if (o.type === "CE") callG += g;
    else putG += g;
  }
  const tot = callG + putG;
  if (!(tot > 0)) return null;
  const netPct = Math.round(((callG - putG) / tot) * 100);
  const regime = netPct >= 20 ? "pinning" : netPct <= -20 ? "volatile" : "balanced";
  const pinStrike = [...perStrike.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { netPct, regime, pinStrike, coverage: rows.length };
}

// --- Market structure (price × OI) -----------------------------------------
/**
 * Classic F&O read: combine the day's PRICE change with the day's OPEN-INTEREST
 * change (on the front future) to name what participants are doing. `priceChgPct`
 * and `oiChgPct` are fractions (0.004 = +0.4%). Moves inside the dead-bands →
 * "Indecisive". Returns null when either input is missing (never fabricated).
 *
 *   price ↑ OI ↑ = Long buildup     (fresh longs)        — bullish, strong
 *   price ↓ OI ↑ = Short buildup     (fresh shorts)       — bearish, strong
 *   price ↑ OI ↓ = Short covering    (shorts exiting)     — bullish, weak
 *   price ↓ OI ↓ = Long unwinding    (longs exiting)      — bearish, weak
 */
export function futuresStructure(priceChgPct, oiChgPct, { priceEps = 0.001, oiEps = 0.005 } = {}) {
  if (priceChgPct == null || oiChgPct == null || !Number.isFinite(priceChgPct) || !Number.isFinite(oiChgPct)) {
    return null;
  }
  const pUp = priceChgPct > priceEps, pDn = priceChgPct < -priceEps;
  const oUp = oiChgPct > oiEps, oDn = oiChgPct < -oiEps;
  const base = { priceChgPct: round(priceChgPct, 4), oiChgPct: round(oiChgPct, 4) };
  if ((!pUp && !pDn) || (!oUp && !oDn)) {
    return {
      ...base,
      label: "Indecisive",
      bias: "neutral",
      strength: "weak",
      why:
        !pUp && !pDn
          ? "Price barely moved — no clear directional commitment from the day's flow."
          : "Open interest barely changed — positions are being held, not added or cut.",
      howToTrade: "No structural edge — range-sell (condor/strangle) or stand aside for a signal.",
    };
  }
  if (pUp && oUp) {
    return {
      ...base,
      label: "Long buildup",
      bias: "bullish",
      strength: "strong",
      why: "Price rising with fresh open interest — new longs are entering; the up-move has conviction and fuel.",
      howToTrade: "Trend has backing — favour selling puts below support; risky to sell calls into strength.",
    };
  }
  if (pDn && oUp) {
    return {
      ...base,
      label: "Short buildup",
      bias: "bearish",
      strength: "strong",
      why: "Price falling with rising open interest — fresh shorts are being added; the down-move has conviction.",
      howToTrade: "Favour selling calls into rallies / above resistance; don't sell puts under a building short base.",
    };
  }
  if (pUp && oDn) {
    return {
      ...base,
      label: "Short covering",
      bias: "bullish",
      strength: "weak",
      why: "Price rising while open interest falls — shorts are covering, not fresh buying; rallies can fade once covering is done.",
      howToTrade: "Bounce may be technical — don't chase; short calls above resistance can still work but keep them tight.",
    };
  }
  // pDn && oDn
  return {
    ...base,
    label: "Long unwinding",
    bias: "bearish",
    strength: "weak",
    why: "Price falling while open interest falls — longs are exiting, not aggressive shorting; selling pressure may ease.",
    howToTrade: "Weak-handed decline — wait for stabilisation; premature to sell calls aggressively.",
  };
}

// --- small stats ------------------------------------------------------------
export function ema(values, n) {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function pctChange(values, n) {
  if (values.length < n + 1) return null;
  const a = values[values.length - 1 - n], b = values[values.length - 1];
  return a > 0 ? (b - a) / a : null;
}

export function realizedVol(values, n = 20) {
  const v = values.slice(-(n + 1));
  if (v.length < 3) return null;
  const rets = [];
  for (let i = 1; i < v.length; i++) if (v[i - 1] > 0 && v[i] > 0) rets.push(Math.log(v[i] / v[i - 1]));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  return Number.isFinite(sd) ? sd * Math.sqrt(252) : null;
}

export function rangeRank(x, sample) {
  if (x == null || !sample.length) return null;
  const lo = Math.min(...sample), hi = Math.max(...sample);
  return hi === lo ? 50 : clamp(((x - lo) / (hi - lo)) * 100, 0, 100);
}

export function percentile(x, sample) {
  if (x == null || !sample.length) return null;
  return round((sample.filter((v) => v <= x).length / sample.length) * 100, 1);
}

// --- Direction engine -------------------------------------------------------
// Each factor emits a signal in [-1, +1] (+ = bullish for the index) plus a
// human-readable reading. Missing factors are dropped and their weight
// redistributed pro-rata — never a silent zero.

const FACTORS = [
  { key: "trend", label: "Price vs 20/50-EMA", weight: 0.20 },
  { key: "momentum", label: "Momentum (5d/20d)", weight: 0.15 },
  { key: "oiFlowSig", label: "OI flow (put vs call writing)", weight: 0.17 },
  { key: "pcrSig", label: "PCR positioning", weight: 0.12 },
  { key: "maxPainPull", label: "Max-pain gravity", weight: 0.10 },
  { key: "skewSig", label: "IV skew", weight: 0.08 },
  { key: "vixSig", label: "VIX trend (inverse)", weight: 0.10 },
  { key: "basisSig", label: "Futures basis", weight: 0.08 },
];

/**
 * inputs: {
 *   closes: number[] (daily index closes, oldest-first, incl. today),
 *   vixHistory: number[] | null,
 *   pcrOi, maxPainStrike, spot, expectedMove, flow: {callOiChg, putOiChg}|null,
 *   skew: number|null, basisPts: number|null (future - spot),
 * }
 */
export function directionScore(inputs) {
  const { closes, vixHistory, pcrOi, maxPainStrike, spot, expectedMove, flow, skew, basisPts } = inputs;
  const sig = {};

  // Trend: spot vs EMA20 and EMA50, scaled by ~1% bands.
  if (closes?.length >= 50 && spot > 0) {
    const e20 = ema(closes, 20), e50 = ema(closes, 50);
    if (e20 && e50) {
      const s = clamp(((spot - e20) / e20) / 0.01, -1, 1) * 0.6 + clamp(((spot - e50) / e50) / 0.02, -1, 1) * 0.4;
      sig.trend = { s: clamp(s, -1, 1), reading: `20-EMA ${round(e20)} · 50-EMA ${round(e50)}` };
    }
  }

  // Momentum: 5d + 20d returns, scaled by ~1.5% / 4%.
  if (closes?.length >= 21) {
    const r5 = pctChange(closes, 5), r20 = pctChange(closes, 20);
    if (r5 != null && r20 != null) {
      const s = clamp(r5 / 0.015, -1, 1) * 0.6 + clamp(r20 / 0.04, -1, 1) * 0.4;
      sig.momentum = { s: clamp(s, -1, 1), reading: `5d ${round(r5 * 100, 1)}% · 20d ${round(r20 * 100, 1)}%` };
    }
  }

  // OI flow: net put writing (put OI build > call OI build) = bullish.
  if (flow && (Math.abs(flow.callOiChg) + Math.abs(flow.putOiChg)) > 0) {
    const tot = Math.abs(flow.callOiChg) + Math.abs(flow.putOiChg);
    const s = clamp((flow.putOiChg - flow.callOiChg) / tot, -1, 1);
    sig.oiFlowSig = { s, reading: `ΔOI put ${fmtL(flow.putOiChg)} vs call ${fmtL(flow.callOiChg)}` };
  }

  // PCR: high PCR (>1.2) = heavy put writing = support; low (<0.7) = call-heavy.
  if (pcrOi != null) {
    const s = clamp((pcrOi - 1) / 0.4, -1, 1);
    sig.pcrSig = { s, reading: `PCR(OI) ${pcrOi}` };
  }

  // Max-pain gravity: expiry pull toward max pain, scaled by the expected move.
  if (maxPainStrike != null && spot > 0 && expectedMove > 0) {
    const s = clamp((maxPainStrike - spot) / expectedMove, -1, 1) * 0.9;
    sig.maxPainPull = { s, reading: `max pain ${maxPainStrike} vs spot ${round(spot)}` };
  }

  // Skew: put IV >> call IV = downside hedging demand = bearish pressure.
  if (skew != null) {
    const s = clamp(-skew / 0.04, -1, 1);
    sig.skewSig = { s, reading: `25∆-ish skew ${round(skew * 100, 1)} vol pts` };
  }

  // VIX trend: rising VIX = risk-off = bearish for the index.
  if (vixHistory?.length >= 6) {
    const v = vixHistory;
    const chg = (v[v.length - 1] - v[v.length - 6]) / v[v.length - 6];
    const s = clamp(-chg / 0.15, -1, 1);
    sig.vixSig = { s, reading: `VIX 5d ${round(chg * 100, 1)}%` };
  }

  // Basis: future trading rich (premium) = long bias; discount = caution.
  if (basisPts != null && spot > 0) {
    const s = clamp(basisPts / spot / 0.003, -1, 1);
    sig.basisSig = { s, reading: `basis ${round(basisPts, 1)} pts` };
  }

  // Weighted sum with pro-rata redistribution over present factors.
  const present = FACTORS.filter((f) => sig[f.key]);
  const wSum = present.reduce((a, f) => a + f.weight, 0);
  if (!present.length || wSum <= 0) {
    return { score: 0, confidence: 0, verdict: "NO DATA", structure: "No trade", factors: [] };
  }
  let score = 0;
  const factors = FACTORS.map((f) => {
    const p = sig[f.key];
    const w = p ? f.weight / wSum : 0;
    if (p) score += p.s * w;
    return { key: f.key, label: f.label, s: p ? round(p.s, 2) : null, weight: round(w, 3), reading: p?.reading ?? null, present: !!p };
  });
  score = round(score * 10, 1); // -10..+10

  // Confidence: data completeness × factor agreement.
  const completeness = present.length / FACTORS.length;
  const sVals = present.map((f) => sig[f.key].s);
  const meanS = sVals.reduce((a, b) => a + b, 0) / sVals.length;
  const agreement = sVals.length > 1
    ? clamp(1 - Math.sqrt(sVals.reduce((a, b) => a + (b - meanS) ** 2, 0) / sVals.length) / 0.8, 0, 1)
    : 0.5;
  const confidence = round(clamp(0.25 + 0.45 * completeness + 0.3 * agreement, 0, 1), 2);

  const verdict = score >= 3 ? "BULLISH" : score <= -3 ? "BEARISH" : "NEUTRAL";
  const strong = Math.abs(score) >= 3 && confidence >= 0.6;
  const structure =
    verdict === "NEUTRAL"
      ? confidence >= 0.55 ? "Iron condor / short strangle (defined-risk)" : "No trade — wait for alignment"
      : verdict === "BULLISH"
        ? strong ? "Sell put / put spread below support" : "Small sell-put lean, defined risk"
        : strong ? "Sell call / call spread above resistance" : "Small sell-call lean, defined risk";

  return { score, confidence, verdict, structure, factors };
}

function fmtL(n) {
  const a = Math.abs(n);
  const s = a >= 1e7 ? `${round(n / 1e7, 1)}Cr` : a >= 1e5 ? `${round(n / 1e5, 1)}L` : a >= 1e3 ? `${round(n / 1e3, 0)}k` : String(n);
  return n > 0 ? `+${s}` : s;
}

// --- Sell candidates --------------------------------------------------------
/**
 * Rank OTM strikes an option seller would actually consider: outside the
 * expected move, |delta| ≤ maxDelta, with a real premium. Delta comes from the
 * chain greeks when present, else solved from IV.
 * Puts first, then calls; within a side, ranked by expected credit retained
 * (premium × P(expire OTM)) so the richest acceptable strike tops the list.
 */
export function sellCandidates(chain, spot, t, expectedMove, { maxDelta = 0.25, minPremium = 2 } = {}) {
  if (!(spot > 0) || !(t > 0)) return [];
  const out = [];
  for (const o of chain) {
    if (!(o.ltp > 0) || !(o.oi > 0)) continue;
    const otm = o.type === "CE" ? o.strike > spot : o.strike < spot;
    if (!otm) continue;
    const iv = o.iv ?? impliedVol(o.ltp, spot, o.strike, t, o.type);
    if (!(iv > 0)) continue;
    const delta = o.delta ?? bsDelta(spot, o.strike, t, iv, o.type);
    if (delta == null || Math.abs(delta) > maxDelta) continue;
    if (o.ltp < minPremium) continue;
    const distance = Math.abs(o.strike - spot);
    const cushionSigma = expectedMove > 0 ? distance / expectedMove : null;
    const pot = probTouch(spot, o.strike, t, iv);
    out.push({
      strike: o.strike,
      type: o.type,
      ltp: o.ltp,
      iv: round(iv, 4),
      oi: o.oi,
      delta: round(delta, 3),
      distancePct: round((distance / spot) * 100, 2),
      cushionSigma: round(cushionSigma, 2),
      probTouch: round(pot, 3),
      probProfit: round(1 - Math.abs(delta), 3), // ≈ P(expire OTM)
    });
  }
  const evKeep = (r) => r.ltp * r.probProfit;
  return out.sort((a, b) => (a.type === b.type ? evKeep(b) - evKeep(a) : a.type === "PE" ? -1 : 1));
}

// --- Liquidity (for the stock screener) ------------------------------------
/**
 * Raw option-liquidity magnitude for one underlying: a log-blend of total
 * open-interest notional (Σ oi·ltp·lot), total option turnover (Σ vol·ltp·lot)
 * and the underlying's cash turnover. The three span orders of magnitude, so we
 * sum their log10s. Returns 0 when there is no live chain (→ bucket "None").
 * The absolute number is only meaningful relative to the rest of the universe —
 * `liquidityBucket` turns a cross-universe percentile rank into a label.
 */
export function liquidityScore(chain, lotSize = 1, underlyingTurnover = 0) {
  if (!Array.isArray(chain) || !chain.length) return 0;
  const lot = lotSize > 0 ? lotSize : 1;
  let oiNotional = 0, optTurnover = 0;
  for (const o of chain) {
    const px = o.ltp ?? 0;
    if (o.oi > 0 && px > 0) oiNotional += o.oi * px * lot;
    if ((o.volume ?? 0) > 0 && px > 0) optTurnover += o.volume * px * lot;
  }
  const logs = [oiNotional, optTurnover, underlyingTurnover].map((v) => (v > 0 ? Math.log10(v) : 0));
  return round(logs.reduce((a, b) => a + b, 0), 3);
}

/**
 * Map a cross-universe percentile `rank` (0..1) to a 6-level liquidity label.
 * A non-positive raw `score` (no live chain) is always "None", regardless of rank.
 */
export function liquidityBucket(rank, score = 1) {
  if (!(score > 0) || rank == null || !Number.isFinite(rank)) return "None";
  if (rank >= 0.85) return "High";
  if (rank >= 0.65) return "Medium-High";
  if (rank >= 0.45) return "Medium";
  if (rank >= 0.25) return "Medium-Low";
  return "Low";
}

// ===========================================================================
// PREDICTIVE LAYER (stock premium-selling candidates)
//
// Everything above answers "what does the chain look like right now". This
// section answers the different question "is selling THIS strike into THIS
// expiry likely to pay" — which needs a forecast of what the underlying will
// actually do, not just what the market is charging for it.
//
// The load-bearing idea: the market prices the option at its implied vol; we
// value it at OUR forecast of realized vol (plus a small drift). The gap
// between the premium collected and that fair value IS the expected edge.
//
// Why this can't be assumed rather than measured: Driessen, Maenhout & Vilkov
// (2009, J. Finance) show individual equity variance risk is essentially NOT
// priced — the index variance premium comes from correlation risk. So "sell
// premium because premium is rich" is false for single stocks; richness has to
// be established per name. That is exactly what `candidateEdge` does.
//
// Same honesty note as the direction engine applies: the WEIGHTS below are
// hand-set priors, not backtested. Trust the band and the factor breakdown,
// not the last digit of the score.
// ===========================================================================

/** Keep only bars with a full, positive OHLC. One bad bar shouldn't null a series. */
function cleanOhlc(ohlc) {
  if (!Array.isArray(ohlc)) return [];
  return ohlc.filter(
    (b) => b && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0 && b.h >= b.l,
  );
}

const variance = (arr) => {
  if (arr.length < 2) return null;
  const mu = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((a, b) => a + (b - mu) ** 2, 0) / (arr.length - 1);
};

/**
 * Yang-Zhang (2000) realized volatility from daily OHLC, annualized.
 *
 *   σ²_YZ = σ²_overnight + k·σ²_open→close + (1−k)·σ²_Rogers-Satchell
 *   k = 0.34 / (1.34 + (n+1)/(n−1))
 *
 * Preferred over the close-to-close `realizedVol` above for single stocks: it
 * is ~14× more efficient (so 20 bars actually say something) AND it is the only
 * common estimator that accounts for overnight gaps — which is most of what
 * kills a short option on an Indian single stock. Needs n+1 bars.
 */
export function yangZhangVol(ohlc, n = 20) {
  const bars = cleanOhlc(ohlc);
  if (n < 3 || bars.length < n + 1) return null;
  const w = bars.slice(-(n + 1));
  const overnight = [], openClose = [], rs = [];
  for (let i = 1; i < w.length; i++) {
    const prev = w[i - 1], b = w[i];
    overnight.push(Math.log(b.o / prev.c));
    openClose.push(Math.log(b.c / b.o));
    rs.push(Math.log(b.h / b.c) * Math.log(b.h / b.o) + Math.log(b.l / b.c) * Math.log(b.l / b.o));
  }
  const m = overnight.length;
  const vOvernight = variance(overnight), vOpenClose = variance(openClose);
  if (vOvernight == null || vOpenClose == null) return null;
  const vRs = rs.reduce((a, b) => a + b, 0) / rs.length;
  const k = 0.34 / (1.34 + (m + 1) / (m - 1));
  const v = vOvernight + k * vOpenClose + (1 - k) * vRs;
  return v > 0 ? Math.sqrt(v * 252) : null;
}

/**
 * How much of this name's recent risk arrives as GAPS rather than as tradeable
 * intraday movement. A short option can be managed through an intraday drift;
 * it cannot be managed through an overnight gap. `gapShare` is the fraction of
 * total variance contributed by close→open moves; `maxAbsMove` is the worst
 * single-day close-to-close move in the window; `jumpCount` counts days beyond
 * 3× the median absolute move.
 */
export function gapProfile(ohlc, n = 60) {
  const bars = cleanOhlc(ohlc).slice(-(n + 1));
  if (bars.length < 12) return null;
  let gapSq = 0, intraSq = 0, maxAbs = 0;
  const rets = [];
  for (let i = 1; i < bars.length; i++) {
    const g = Math.log(bars[i].o / bars[i - 1].c);
    const u = Math.log(bars[i].c / bars[i].o);
    const r = Math.abs(Math.log(bars[i].c / bars[i - 1].c));
    gapSq += g * g;
    intraSq += u * u;
    rets.push(r);
    if (r > maxAbs) maxAbs = r;
  }
  const tot = gapSq + intraSq;
  const sorted = [...rets].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    gapShare: tot > 0 ? round(gapSq / tot, 3) : null,
    maxAbsMove: round(maxAbs, 4),
    jumpCount: median > 0 ? rets.filter((r) => r > 3 * median).length : 0,
  };
}

/**
 * Horizon-matched volatility forecast for an expiry `dte` days away.
 *
 * Blend of Yang-Zhang over 20/60/120 bars, weighted toward the recent estimate
 * for near expiries and toward the slow one for far expiries, then mean-reverted
 * toward the slow estimate in proportion to horizon (vol mean-reverts, so a
 * 60-day forecast should not simply extrapolate the last three weeks).
 *
 * Finally inflated for gap-dominated names: close-to-close statistics understate
 * what a gappy stock does to a short option, so those names get a forecast that
 * is deliberately less flattering.
 */
export function forecastVol(ohlc, dte = 30) {
  const bars = cleanOhlc(ohlc);
  const rv20 = yangZhangVol(bars, 20);
  const rv60 = yangZhangVol(bars, 60);
  const rv120 = yangZhangVol(bars, 120);
  const parts = [[rv20, "w20"], [rv60, "w60"], [rv120, "w120"]].filter(([v]) => v > 0);
  if (!parts.length) return null;

  const h = clamp(dte, 1, 90);
  const w = { w20: clamp(0.65 - (h / 90) * 0.35, 0.25, 0.65), w60: 0.3 };
  w.w120 = Math.max(0.05, 1 - w.w20 - w.w60);

  let num = 0, den = 0;
  for (const [v, key] of parts) { num += v * w[key]; den += w[key]; }
  let sigma = num / den;

  // Mean-revert toward the slowest available estimate; longer horizon, more pull.
  const anchor = rv120 ?? rv60 ?? sigma;
  const lambda = clamp(h / 120, 0, 0.5);
  sigma = sigma * (1 - lambda) + anchor * lambda;

  const gap = gapProfile(bars, 60);
  if (gap?.gapShare != null) sigma *= 1 + 0.5 * Math.max(0, gap.gapShare - 0.35);

  return {
    sigma: round(sigma, 4),
    rv20: round(rv20, 4),
    rv60: round(rv60, 4),
    rv120: round(rv120, 4),
    gapShare: gap?.gapShare ?? null,
    maxAbsMove: gap?.maxAbsMove ?? null,
    jumpCount: gap?.jumpCount ?? null,
  };
}

/**
 * IV term structure between two expiries, in vol points (near − far).
 * Positive = BACKWARDATION: the front is bid over the back, which is how the
 * market prices a known near-term event or acute stress. Sustained backwardation
 * is the regime short-vol strategies lose in, so it tilts conviction down.
 */
export function termStructure(nearIv, farIv, nearDte, farDte) {
  if (!(nearIv > 0) || !(farIv > 0)) return null;
  if (nearDte != null && farDte != null && !(farDte > nearDte)) return null;
  const slopePts = round((nearIv - farIv) * 100, 2);
  return {
    slopePts,
    regime: slopePts > 2 ? "backwardation" : slopePts < -2 ? "contango" : "flat",
    nearIv: round(nearIv, 4),
    farIv: round(farIv, 4),
  };
}

/**
 * ATM call IV minus ATM put IV, in vol points — the Cremers & Weinbaum (2010,
 * JFQA) deviation-from-put-call-parity measure. Stocks whose calls are
 * relatively expensive outperform those whose puts are, so positive = bullish
 * tilt. Cheap to compute from a chain we already have, and it is the best
 * documented option-implied predictor of single-stock returns.
 */
export function cpIvSpread(chain, spot) {
  const k = atmStrike(chain, spot);
  if (k == null) return null;
  const ce = chain.find((o) => o.strike === k && o.type === "CE" && o.iv > 0)?.iv;
  const pe = chain.find((o) => o.strike === k && o.type === "PE" && o.iv > 0)?.iv;
  return ce > 0 && pe > 0 ? round((ce - pe) * 100, 2) : null;
}

/**
 * Volatility SMIRK: IV of the ~`pct` OTM put minus ATM IV, in vol points — the
 * Xing, Zhang & Zhao (2010, JFQA) measure. A steep smirk is the market paying up
 * for crash protection on this specific name, and predicts underperformance —
 * so it argues against selling ITS puts. Distinct from `ivSkew` above, which is
 * a symmetric ±2.5% put-vs-call spread; both are kept because they say different
 * things.
 */
export function putSmirk(chain, spot, pct = 0.1) {
  if (!(spot > 0)) return null;
  const k = atmStrike(chain, spot);
  if (k == null) return null;
  const atmIvs = chain.filter((o) => o.strike === k && o.iv > 0).map((o) => o.iv);
  if (!atmIvs.length) return null;
  const atm = atmIvs.reduce((a, b) => a + b, 0) / atmIvs.length;
  const target = spot * (1 - pct);
  const otm = chain
    .filter((o) => o.type === "PE" && o.iv > 0 && o.strike < spot)
    .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
  if (!otm || Math.abs(otm.strike - target) / spot > 0.05) return null;
  return round((otm.iv - atm) * 100, 2);
}

/**
 * REAL-WORLD probability the short option expires out of the money, under a
 * lognormal with our forecast vol and drift.
 *
 *   P(S_T < K) = N( (ln(K/S) − (μ − σ²/2)T) / (σ√T) )
 *
 * This is the whole point of the rewrite. `1 − |delta|` is the RISK-NEUTRAL
 * P(expire OTM) — under that measure every option is fair by construction, so
 * ranking by it conveys no information about whether the trade makes money.
 * Swapping the market's σ for our forecast, and adding a drift, is what makes
 * the number a prediction rather than a restatement of the price.
 */
export function pMeasureProb(S, K, T, sigma, mu = 0, type = "CE") {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return null;
  const d = (Math.log(K / S) - (mu - (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const below = normCdf(d); // P(S_T < K)
  return clamp(type === "CE" ? below : 1 - below, 0, 1);
}

/**
 * Annualized drift implied by a direction verdict, deliberately capped small
 * (±10%/yr at full score and full confidence). The direction weights are priors,
 * not backtested — letting them push the probability around hard would dress a
 * guess up as a forecast.
 */
export function driftFromVerdict(verdict, maxAnnual = 0.1) {
  if (!verdict || !Number.isFinite(verdict.score)) return 0;
  const s = clamp(verdict.score / 10, -1, 1);
  const c = clamp(verdict.confidence ?? 0, 0, 1);
  return s * c * maxAnnual;
}

/**
 * The expected edge in selling one option: premium received minus what the
 * option is worth under our forecast vol and drift, normalized by a margin
 * proxy so a ₹200 stock and a ₹4,000 stock compete on equal terms.
 *
 * `marginPct · spot` stands in for SPAN+exposure, which we can't compute without
 * exchange risk arrays. It is a constant-factor approximation, which is all the
 * ranking needs — it only has to be consistent across names.
 */
export function candidateEdge(ltp, S, K, T, sigmaForecast, mu, type, marginPct = 0.15) {
  if (!(ltp > 0) || !(S > 0) || !(K > 0) || !(T > 0) || !(sigmaForecast > 0)) return null;
  const fair = bsPrice(S * Math.exp((mu ?? 0) * T), K, T, sigmaForecast, type);
  const edge = ltp - fair;
  return { fair: round(fair, 2), edge: round(edge, 2), edgePct: round(edge / (marginPct * S), 4) };
}

// --- Conviction -------------------------------------------------------------
// Same contract as FACTORS/directionScore: each component emits s ∈ [0,1],
// missing components are DROPPED and their weight redistributed pro-rata rather
// than silently counted as zero.

const SELL_FACTORS = [
  { key: "edge", label: "Expected edge on margin", weight: 0.24 },
  { key: "vrp", label: "IV vs forecast RV", weight: 0.18 },
  { key: "direction", label: "Direction alignment", weight: 0.15 },
  { key: "cushion", label: "Cushion (forecast σ)", weight: 0.13 },
  { key: "survival", label: "Path safety to expiry", weight: 0.1 },
  { key: "ivRank", label: "IV rank", weight: 0.1 },
  { key: "liquidity", label: "Strike liquidity", weight: 0.1 },
];

export { SELL_FACTORS };

/**
 * Blended 0-100 conviction that selling this strike into this expiry pays.
 *
 * inputs: {
 *   type, strike, ltp, iv, oi, volume, lotSize,
 *   spot, t (years), sigmaForecast, mu, verdict,
 *   ivRank, gap: gapProfile(), term: termStructure(), smirk,
 * }
 *
 * Returns { conviction, band, factors[], edge, edgePct, fair, pProfit,
 *           cushionSigmaF, probTouchF, deliveryRisk } — or null when the
 * inputs can't support a score at all.
 */
export function sellConviction(inp) {
  const {
    type, strike: K, ltp, iv, oi = 0, volume = 0, lotSize = 1,
    spot: S, t, sigmaForecast: sf, mu = 0, verdict = null,
    ivRank = null, gap = null, term = null, smirk = null,
  } = inp ?? {};
  if (!(S > 0) || !(K > 0) || !(t > 0) || !(ltp > 0)) return null;

  const sig = {};

  // Expected edge on margin — the trade's own expected value.
  const ed = sf > 0 ? candidateEdge(ltp, S, K, t, sf, mu, type) : null;
  if (ed) sig.edge = { s: clamp(ed.edgePct / 0.02, 0, 1), reading: `${round(ed.edgePct * 100, 2)}% of margin (fair ₹${ed.fair})` };

  // Volatility risk premium for THIS name — measured, never assumed.
  if (iv > 0 && sf > 0) {
    const ratio = iv / sf;
    sig.vrp = { s: clamp((ratio - 1) / 0.5, 0, 1), reading: `IV ${round(iv * 100, 1)}% vs forecast RV ${round(sf * 100, 1)}% (${round(ratio, 2)}×)` };
  }

  // Direction alignment: short puts want a bullish read, short calls a bearish one.
  if (verdict && Number.isFinite(verdict.score)) {
    const align = type === "PE" ? verdict.score : -verdict.score; // -10..+10
    const conf = clamp(verdict.confidence ?? 0.5, 0, 1);
    const raw = clamp(0.5 + (align / 10) * 0.5, 0, 1);
    sig.direction = { s: 0.5 + (raw - 0.5) * conf, reading: `${verdict.verdict} ${verdict.score > 0 ? "+" : ""}${verdict.score} · sell ${type}` };
  }

  // Cushion measured in FORECAST sigmas. The old cushionSigma divided by the ATM
  // straddle, which made a high-IV name look safe precisely because its IV was
  // high — a circularity this removes.
  let cushionSigmaF = null;
  if (sf > 0) {
    const move = S * sf * Math.sqrt(t);
    if (move > 0) {
      cushionSigmaF = Math.abs(K - S) / move;
      sig.cushion = { s: clamp(cushionSigmaF / 2, 0, 1), reading: `${round(cushionSigmaF, 2)}σ away on forecast vol` };
    }
  }

  // Path safety: held to expiry you live through the whole path, so touch matters.
  // Stress-tested at 1.3× the forecast so a mild vol expansion doesn't surprise.
  let probTouchF = null;
  if (sf > 0) {
    probTouchF = probTouch(S, K, t, sf);
    const stressed = probTouch(S, K, t, sf * 1.3);
    if (probTouchF != null && stressed != null) {
      sig.survival = { s: clamp(1 - (0.6 * probTouchF + 0.4 * stressed), 0, 1), reading: `P(touch) ${round(probTouchF * 100, 0)}% · ${round(stressed * 100, 0)}% stressed` };
    }
  }

  // IV rank — null until enough history has accrued, and then its weight simply
  // rejoins the blend. Nothing is faked in the meantime.
  if (ivRank != null && Number.isFinite(ivRank)) {
    sig.ivRank = { s: clamp(ivRank / 60, 0, 1), reading: `IVR ${round(ivRank, 0)}` };
  }

  // Strike-level liquidity on THIS expiry — a far-month strike is not tradeable
  // just because the name's near month is.
  const lot = lotSize > 0 ? lotSize : 1;
  const oiNotional = oi > 0 ? oi * ltp * lot : 0;
  const turnover = volume > 0 ? volume * ltp * lot : 0;
  if (oiNotional > 0 || turnover > 0) {
    const sOi = oiNotional > 0 ? clamp((Math.log10(oiNotional) - 6) / 3, 0, 1) : 0;
    const sTurn = turnover > 0 ? clamp((Math.log10(turnover) - 5) / 3, 0, 1) : 0;
    sig.liquidity = { s: sOi * 0.6 + sTurn * 0.4, reading: `OI ${fmtL(oi)} · vol ${fmtL(volume)}` };
  }

  const present = SELL_FACTORS.filter((f) => sig[f.key]);
  const wSum = present.reduce((a, f) => a + f.weight, 0);
  if (!present.length || wSum <= 0) return null;
  let score = 0;
  const factors = SELL_FACTORS.map((f) => {
    const p = sig[f.key];
    const w = p ? f.weight / wSum : 0;
    if (p) score += p.s * w;
    return { key: f.key, label: f.label, s: p ? round(p.s, 2) : null, weight: round(w, 3), reading: p?.reading ?? null, present: !!p };
  });

  // --- modifiers ------------------------------------------------------------
  const notes = [];
  let mult = 1;

  // Gap-risk haircut. The names that blow up short premium held to expiry are the
  // ones whose risk arrives overnight, where no stop and no adjustment reaches.
  if (gap?.gapShare != null) {
    const cut = clamp((gap.gapShare - 0.35) / 0.4, 0, 1) * 0.35;
    if (cut > 0) {
      mult *= 1 - cut;
      notes.push(`gap risk: ${round(gap.gapShare * 100, 0)}% of variance arrives overnight`);
    }
  }
  if (gap?.maxAbsMove != null && sf > 0) {
    const dailySigma = sf / Math.sqrt(252);
    if (dailySigma > 0 && gap.maxAbsMove > 3.5 * dailySigma) {
      mult *= 0.85;
      notes.push(`recent ${round(gap.maxAbsMove * 100, 1)}% single-day move`);
    }
  }

  // Term structure: front bid over back = near-term event/stress priced in.
  if (term?.slopePts != null) {
    mult *= 1 - clamp(term.slopePts / 6, -1, 1) * 0.08;
    if (term.regime === "backwardation") notes.push(`backwardation ${term.slopePts} vol pts`);
  }

  // A steep crash smirk argues specifically against selling this name's puts.
  if (smirk != null && type === "PE" && smirk > 0) {
    const cut = clamp(smirk / 10, 0, 1) * 0.1;
    mult *= 1 - cut;
    if (cut > 0.03) notes.push(`put smirk ${smirk} vol pts`);
  }

  const conviction = round(clamp(score * mult, 0, 1) * 100, 0);
  const pProfit = sf > 0 ? pMeasureProb(S, K, t, sf, mu, type) : null;

  return {
    conviction,
    band: conviction >= 70 ? "HIGH" : conviction >= 50 ? "MEDIUM" : "LOW",
    factors,
    notes,
    fair: ed?.fair ?? null,
    edge: ed?.edge ?? null,
    edgePct: ed?.edgePct ?? null,
    pProfit: round(pProfit, 3),
    cushionSigmaF: round(cushionSigmaF, 2),
    probTouchF: round(probTouchF, 3),
    // NSE single stocks settle PHYSICALLY: an ITM short gets assigned into
    // delivery and margin steps up to ~40% of contract value near expiry. Shown
    // as a warning, never used to filter — the user asked to see the candidates.
    deliveryRisk: pProfit != null ? pProfit < 0.85 : null,
  };
}
