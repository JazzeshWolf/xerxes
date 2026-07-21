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
