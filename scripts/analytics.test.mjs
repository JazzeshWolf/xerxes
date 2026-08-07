import { describe, it, expect } from "vitest";
import * as A from "./analytics.mjs";

// Small synthetic NIFTY-ish chain around spot 25000, strikes 100 apart.
// Put wall at 24800, call wall at 25200, put writing dominant.
function fixtureChain() {
  const rows = [];
  const mk = (strike, type, ltp, iv, oi, prevOi, volume = 1000) => ({ strike, type, ltp, iv, oi, prevOi, volume, delta: null });
  for (const [k, ceOi, peOi] of [
    [24600, 20000, 60000],
    [24700, 25000, 80000],
    [24800, 30000, 200000],
    [24900, 40000, 90000],
    [25000, 70000, 70000],
    [25100, 90000, 40000],
    [25200, 160000, 30000],
    [25300, 80000, 20000],
    [25400, 60000, 10000],
  ]) {
    const dist = Math.abs(k - 25000);
    const cePrice = Math.max(5, 120 - dist * 0.4 + (k < 25000 ? 25000 - k : 0));
    const pePrice = Math.max(5, 120 - dist * 0.4 + (k > 25000 ? k - 25000 : 0));
    rows.push(mk(k, "CE", cePrice, 0.12 + dist / 25000 * 0.5, ceOi, ceOi - (k >= 25200 ? 5000 : 1000)));
    rows.push(mk(k, "PE", pePrice, 0.13 + dist / 25000 * 0.6, peOi, peOi - (k <= 24900 ? 12000 : 1000)));
  }
  return rows;
}

describe("black-scholes", () => {
  it("prices an ATM call/put symmetrically and solves IV back", () => {
    const F = 25000, K = 25000, t = 7 / 365, vol = 0.14;
    const ce = A.bsPrice(F, K, t, vol, "CE");
    const pe = A.bsPrice(F, K, t, vol, "PE");
    expect(ce).toBeGreaterThan(0);
    expect(Math.abs(ce - pe)).toBeLessThan(1e-6); // r=0 put-call parity ATM
    const iv = A.impliedVol(ce, F, K, t, "CE");
    expect(Math.abs(iv - vol)).toBeLessThan(0.002);
  });
  it("delta is ~0.5 ATM and decays OTM", () => {
    const t = 7 / 365;
    expect(A.bsDelta(25000, 25000, t, 0.14, "CE")).toBeCloseTo(0.5, 1);
    expect(Math.abs(A.bsDelta(25000, 25800, t, 0.14, "CE"))).toBeLessThan(0.1);
    expect(A.bsDelta(25000, 24200, t, 0.14, "PE")).toBeGreaterThan(-0.1);
  });
  it("probTouch ≈ 2×OTM prob and clamps to [0,1]", () => {
    const p = A.probTouch(25000, 25500, 7 / 365, 0.14);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(A.probTouch(25000, 25000.0001, 7 / 365, 0.14)).toBeCloseTo(1, 1);
  });
});

describe("chain aggregates", () => {
  const chain = fixtureChain();
  it("computes PCR from OI", () => {
    const p = A.pcr(chain);
    expect(p.totalPutOi).toBeGreaterThan(p.totalCallOi); // fixture is put-heavy
    expect(p.oi).toBeGreaterThan(1);
  });
  it("finds max pain inside the strike range", () => {
    const mp = A.maxPain(chain);
    expect(mp).toBeGreaterThanOrEqual(24600);
    expect(mp).toBeLessThanOrEqual(25400);
  });
  it("finds the OI walls", () => {
    const w = A.walls(chain, 25000);
    expect(w.callWall).toBe(25200);
    expect(w.putWall).toBe(24800);
    expect(w.supports[0].strike).toBe(24800);
    expect(w.resistances[0].strike).toBe(25200);
  });
  it("computes day OI flow per side", () => {
    const f = A.oiFlow(chain);
    expect(f.putOiChg).toBeGreaterThan(f.callOiChg); // fixture: heavy put writing
  });
  it("ATM strike, IV and straddle", () => {
    expect(A.atmStrike(chain, 25010)).toBe(25000);
    const iv = A.atmIv(chain, 25000, 7 / 365);
    expect(iv).toBeGreaterThan(0.1);
    const st = A.straddlePrice(chain, 25000);
    expect(st).toBeGreaterThan(0);
  });
  it("skew: fixture puts are bid over calls", () => {
    const s = A.ivSkew(fixtureChain(), 25000);
    expect(s).toBeGreaterThan(0);
  });
  it("GEX returns a regime with sane pin strike", () => {
    const g = A.computeGex(chain, 25000, 7 / 365);
    expect(g).not.toBeNull();
    expect(["pinning", "balanced", "volatile"]).toContain(g.regime);
    expect(g.pinStrike).toBeGreaterThanOrEqual(24600);
    expect(g.pinStrike).toBeLessThanOrEqual(25400);
  });
});

