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
