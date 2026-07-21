// ---------------------------------------------------------------------------
// Position analyzer — takes a multi-leg option position and evaluates it
// against the live snapshot: payoff at expiry, probability of profit, net
// greeks, and a rule-based "does this trade fit the market" assessment.
// All client-side and pure; premiums/IV/delta come from the chain already in
// the snapshot. A decision aid with hand-set rules — not backtested advice.
// ---------------------------------------------------------------------------

import type { Snapshot, ExpiryBlock, ChainRow } from "./types";

export interface Leg {
  id: string;
  type: "CE" | "PE";
  side: "buy" | "sell";
  strike: number;
  lots: number;
}

export interface LegResolved extends Leg {
  premium: number | null; // entry LTP per unit
  iv: number | null;
  delta: number | null;
}

export interface Assessment {
  score: number; // 0..100
  grade: "Good fit" | "Mixed" | "Poor fit" | "Incomplete";
  bias: "bullish" | "bearish" | "neutral";
  pros: string[];
  cons: string[];
  suggestions: string[];
}

export interface PositionResult {
  legs: LegResolved[];
  lotSize: number;
  valid: boolean;
  netCredit: number; // ₹ (positive = credit received)
  maxProfit: number | null; // ₹; null = unlimited
  maxLoss: number | null; // ₹ (negative); null = unlimited
  breakevens: number[];
  netDelta: number; // per position (× lotSize × lots)
  netTheta: number; // ₹/day (positive = decay works for you)
  pop: number | null; // probability of profit 0..1
  expectedPnl: number | null; // ₹
  curve: { s: number; pnl: number }[]; // P&L at expiry across the window
  curveToday: { s: number; pnl: number }[]; // theoretical P&L now (T+0, BS-priced)
  curveHalf: { s: number; pnl: number }[]; // theoretical P&L halfway to expiry
  spot: number;
  expectedMove: number; // ≈ 1 standard deviation for this expiry
  callWall: number | null; // biggest call OI strike for this expiry (resistance)
  putWall: number | null; // biggest put OI strike for this expiry (support)
  assessment: Assessment;
}

// --- Black-Scholes helpers, r≈0 ---------------------------------------------
function normPdf(x: number) {
  return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
}
function normCdf(x: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
/** Theoretical option price with `t` years to expiry (r=0). */
function bsPrice(S: number, K: number, t: number, vol: number, type: "CE" | "PE"): number {
  const intrinsic = type === "CE" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (!(t > 0) || !(vol > 0)) return intrinsic;
  const sT = vol * Math.sqrt(t);
  const d1 = (Math.log(S / K) + (vol * vol) / 2 * t) / sT;
  const d2 = d1 - sT;
  return type === "CE" ? S * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - S * normCdf(-d1);
}
/** Position P&L (₹) at underlying `S` with `t` years left, BS-priced. Null if
 *  any leg is missing IV (can't be priced before expiry). */
function pnlAtTime(S: number, legs: LegResolved[], lotSize: number, t: number): number | null {
  let pnl = 0;
  for (const l of legs) {
    if (l.premium == null) continue;
    if (l.iv == null) return null;
    const theo = bsPrice(S, l.strike, t, l.iv, l.type);
    const perUnit = l.side === "sell" ? l.premium - theo : theo - l.premium;
    pnl += perUnit * l.lots * lotSize;
  }
  return pnl;
}
function bsTheta(S: number, K: number, tYears: number, vol: number, type: "CE" | "PE"): number | null {
  if (!(S > 0) || !(K > 0) || !(tYears > 0) || !(vol > 0)) return null;
  const sT = vol * Math.sqrt(tYears);
  const d1 = (Math.log(S / K) + (vol * vol) / 2 * tYears) / sT;
  const d2 = d1 - sT;
  // r=0: theta = -(S φ(d1) vol) / (2√t). Same for call & put (no rate term).
  const annual = -(S * normPdf(d1) * vol) / (2 * Math.sqrt(tYears));
  void d2;
  void (type);
  return annual / 365;
}

const near = (chain: ChainRow[], strike: number, type: "CE" | "PE") =>
  chain.find((o) => o.strike === strike && o.type === type) ?? null;

/** Attach live premium/iv/delta to each leg from the chain. */
export function resolveLegs(legs: Leg[], chain: ChainRow[]): LegResolved[] {
  return legs.map((l) => {
    const o = near(chain, l.strike, l.type);
    return {
      ...l,
      premium: o?.ltp ?? null,
      iv: o?.iv ?? null,
      delta: o?.delta ?? null,
    };
  });
}

/** Position P&L (₹) if the underlying finishes at `S` on expiry day. */
function payoffAt(S: number, legs: LegResolved[], lotSize: number): number {
  let pnl = 0;
  for (const l of legs) {
    if (l.premium == null) continue;
    const intrinsic = l.type === "CE" ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0);
    const perUnit = l.side === "sell" ? l.premium - intrinsic : intrinsic - l.premium;
    pnl += perUnit * l.lots * lotSize;
  }
  return pnl;
}