describe("labelExpiries", () => {
  it("tags the last expiry of each month as monthly, others weekly", () => {
    const l = A.labelExpiries(["2026-07-21", "2026-07-28", "2026-08-04", "2026-08-25"]);
    expect(l["2026-07-21"]).toBe("weekly");
    expect(l["2026-07-28"]).toBe("monthly"); // last in July
    expect(l["2026-08-04"]).toBe("weekly");
    expect(l["2026-08-25"]).toBe("monthly"); // last in August
  });
  it("monthly-only lists (BANKNIFTY) tag every expiry monthly", () => {
    const l = A.labelExpiries(["2026-07-28", "2026-08-25", "2026-09-29"]);
    expect(Object.values(l).every((v) => v === "monthly")).toBe(true);
  });
});

describe("futuresStructure", () => {
  it("price up + OI up = long buildup (bullish, strong)", () => {
    const s = A.futuresStructure(0.008, 0.03);
    expect(s.label).toBe("Long buildup");
    expect(s.bias).toBe("bullish");
    expect(s.strength).toBe("strong");
    expect(s.howToTrade).toMatch(/put/i);
  });
  it("price down + OI up = short buildup (bearish, strong)", () => {
    const s = A.futuresStructure(-0.008, 0.03);
    expect(s.label).toBe("Short buildup");
    expect(s.bias).toBe("bearish");
    expect(s.howToTrade).toMatch(/call/i);
  });
  it("price up + OI down = short covering (bullish, weak)", () => {
    const s = A.futuresStructure(0.008, -0.03);
    expect(s.label).toBe("Short covering");
    expect(s.bias).toBe("bullish");
    expect(s.strength).toBe("weak");
  });
  it("price down + OI down = long unwinding (bearish, weak)", () => {
    const s = A.futuresStructure(-0.008, -0.03);
    expect(s.label).toBe("Long unwinding");
    expect(s.bias).toBe("bearish");
    expect(s.strength).toBe("weak");
  });
  it("tiny moves are Indecisive (neutral)", () => {
    expect(A.futuresStructure(0.0002, 0.03).label).toBe("Indecisive");
    expect(A.futuresStructure(0.008, 0.001).label).toBe("Indecisive");
    expect(A.futuresStructure(0.008, 0.001).bias).toBe("neutral");
  });
  it("null / non-finite inputs return null", () => {
    expect(A.futuresStructure(null, 0.03)).toBeNull();
    expect(A.futuresStructure(0.01, null)).toBeNull();
    expect(A.futuresStructure(NaN, 0.03)).toBeNull();
  });
});

describe("stats", () => {
  it("ema and pctChange behave", () => {
    const xs = Array.from({ length: 60 }, (_, i) => 100 + i);
    expect(A.ema(xs, 20)).toBeGreaterThan(140);
    expect(A.pctChange(xs, 5)).toBeCloseTo(5 / 154, 3);
  });
  it("rangeRank + percentile", () => {
    expect(A.rangeRank(15, [10, 20])).toBe(50);
    expect(A.percentile(15, [10, 12, 14, 16, 18])).toBe(60);
  });
});

describe("direction engine", () => {
  const chain = fixtureChain();
  const base = {
    closes: Array.from({ length: 60 }, (_, i) => 24000 + i * 18), // steady uptrend
    vixHistory: [14, 13.8, 13.5, 13.2, 13.0, 12.8],
    pcrOi: 1.35,
    maxPainStrike: 25100,
    spot: 25000,
    expectedMove: 250,
    flow: A.oiFlow(chain),
    skew: -0.01,
    basisPts: 40,
  };
  it("bullish inputs give a bullish verdict with decent confidence", () => {
    const v = A.directionScore(base);
    expect(v.verdict).toBe("BULLISH");
    expect(v.score).toBeGreaterThan(3);
    expect(v.confidence).toBeGreaterThan(0.5);
    expect(v.structure).toMatch(/put/i);
  });
  it("bearish inputs flip the verdict", () => {
    const v = A.directionScore({
      ...base,
      closes: Array.from({ length: 60 }, (_, i) => 26000 - i * 20),
      vixHistory: [12, 12.5, 13.2, 14.0, 15.1, 16.4],
      pcrOi: 0.6,
      maxPainStrike: 24800,
      flow: { callOiChg: 900000, putOiChg: -300000 },
      skew: 0.05,
      basisPts: -60,
    });
    expect(v.verdict).toBe("BEARISH");
    expect(v.structure).toMatch(/call/i);
  });
  it("missing factors redistribute weight instead of zeroing", () => {
    const v = A.directionScore({ closes: base.closes, spot: 25000 });
    const present = v.factors.filter((f) => f.present);
    expect(present.length).toBeGreaterThan(0);
    const wSum = present.reduce((a, f) => a + f.weight, 0);
    expect(wSum).toBeGreaterThan(0.99);
  });
  it("no inputs -> NO DATA, no trade", () => {
    const v = A.directionScore({});
    expect(v.verdict).toBe("NO DATA");
    expect(v.confidence).toBe(0);
  });
});

describe("sell candidates", () => {
  it("returns only OTM strikes with small delta and ranks puts first", () => {
    const chain = fixtureChain();
    const rows = A.sellCandidates(chain, 25000, 7 / 365, 250, { maxDelta: 0.35, minPremium: 1 });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.type === "PE" ? r.strike < 25000 : r.strike > 25000).toBe(true);
      expect(Math.abs(r.delta)).toBeLessThanOrEqual(0.35);
      expect(r.probProfit).toBeGreaterThan(0.5);
    }
    const firstCe = rows.findIndex((r) => r.type === "CE");
    const lastPe = rows.map((r) => r.type).lastIndexOf("PE");
    if (firstCe !== -1 && lastPe !== -1) expect(lastPe).toBeLessThan(firstCe);
  });
});

describe("liquidity", () => {
  it("scores a live chain positively and an empty chain as 0", () => {
    const chain = fixtureChain();
    expect(A.liquidityScore(chain, 50, 5e9)).toBeGreaterThan(0);
    expect(A.liquidityScore([], 50, 5e9)).toBe(0);
    expect(A.liquidityScore(null, 50)).toBe(0);
  });
  it("a richer chain scores higher than a thin one", () => {
    const thin = [{ strike: 100, type: "CE", ltp: 2, iv: 0.3, oi: 100, prevOi: 100, volume: 10 }];
    const rich = [{ strike: 100, type: "CE", ltp: 20, iv: 0.3, oi: 1e6, prevOi: 1e6, volume: 5e5 }];
    expect(A.liquidityScore(rich, 50, 1e10)).toBeGreaterThan(A.liquidityScore(thin, 50, 1e6));
  });
  it("buckets percentile ranks, and 0-score is always None", () => {
    expect(A.liquidityBucket(0.9, 5)).toBe("High");
    expect(A.liquidityBucket(0.7, 5)).toBe("Medium-High");
    expect(A.liquidityBucket(0.5, 5)).toBe("Medium");
    expect(A.liquidityBucket(0.3, 5)).toBe("Medium-Low");
    expect(A.liquidityBucket(0.05, 5)).toBe("Low");
    expect(A.liquidityBucket(0.99, 0)).toBe("None");
    expect(A.liquidityBucket(null, 5)).toBe("None");
  });
});

// ---------------------------------------------------------------------------
// Predictive layer (stock premium-selling candidates)
// ---------------------------------------------------------------------------

/**
 * Deterministic OHLC series with a KNOWN daily vol, split between an overnight
 * gap and an intraday drift. `gapFrac` = share of each day's move that arrives
 * as a gap, so the same total vol can be made gap-heavy or gap-light.
 */