export function analyzePosition(legs: Leg[], snap: Snapshot, exp: ExpiryBlock): PositionResult {
  const lotSize = snap.lotSize ?? 0;
  const resolved = resolveLegs(legs, exp.chain);
  const spot = snap.spot.price;
  const em = exp.metrics.expectedMove ?? spot * 0.02;
  const priced = resolved.filter((l) => l.premium != null && l.lots > 0);
  const valid = priced.length > 0 && lotSize > 0;

  const empty: PositionResult = {
    legs: resolved, lotSize, valid: false, netCredit: 0, maxProfit: null, maxLoss: null,
    breakevens: [], netDelta: 0, netTheta: 0, pop: null, expectedPnl: null,
    curve: [], curveToday: [], curveHalf: [],
    spot, expectedMove: em, callWall: exp.metrics.callWall, putWall: exp.metrics.putWall,
    assessment: { score: 0, grade: "Incomplete", bias: "neutral", pros: [], cons: [], suggestions: [] },
  };
  if (!valid) return empty;

  // Net credit/debit (₹): sold legs add premium, bought legs subtract.
  let netCredit = 0;
  for (const l of priced) netCredit += (l.side === "sell" ? 1 : -1) * (l.premium as number) * l.lots * lotSize;

  // Full-range scan for max P/L + breakevens + unlimited detection.
  const lo = 0, hi = spot * 2.5, N = 1500, dx = (hi - lo) / N;
  let maxP = -Infinity, minP = Infinity;
  const crossings: number[] = [];
  let prevS = lo, prevPnl = payoffAt(lo, priced, lotSize);
  for (let i = 1; i <= N; i++) {
    const s = lo + i * dx;
    const p = payoffAt(s, priced, lotSize);
    if (p > maxP) maxP = p;
    if (p < minP) minP = p;
    if ((prevPnl < 0 && p >= 0) || (prevPnl > 0 && p <= 0)) {
      // linear interpolate the zero crossing
      const f = prevPnl / (prevPnl - p);
      crossings.push(Math.round((prevS + f * (s - prevS)) * 100) / 100);
    }
    prevS = s; prevPnl = p;
  }
  // Unlimited detection from the far-edge slope.
  const slopeHi = payoffAt(hi, priced, lotSize) - payoffAt(hi - dx, priced, lotSize);
  const unlimitedProfit = slopeHi > 1;
  const unlimitedLoss = slopeHi < -1;
  const maxProfit = unlimitedProfit ? null : Math.round(maxP);
  const maxLoss = unlimitedLoss ? null : Math.round(minP);

  // Net greeks.
  let netDelta = 0, netTheta = 0;
  for (const l of priced) {
    const sgn = l.side === "buy" ? 1 : -1;
    if (l.delta != null) netDelta += sgn * l.delta * l.lots * lotSize;
    const th = l.iv != null ? bsTheta(spot, l.strike, exp.tYears, l.iv, l.type) : null;
    if (th != null) netTheta += sgn * th * l.lots * lotSize;
  }
  netDelta = Math.round(netDelta);
  netTheta = Math.round(netTheta);

  // Probability of profit + expected P&L via a lognormal terminal distribution
  // (vol = ATM IV, r≈0). Numeric integration.
  const atmIv = exp.metrics.atmIv ?? 0;
  let pop: number | null = null, expectedPnl: number | null = null;
  if (atmIv > 0 && exp.tYears > 0) {
    const sT = atmIv * Math.sqrt(exp.tYears);
    const mu = Math.log(spot) - 0.5 * sT * sT;
    const M = 1000, sLo = spot * 0.4, sHi = spot * 1.8, ds = (sHi - sLo) / M;
    let probMass = 0, winMass = 0, ev = 0;
    for (let i = 0; i < M; i++) {
      const s = sLo + (i + 0.5) * ds;
      const z = (Math.log(s) - mu) / sT;
      const pdf = normPdf(z) / (s * sT);
      const w = pdf * ds;
      probMass += w;
      const p = payoffAt(s, priced, lotSize);
      if (p > 0) winMass += w;
      ev += p * w;
    }
    if (probMass > 0) {
      pop = Math.max(0, Math.min(1, winMass / probMass));
      expectedPnl = Math.round(ev / probMass);
    }
  }

  // Focused curves for the chart: spot ± ~2.6σ, wide enough to show ±2SD and
  // the OI walls. Three time slices — at expiry (intrinsic), today (BS at full
  // t), and halfway to expiry — mirror a broker's payoff view.
  const span = Math.max(em * 2.6, spot * 0.04);
  const cLo = Math.max(0, spot - span), cHi = spot + span, CN = 140;
  const curve: { s: number; pnl: number }[] = [];
  const curveToday: { s: number; pnl: number }[] = [];
  const curveHalf: { s: number; pnl: number }[] = [];
  const canPrice = priced.every((l) => l.iv != null) && exp.tYears > 0;
  for (let i = 0; i <= CN; i++) {
    const s = cLo + ((cHi - cLo) * i) / CN;
    curve.push({ s, pnl: Math.round(payoffAt(s, priced, lotSize)) });
    if (canPrice) {
      const pt = pnlAtTime(s, priced, lotSize, exp.tYears);
      const ph = pnlAtTime(s, priced, lotSize, exp.tYears / 2);
      if (pt != null) curveToday.push({ s, pnl: Math.round(pt) });
      if (ph != null) curveHalf.push({ s, pnl: Math.round(ph) });
    }
  }

  const partial: PositionResult = {
    legs: resolved, lotSize, valid: true, netCredit: Math.round(netCredit),
    maxProfit, maxLoss, breakevens: crossings.slice(0, 4),
    netDelta, netTheta, pop, expectedPnl, curve, curveToday, curveHalf, spot, expectedMove: em,
    callWall: exp.metrics.callWall, putWall: exp.metrics.putWall,
    assessment: { score: 0, grade: "Incomplete", bias: "neutral", pros: [], cons: [], suggestions: [] },
  };
  partial.assessment = assessFit(partial, snap, exp);
  return partial;
}