function fixtureOhlc(n, dailyVol = 0.012, gapFrac = 0.3, seed = 7) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5; // ~U(-0.5, 0.5), sd ≈ 0.2887
  };
  const bars = [];
  let c = 1000;
  for (let i = 0; i < n; i++) {
    const o = c * Math.exp(rnd() * dailyVol * gapFrac * 3.46);
    const nc = o * Math.exp(rnd() * dailyVol * (1 - gapFrac) * 3.46);
    const h = Math.max(o, nc) * (1 + Math.abs(rnd()) * dailyVol);
    const l = Math.min(o, nc) * (1 - Math.abs(rnd()) * dailyVol);
    bars.push({ t: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, o, h, l, c: nc, v: 1e6 });
    c = nc;
  }
  return bars;
}

describe("yangZhangVol", () => {
  it("recovers a plausible annualized vol and scales with the input vol", () => {
    const calm = A.yangZhangVol(fixtureOhlc(200, 0.008), 60);
    const wild = A.yangZhangVol(fixtureOhlc(200, 0.024), 60);
    expect(calm).toBeGreaterThan(0);
    expect(wild).toBeGreaterThan(calm * 2); // 3× the daily vol → clearly higher
    // A 0.8%/day series annualizes to roughly 13% — allow a wide band.
    expect(calm).toBeGreaterThan(0.05);
    expect(calm).toBeLessThan(0.30);
  });
  it("needs n+1 bars and tolerates a corrupt bar without nulling the series", () => {
    expect(A.yangZhangVol(fixtureOhlc(10), 20)).toBeNull();
    expect(A.yangZhangVol([], 20)).toBeNull();
    expect(A.yangZhangVol(null, 20)).toBeNull();
    const withJunk = fixtureOhlc(120);
    withJunk[40] = { t: "x", o: 0, h: 0, l: 0, c: 0 };
    expect(A.yangZhangVol(withJunk, 60)).toBeGreaterThan(0);
  });
});

describe("gapProfile", () => {
  it("separates gap-dominated from intraday-dominated series", () => {
    const gappy = A.gapProfile(fixtureOhlc(120, 0.012, 0.85), 60);
    const smooth = A.gapProfile(fixtureOhlc(120, 0.012, 0.1), 60);
    expect(gappy.gapShare).toBeGreaterThan(smooth.gapShare);
    expect(gappy.gapShare).toBeGreaterThan(0.5);
    expect(smooth.gapShare).toBeLessThan(0.3);
    expect(gappy.maxAbsMove).toBeGreaterThan(0);
  });
  it("returns null when there aren't enough bars", () => {
    expect(A.gapProfile(fixtureOhlc(5), 60)).toBeNull();
  });
});

describe("forecastVol", () => {
  const bars = fixtureOhlc(200, 0.012, 0.2);
  it("pulls toward the slow estimate as the horizon lengthens", () => {
    const near = A.forecastVol(bars, 7);
    const far = A.forecastVol(bars, 60);
    const slow = near.rv120;
    // Longer horizon must sit closer to the 120-day anchor than the short one.
    expect(Math.abs(far.sigma - slow)).toBeLessThanOrEqual(Math.abs(near.sigma - slow) + 1e-9);
  });
  it("inflates the forecast for gap-dominated names", () => {
    const smooth = A.forecastVol(fixtureOhlc(200, 0.012, 0.1), 30);
    const gappy = A.forecastVol(fixtureOhlc(200, 0.012, 0.9), 30);
    expect(gappy.gapShare).toBeGreaterThan(smooth.gapShare);
    expect(gappy.sigma).toBeGreaterThan(smooth.sigma);
  });
  it("returns null without usable history", () => {
    expect(A.forecastVol([], 30)).toBeNull();
    expect(A.forecastVol(fixtureOhlc(5), 30)).toBeNull();
  });
});

describe("option-implied signals", () => {
  it("termStructure names backwardation and contango", () => {
    expect(A.termStructure(0.34, 0.28, 20, 50).regime).toBe("backwardation");
    expect(A.termStructure(0.28, 0.34, 20, 50).regime).toBe("contango");
    expect(A.termStructure(0.3, 0.3, 20, 50).regime).toBe("flat");
    expect(A.termStructure(0.34, 0.28, 20, 50).slopePts).toBeCloseTo(6, 5);
    expect(A.termStructure(null, 0.3, 20, 50)).toBeNull();
    // Far expiry must actually be further out.
    expect(A.termStructure(0.34, 0.28, 50, 20)).toBeNull();
  });
  it("cpIvSpread is positive when ATM calls are bid over puts", () => {
    const chain = [
      { strike: 1000, type: "CE", ltp: 30, iv: 0.32, oi: 100, volume: 10 },
      { strike: 1000, type: "PE", ltp: 28, iv: 0.28, oi: 100, volume: 10 },
    ];
    expect(A.cpIvSpread(chain, 1000)).toBeCloseTo(4, 5);
    expect(A.cpIvSpread([], 1000)).toBeNull();
  });
  it("putSmirk measures OTM put IV over ATM IV", () => {
    const chain = [
      { strike: 1000, type: "CE", ltp: 30, iv: 0.3, oi: 100, volume: 10 },
      { strike: 1000, type: "PE", ltp: 30, iv: 0.3, oi: 100, volume: 10 },
      { strike: 900, type: "PE", ltp: 5, iv: 0.42, oi: 100, volume: 10 },
    ];
    expect(A.putSmirk(chain, 1000)).toBeCloseTo(12, 5);
    // No strike near the -10% target → no reading rather than a wrong one.
    expect(A.putSmirk(chain.filter((o) => o.strike !== 900), 1000)).toBeNull();
  });
});

describe("real-world probability and edge", () => {
  const S = 1000, K = 1100, T = 30 / 365, sigma = 0.25;
  it("at zero drift, P(call expires OTM) equals 1 − N(d2)", () => {
    const sT = sigma * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (sigma * sigma / 2) * T) / sT;
    const d2 = d1 - sT;
    expect(A.pMeasureProb(S, K, T, sigma, 0, "CE")).toBeCloseTo(1 - A.normCdf(d2), 6);
  });
  it("call and put probabilities at the same strike are complementary", () => {
    const ce = A.pMeasureProb(S, K, T, sigma, 0.05, "CE");
    const pe = A.pMeasureProb(S, K, T, sigma, 0.05, "PE");
    expect(ce + pe).toBeCloseTo(1, 6);
  });
  it("positive drift makes a short call less safe and a short put safer", () => {
    expect(A.pMeasureProb(S, K, T, sigma, 0.4, "CE")).toBeLessThan(A.pMeasureProb(S, K, T, sigma, -0.4, "CE"));
    expect(A.pMeasureProb(S, 900, T, sigma, 0.4, "PE")).toBeGreaterThan(A.pMeasureProb(S, 900, T, sigma, -0.4, "PE"));
  });
  it("driftFromVerdict is capped and scales with confidence", () => {
    expect(A.driftFromVerdict({ score: 10, confidence: 1 })).toBeCloseTo(0.1, 6);
    expect(A.driftFromVerdict({ score: -10, confidence: 1 })).toBeCloseTo(-0.1, 6);
    expect(A.driftFromVerdict({ score: 10, confidence: 0.5 })).toBeCloseTo(0.05, 6);
    expect(A.driftFromVerdict({ score: 50, confidence: 1 })).toBeCloseTo(0.1, 6); // clamped
    expect(A.driftFromVerdict(null)).toBe(0);
  });
  it("edge is positive when IV exceeds the forecast and negative when it doesn't", () => {
    const rich = A.bsPrice(S, K, T, 0.36, "CE"); // market charging 36 vol
    const cheap = A.bsPrice(S, K, T, 0.18, "CE"); // market charging 18 vol
    expect(A.candidateEdge(rich, S, K, T, 0.25, 0, "CE").edge).toBeGreaterThan(0);
    expect(A.candidateEdge(cheap, S, K, T, 0.25, 0, "CE").edge).toBeLessThan(0);
    // Selling at exactly the forecast vol is a zero-edge trade.
    const fairPx = A.bsPrice(S, K, T, 0.25, "CE");
    expect(A.candidateEdge(fairPx, S, K, T, 0.25, 0, "CE").edge).toBeCloseTo(0, 2);
  });
  it("edgePct normalizes across price levels — same vol edge, same score", () => {
    const cheapStock = A.candidateEdge(A.bsPrice(200, 220, T, 0.36, "CE"), 200, 220, T, 0.25, 0, "CE");
    const dearStock = A.candidateEdge(A.bsPrice(4000, 4400, T, 0.36, "CE"), 4000, 4400, T, 0.25, 0, "CE");
    expect(dearStock.edge).toBeGreaterThan(cheapStock.edge * 10); // raw rupees are wildly different
    expect(dearStock.edgePct).toBeCloseTo(cheapStock.edgePct, 3); // normalized, they agree
  });
});