const normalizeVerdict = (v: string): "bullish" | "bearish" | "neutral" =>
  v === "BULLISH" ? "bullish" : v === "BEARISH" ? "bearish" : "neutral";

/** Rule-based fit assessment: how well the position suits the current market. */
export function assessFit(r: PositionResult, snap: Snapshot, exp: ExpiryBlock): Assessment {
  const m = exp.metrics;
  const spot = r.spot;
  const pros: string[] = [], cons: string[] = [], suggestions: string[] = [];
  let score = 50;

  const bias: "bullish" | "bearish" | "neutral" =
    r.netDelta > r.lotSize * 0.2 ? "bullish" : r.netDelta < -r.lotSize * 0.2 ? "bearish" : "neutral";
  const shorts = r.legs.filter((l) => l.side === "sell" && l.premium != null);
  const isCreditSeller = r.netCredit > 0 && shorts.length > 0;
  const undefinedRisk = r.maxLoss == null;

  // 1) Directional alignment with the verdict.
  const vBias = normalizeVerdict(snap.verdict.verdict);
  if (bias === vBias && bias !== "neutral") { score += 14; pros.push(`Direction agrees with the ${snap.verdict.verdict} verdict (${snap.verdict.confidence * 100 | 0}% conf).`); }
  else if (bias !== "neutral" && vBias !== "neutral" && bias !== vBias) { score -= 16; cons.push(`Position is ${bias} but the engine reads ${snap.verdict.verdict} — you're leaning against the signal.`); }
  else if (bias === "neutral" && vBias === "neutral") { score += 10; pros.push("Neutral position matches a range-bound, no-conviction read."); }

  // 2) Market structure.
  if (snap.structure && snap.structure.label !== "Indecisive") {
    const sB = snap.structure.bias;
    if (bias === sB && bias !== "neutral") { score += 8; pros.push(`Aligned with the ${snap.structure.label.toLowerCase()} in the futures.`); }
    else if (bias !== "neutral" && sB !== "neutral" && bias !== sB) { score -= 8; cons.push(`Futures show a ${snap.structure.label.toLowerCase()} (${sB}) — headwind for a ${bias} position.`); }
  }

  // 3) IV richness (matters for sellers).
  if (isCreditSeller) {
    if (m.ivRank != null && m.ivRank >= 55) { score += 10; pros.push(`Selling into rich IV (rank ${m.ivRank}) — premiums are fat.`); }
    else if (m.ivRank != null && m.ivRank <= 30) { score -= 8; cons.push(`IV is low (rank ${m.ivRank}) — thin premium for the risk you're taking.`); }
    else if (m.atmIv != null && m.rv20 != null && m.atmIv > m.rv20 * 1.15) { score += 6; pros.push("IV sits above recent realized vol — the market may be over-paying you."); }
  }

  // 4) Short strikes vs the expected move + walls.
  for (const l of shorts) {
    const cushion = r.expectedMove > 0 ? Math.abs(l.strike - spot) / r.expectedMove : 0;
    const otm = l.type === "CE" ? l.strike > spot : l.strike < spot;
    if (!otm) { score -= 10; cons.push(`Short ${l.type} ${l.strike} is ITM/at-the-money — high assignment risk.`); continue; }
    if (cushion >= 1) { score += 6; pros.push(`Short ${l.type} ${l.strike} sits ${cushion.toFixed(1)}σ out — beyond the expected move.`); }
    else { score -= 6; cons.push(`Short ${l.type} ${l.strike} is only ${cushion.toFixed(1)}σ out — inside the expected move, likely to be tested.`); }
    // wall protection
    if (l.type === "PE" && m.putWall != null && l.strike <= m.putWall) { score += 5; pros.push(`Short put ${l.strike} sits under the ${m.putWall} put wall (OI support).`); }
    if (l.type === "CE" && m.callWall != null && l.strike >= m.callWall) { score += 5; pros.push(`Short call ${l.strike} sits above the ${m.callWall} call wall (OI resistance).`); }
  }

  // 5) Risk shape.
  if (undefinedRisk) { score -= 12; cons.push("Undefined risk — a sharp move can cause an outsized loss."); suggestions.push("Add a protective wing (buy a further-OTM option) to cap the loss and free up margin."); }
  else { score += 6; pros.push("Defined risk — your worst case is capped."); }

  // 6) POP.
  if (r.pop != null) {
    if (r.pop >= 0.7) { score += 8; pros.push(`High probability of profit (~${Math.round(r.pop * 100)}%).`); }
    else if (r.pop <= 0.4) { score -= 8; cons.push(`Low probability of profit (~${Math.round(r.pop * 100)}%) — you need the move to go your way.`); }
  }

  // 7) Reward/risk sanity for credit sellers.
  if (isCreditSeller && r.maxLoss != null && r.maxProfit != null && r.maxProfit > 0) {
    const rr = Math.abs(r.maxLoss) / r.maxProfit;
    if (rr > 4) { score -= 6; cons.push(`Risking ${rr.toFixed(1)}× the max reward — typical for premium selling, so size small and manage early.`); }
  }

  // Suggestions from the market context.
  if (isCreditSeller && bias !== "neutral" && vBias !== "neutral" && bias !== vBias) {
    suggestions.push(`Consider flipping to the ${vBias} side (sell ${vBias === "bullish" ? "puts below support" : "calls above resistance"}) to trade with the read.`);
  }
  if (m.maxPain != null) {
    suggestions.push(`Max pain is ${m.maxPain} — expiries often gravitate there; strikes straddling it tend to get pinned.`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade: Assessment["grade"] = score >= 66 ? "Good fit" : score >= 45 ? "Mixed" : "Poor fit";
  return { score, grade, bias, pros, cons, suggestions: suggestions.slice(0, 3) };
}