describe("sellConviction", () => {
  const base = {
    type: "CE", strike: 1100, ltp: 10.4, iv: 0.36, oi: 600000, volume: 80000, lotSize: 500,
    spot: 1000, t: 30 / 365, sigmaForecast: 0.25, mu: 0,
    verdict: { score: 0, confidence: 0.6, verdict: "NEUTRAL" },
    ivRank: null, gap: null, term: null, smirk: null,
  };

  it("scores an option priced above the forecast higher than one priced below", () => {
    const rich = A.sellConviction({ ...base, ltp: A.bsPrice(1000, 1100, base.t, 0.36, "CE"), iv: 0.36 });
    const cheap = A.sellConviction({ ...base, ltp: A.bsPrice(1000, 1100, base.t, 0.18, "CE"), iv: 0.18 });
    expect(rich.conviction).toBeGreaterThan(cheap.conviction);
    expect(rich.band).toBe("HIGH");
    expect(cheap.band).toBe("LOW");
  });

  it("redistributes weight when IV rank is missing rather than zeroing it", () => {
    const without = A.sellConviction(base);
    const ivFactor = without.factors.find((f) => f.key === "ivRank");
    expect(ivFactor.present).toBe(false);
    expect(ivFactor.weight).toBe(0);
    // Present weights still sum to 1 — the missing factor's share was shared out.
    const total = without.factors.reduce((a, f) => a + f.weight, 0);
    expect(total).toBeCloseTo(1, 6);
    const with60 = A.sellConviction({ ...base, ivRank: 60 });
    expect(with60.factors.find((f) => f.key === "ivRank").present).toBe(true);
    expect(with60.factors.reduce((a, f) => a + f.weight, 0)).toBeCloseTo(1, 6);
  });

  it("the gap-risk haircut is monotonically decreasing in gapShare", () => {
    const at = (gapShare) => A.sellConviction({ ...base, gap: { gapShare, maxAbsMove: 0.01 } }).conviction;
    const scores = [0.2, 0.4, 0.6, 0.8].map(at);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    expect(scores.at(-1)).toBeLessThan(scores[0]);
    expect(A.sellConviction({ ...base, gap: { gapShare: 0.8, maxAbsMove: 0.01 } }).notes.length).toBeGreaterThan(0);
  });

  it("penalizes selling into the wrong side of a confident direction read", () => {
    const bullish = { score: 8, confidence: 0.9, verdict: "BULLISH" };
    const shortCall = A.sellConviction({ ...base, type: "CE", verdict: bullish });
    const shortPut = A.sellConviction({ ...base, type: "PE", strike: 900, verdict: bullish });
    expect(shortCall.factors.find((f) => f.key === "direction").s)
      .toBeLessThan(shortPut.factors.find((f) => f.key === "direction").s);
  });

  it("backwardation tilts conviction down, contango slightly up", () => {
    const back = A.sellConviction({ ...base, term: { slopePts: 6, regime: "backwardation" } });
    const flat = A.sellConviction({ ...base, term: { slopePts: 0, regime: "flat" } });
    const cont = A.sellConviction({ ...base, term: { slopePts: -6, regime: "contango" } });
    expect(back.conviction).toBeLessThan(flat.conviction);
    expect(cont.conviction).toBeGreaterThanOrEqual(flat.conviction);
  });

  it("a steep put smirk penalizes short puts but not short calls", () => {
    const pe = (smirk) => A.sellConviction({ ...base, type: "PE", strike: 900, smirk }).conviction;
    const ce = (smirk) => A.sellConviction({ ...base, type: "CE", smirk }).conviction;
    expect(pe(12)).toBeLessThan(pe(0));
    expect(ce(12)).toBe(ce(0));
  });

  it("flags delivery risk only when the strike may actually finish ITM", () => {
    const near = A.sellConviction({ ...base, strike: 1010, ltp: 30 });
    const far = A.sellConviction({ ...base, strike: 1300, ltp: 1.5 });
    expect(near.deliveryRisk).toBe(true);
    expect(far.deliveryRisk).toBe(false);
  });

  it("returns null on unusable inputs instead of a fabricated score", () => {
    expect(A.sellConviction(null)).toBeNull();
    expect(A.sellConviction({ ...base, spot: 0 })).toBeNull();
    expect(A.sellConviction({ ...base, ltp: 0 })).toBeNull();
    expect(A.sellConviction({ ...base, t: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Empirical tail model (filtered historical simulation)
//
// These exist because live data caught the lognormal claiming a +27%-OTM call
// was worth ₹0.14 when the market paid ₹3.95 — which pushed far-OTM lottery
// tickets to the top of the candidate list.
// ---------------------------------------------------------------------------

/** Returns with volatility CLUSTERING — shocks persist, as they do in reality. */
function clusteredReturns(n, seed = 991) {
  let s = seed;
  const r = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  const out = [];
  let vol = 0.012;
  for (let i = 0; i < n; i++) {
    vol = 0.94 * vol + 0.06 * 0.012 + (Math.abs(r()) > 0.45 ? 0.02 : 0);
    out.push(r() * 3.46 * vol);
  }
  return out;
}

describe("dailyLogReturns", () => {
  it("returns n-1 log returns and skips corrupt bars", () => {
    const bars = fixtureOhlc(50);
    expect(A.dailyLogReturns(bars)).toHaveLength(49);
    expect(A.dailyLogReturns([])).toEqual([]);
    expect(A.dailyLogReturns(null)).toEqual([]);
  });
});

describe("terminalSample", () => {
  const rets = clusteredReturns(200);

  it("is deterministic for a given seed and sorted ascending", () => {
    const a = A.terminalSample(rets, 37, 0.25);
    const b = A.terminalSample(rets, 37, 0.25);
    expect(Array.from(a)).toEqual(Array.from(b));
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeGreaterThanOrEqual(a[i - 1]);
  });

  it("scales to the requested annual vol", () => {
    const days = 37, sigma = 0.25;
    const s = A.terminalSample(rets, days, sigma);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
    expect(sd).toBeCloseTo(sigma * Math.sqrt(days / 252), 1);
  });

  const sd = (a) => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
  };

  it("block resampling widens terminal dispersion versus i.i.d.", () => {
    // What blocks actually buy: contiguous high-vol runs compound, so terminal
    // spread grows with block length. This is the conservative direction for a
    // seller and is the real reason to prefer it over an i.i.d. bootstrap.
    const days = 37, sigma = 0.25;
    const iid = sd(A.terminalSample(rets, days, sigma, { blockOverride: 1 }));
    const short = sd(A.terminalSample(rets, days, sigma, { blockOverride: 6 }));
    const long = sd(A.terminalSample(rets, days, sigma, { blockOverride: 18 }));
    expect(short).toBeGreaterThan(iid);
    expect(long).toBeGreaterThan(short);
  });

  it("does NOT claim excess kurtosis at a multi-week horizon", () => {
    // Documents a limit rather than a feature. Summing ~37 draws, the central
    // limit theorem flattens the daily fat tail back toward normal at every
    // block length — so nothing downstream should lean on tail shape here.
    const kurt = (a) => {
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      const s = sd(a);
      return a.reduce((x, y) => x + ((y - m) / s) ** 4, 0) / a.length;
    };
    for (const b of [1, 6, 18, 37]) {
      expect(kurt(A.terminalSample(rets, 37, 0.25, { blockOverride: b }))).toBeLessThan(3.6);
    }
  });

  it("refuses to guess from too little history", () => {
    expect(A.terminalSample(rets.slice(0, 20), 37, 0.25)).toBeNull();
    expect(A.terminalSample(rets, 37, 0)).toBeNull();
    expect(A.terminalSample(null, 37, 0.25)).toBeNull();
  });
});

describe("riskMetrics", () => {
  const S = 1000, T = 53 / 365, sigma = 0.25;
  const sample = A.terminalSample(clusteredReturns(200), A.tradingDaysTo(53), sigma);

  it("agrees with simulatedValue on fair value and P(OTM)", () => {
    const sim = A.simulatedValue(sample, S, 900, T, sigma, 0, "PE");
    const rm = A.riskMetrics(sample, S, 900, T, sigma, 0, "PE", 5);
    expect(rm.fair).toBeCloseTo(sim.fair, 6);
    expect(rm.pOtm).toBeCloseTo(sim.pOtm, 6);
  });

  it("expected P&L equals credit minus fair value", () => {
    const rm = A.riskMetrics(sample, S, 900, T, sigma, 0, "PE", 5);
    expect(rm.expected).toBeCloseTo(5 - rm.fair, 6);
  });

  it("the tail loses more for a near strike than a far one, on both sides", () => {
    const nearPut = A.riskMetrics(sample, S, 980, T, sigma, 0, "PE", 20);
    const farPut = A.riskMetrics(sample, S, 800, T, sigma, 0, "PE", 2);
    expect(nearPut.cvar).toBeLessThan(farPut.cvar);
    expect(nearPut.worst).toBeLessThan(farPut.worst);
    const nearCall = A.riskMetrics(sample, S, 1020, T, sigma, 0, "CE", 20);
    const farCall = A.riskMetrics(sample, S, 1200, T, sigma, 0, "CE", 2);
    expect(nearCall.cvar).toBeLessThan(farCall.cvar);
  });

  it("returns null without a credit or a usable sample", () => {
    expect(A.riskMetrics(sample, S, 900, T, sigma, 0, "PE", 0)).toBeNull();
    expect(A.riskMetrics(null, S, 900, T, sigma, 0, "PE", 5)).toBeNull();
  });
});

describe("forecastVol conservatism floor", () => {
  it("never forecasts far below the name's own long-run realized vol", () => {
    // A stretch of calm at the end of a volatile history: the naive blend would
    // extrapolate the quiet window, which is the dangerous direction for a seller.
    const calmTail = [...fixtureOhlc(140, 0.03, 0.3, 5), ...fixtureOhlc(60, 0.004, 0.3, 9)];
    const f = A.forecastVol(calmTail, 53);
    expect(f.sigma).toBeGreaterThanOrEqual(0.85 * f.rv120 - 1e-9);
  });
});

describe("sellConviction with an empirical sample", () => {
  const S = 1097.2, T = 53 / 365, sigma = 0.2269;
  const sample = A.terminalSample(clusteredReturns(200), A.tradingDaysTo(53), sigma);
  const verdict = { score: 1.0, confidence: 0.6, verdict: "NEUTRAL" };
  const at = (K, ltp) =>
    A.sellConviction({
      type: "PE", strike: K, ltp, iv: 0.26, oi: 600000, volume: 60000, lotSize: 500,
      spot: S, t: T, sigmaForecast: sigma, mu: A.driftFromVerdict(verdict), verdict,
      ivRank: null, gap: { gapShare: 0.21, maxAbsMove: 0.05 }, term: null, smirk: null, sample,
    });

  it("ranks the strike ladder with an interior maximum, not monotonically outward", () => {
    // The production bug: far-OTM strikes swept the top because edge, cushion
    // and survival all saturated at once. A sane ladder peaks in the middle.
    const ladder = [[1040, 18], [1000, 11], [960, 7], [910, 4.7], [860, 3.0], [800, 1.8]].map(([k, p]) => at(k, p).conviction);
    const peak = ladder.indexOf(Math.max(...ladder));
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(ladder.length - 1);
    // Both extremes must lose to the peak.
    expect(ladder[0]).toBeLessThan(ladder[peak]);
    expect(ladder.at(-1)).toBeLessThan(ladder[peak]);
  });

  it("flags a strike whose premium is almost entirely tail compensation", () => {
    const far = at(800, 1.8);
    expect(far.tailReliance).toBeGreaterThan(0.9);
    expect(far.notes.some((n) => n.includes("tail-risk"))).toBe(true);
    expect(far.band).toBe("LOW");
    const sane = at(960, 7);
    expect(sane.tailReliance).toBeLessThan(0.7);
    expect(sane.notes.some((n) => n.includes("tail-risk"))).toBe(false);
  });

  it("marks results as empirical and carries the tail numbers through", () => {
    const c = at(960, 7);
    expect(c.empirical).toBe(true);
    expect(c.cvar).toBeLessThan(0);
    expect(c.worst).toBeLessThan(c.cvar);
    expect(A.sellConviction({ ...{ type: "PE", strike: 960, ltp: 7, iv: 0.26, oi: 1, volume: 1, lotSize: 1, spot: S, t: T, sigmaForecast: sigma } }).empirical).toBe(false);
  });
});
