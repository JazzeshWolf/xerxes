import { describe, it, expect } from "vitest";
import {
  coneFor,
  coneFromPaths,
  decileGroups,
  edges,
  leanTone,
  parseIndex,
  parseSkill,
  quantile,
  sectorCounts,
  skillState,
  type RankerRow,
} from "./ranker";

const row = (over: Partial<RankerRow> = {}): RankerRow => ({
  symbol: "RELIANCE",
  name: "Reliance Industries",
  sector: "Energy & Oil",
  rank: 1,
  decile: 10,
  percentile: 0.99,
  score: 0.05,
  rawForecast: 0.04,
  forecastReturn: 0.04,
  lastClose: 1400,
  beta: 1.1,
  quantiles: { q05: -0.07, q50: 0.04, q95: 0.2 },
  lean: "bullish",
  implication: "Lean bullish — prefer selling puts",
  ...over,
});

/** A payload with `n` synthetic rows, ranked 1..n across 10 deciles. */
const payload = (n = 100, over: Record<string, unknown> = {}) => ({
  asOf: "2026-08-11T10:30:00.000Z",
  tradeDate: "2026-08-11",
  engine: "kronos",
  model: "NeoQuasar/Kronos-small",
  predLen: 21,
  horizonLabel: "21 trading days",
  universeCount: n,
  rows: Array.from({ length: n }, (_, i) => ({
    ...row(),
    symbol: `SYM${i}`,
    rank: i + 1,
    decile: 10 - Math.floor((i / n) * 10),
    percentile: 1 - i / (n - 1),
    forecastReturn: 0.1 - i * 0.002,
    lean: i < n * 0.2 ? "bullish" : i >= n * 0.8 ? "bearish" : "neutral",
  })),
  ...over,
});

describe("parseIndex — the explicit failure path", () => {
  it("parses a well-formed payload", () => {
    const idx = parseIndex(payload());
    expect(idx).not.toBeNull();
    expect(idx!.rows).toHaveLength(100);
    expect(idx!.engine).toBe("kronos");
  });

  it("returns null rather than rendering junk", () => {
    // Each of these would otherwise produce a confident-looking, wrong table.
    expect(parseIndex(null)).toBeNull();
    expect(parseIndex(undefined)).toBeNull();
    expect(parseIndex("not json")).toBeNull();
    expect(parseIndex({})).toBeNull();
    expect(parseIndex({ rows: "nope" })).toBeNull();
    expect(parseIndex({ rows: [] })).toBeNull();
  });

  it("rejects a cross-section too small to be a ranking", () => {
    // Breadth is the edge; 19 names is a broken payload, not a small universe.
    expect(parseIndex(payload(19))).toBeNull();
    expect(parseIndex(payload(20))).not.toBeNull();
  });

  it("drops individually malformed rows but keeps the payload", () => {
    const p = payload(40);
    (p.rows as unknown[])[0] = { symbol: "BAD" }; // no rank/decile/forecast
    (p.rows as unknown[])[1] = null;
    const idx = parseIndex(p);
    expect(idx!.rows).toHaveLength(38);
    expect(idx!.rows.some((r) => r.symbol === "BAD")).toBe(false);
  });

  it("always returns rows sorted by rank", () => {
    const p = payload(30);
    p.rows.reverse();
    const idx = parseIndex(p);
    expect(idx!.rows.map((r) => r.rank)).toEqual([...idx!.rows.map((r) => r.rank)].sort((a, b) => a - b));
  });

  it("tolerates missing optional fields", () => {
    const p = payload(25);
    for (const r of p.rows as Record<string, unknown>[]) {
      delete r.quantiles;
      delete r.sector;
      delete r.beta;
    }
    const idx = parseIndex(p);
    expect(idx!.rows[0].sector).toBe("—");
    expect(idx!.rows[0].quantiles).toEqual({});
  });
});

describe("skillState — the page must never outrun its numbers", () => {
  it("treats a missing skill report as unmeasured, not as fine", () => {
    const s = skillState(parseIndex(payload()));
    expect(s.level).toBe("unmeasured");
    expect(s.actionable).toBe(false);
  });

  it("distinguishes 'not measured' from 'measured and failed'", () => {
    const failed = skillState(
      parseIndex(payload(100, {
        skill: { validated: false, icir: 0.1, bar: 0.3, reasons: ["ICIR 0.10 is below the 0.30 bar"], summary: "UNVALIDATED -- ICIR 0.10 is below the 0.30 bar" },
      })),
    );
    expect(failed.level).toBe("failed");
    expect(failed.actionable).toBe(false);
    // The distinction matters: a never-tested model must not borrow the
    // credibility of a tested one.
    expect(failed.level).not.toBe(skillState(parseIndex(payload())).level);
  });

  it("only marks ranks actionable when the verdict says validated", () => {
    const ok = skillState(
      parseIndex(payload(100, {
        skill: { validated: true, icir: 0.62, momentumIcir: 0.30, edgeOverMomentum: 0.32, bar: 0.3, reasons: [], summary: "Measured skill clears the stated bar." },
      })),
    );
    expect(ok.level).toBe("validated");
    expect(ok.actionable).toBe(true);
  });

  it("ignores a validated flag that has no verdict behind it", () => {
    // Exactly the shape a stale or hand-edited file would have.
    const idx = parseIndex(payload(100, { validated: true }));
    expect(idx!.validated).toBe(false);
    expect(skillState(idx).actionable).toBe(false);
  });

  it("flags synthetic demo data most loudly of all", () => {
    const s = skillState(parseIndex(payload(100, {
      demo: true,
      skill: { validated: true, icir: 3.5, bar: 0.3, reasons: [], summary: "clears" },
    })));
    expect(s.level).toBe("demo");
    expect(s.actionable).toBe(false);
    expect(s.detail).toMatch(/not a forecast/i);
  });

  it("handles a null index", () => {
    expect(skillState(null).actionable).toBe(false);
  });
});

describe("parseSkill", () => {
  it("requires a verdict to be usable", () => {
    expect(parseSkill({})).toBeNull();
    expect(parseSkill({ verdict: {} })).toBeNull();
    expect(parseSkill({ verdict: { validated: false }, rebalances: 30 })).not.toBeNull();
  });
});

describe("decile grouping", () => {
  it("orders deciles most bullish first", () => {
    const groups = decileGroups(parseIndex(payload())!.rows);
    expect(groups[0].decile).toBe(10);
    expect(groups[groups.length - 1].decile).toBe(1);
  });

  it("keeps rows rank-ordered inside a decile", () => {
    const groups = decileGroups(parseIndex(payload())!.rows);
    for (const g of groups) {
      expect(g.rows.map((r) => r.rank)).toEqual([...g.rows.map((r) => r.rank)].sort((a, b) => a - b));
    }
  });

  it("averages the forecast within a decile", () => {
    const groups = decileGroups([
      row({ decile: 10, rank: 1, forecastReturn: 0.1 }),
      row({ decile: 10, rank: 2, forecastReturn: 0.2 }),
    ]);
    expect(groups[0].meanForecast).toBeCloseTo(0.15);
  });
});

describe("edges", () => {
  it("returns the two ends of the book, bottom worst-first", () => {
    const rows = parseIndex(payload(100))!.rows;
    const { top, bottom } = edges(rows, 5);
    expect(top[0].rank).toBe(1);
    expect(bottom[0].rank).toBe(100);
    expect(bottom).toHaveLength(5);
  });
});

describe("sectorCounts", () => {
  it("counts sectors within a decile, most common first", () => {
    const rows = [
      row({ decile: 10, sector: "IT" }),
      row({ decile: 10, sector: "IT" }),
      row({ decile: 10, sector: "Banks" }),
      row({ decile: 1, sector: "Pharma" }),
    ];
    expect(sectorCounts(rows, 10)).toEqual([["IT", 2], ["Banks", 1]]);
  });
});

describe("leanTone", () => {
  it("maps lean to the app's tone vocabulary", () => {
    expect(leanTone("bullish")).toBe("up");
    expect(leanTone("bearish")).toBe("down");
    expect(leanTone("neutral")).toBeNull();
  });
});

describe("quantile", () => {
  it("interpolates linearly on a sorted array", () => {
    const s = [0, 10, 20, 30, 40];
    expect(quantile(s, 0)).toBe(0);
    expect(quantile(s, 1)).toBe(40);
    expect(quantile(s, 0.5)).toBe(20);
    expect(quantile(s, 0.25)).toBe(10);
  });

  it("handles degenerate inputs", () => {
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
    expect(quantile([7], 0.9)).toBe(7);
  });

  it("clamps out-of-range quantiles", () => {
    expect(quantile([1, 2, 3], -1)).toBe(1);
    expect(quantile([1, 2, 3], 5)).toBe(3);
  });
});

describe("coneFromPaths", () => {
  const paths = [
    [100, 101, 102, 103],
    [100, 99, 98, 97],
    [100, 100, 101, 105],
    [100, 102, 99, 95],
  ];

  it("brackets the median between the bands at every step", () => {
    const c = coneFromPaths(paths)!;
    expect(c.lo).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(c.lo[i]).toBeLessThanOrEqual(c.mid[i]);
      expect(c.mid[i]).toBeLessThanOrEqual(c.hi[i]);
    }
  });

  it("widens over the horizon, because uncertainty compounds", () => {
    const c = coneFromPaths(paths)!;
    expect(c.hi[3] - c.lo[3]).toBeGreaterThan(c.hi[0] - c.lo[0]);
  });

  it("reports the extremes used for scaling", () => {
    const c = coneFromPaths(paths)!;
    expect(c.min).toBe(Math.min(...c.lo));
    expect(c.max).toBe(Math.max(...c.hi));
  });

  it("returns null when there is nothing to draw", () => {
    expect(coneFromPaths([])).toBeNull();
    expect(coneFromPaths([[100]])).toBeNull();
  });

  it("truncates to the shortest path so the bands stay aligned", () => {
    const c = coneFromPaths([[100, 101, 102], [100, 99]])!;
    expect(c.lo).toHaveLength(2);
  });
});

describe("coneFor — the band must agree with the headline forecast", () => {
  it("prefers the builder's band over the displayed sample paths", () => {
    // The band is computed across every sample; `paths` are a noisy handful.
    // Taking the median from the paths is what made the chart disagree with the
    // published forecast, so the band must win whenever it is present.
    const cone = coneFor({
      band: { lo: [100, 95], mid: [100, 110], hi: [100, 125] },
      paths: [[100, 90], [100, 91]],
    })!;
    expect(cone.mid).toEqual([100, 110]);
    expect(cone.min).toBe(95);
    expect(cone.max).toBe(125);
  });

  it("falls back to sample paths when no band was published", () => {
    const cone = coneFor({ paths: [[100, 101], [100, 99], [100, 103]] })!;
    expect(cone.mid).toHaveLength(2);
  });

  it("falls back when the band is incomplete", () => {
    const cone = coneFor({ band: { mid: [100, 110] }, paths: [[100, 101], [100, 99]] })!;
    expect(cone.mid).toHaveLength(2);
    expect(cone.mid[1]).toBeCloseTo(100); // from paths, not the lone mid
  });

  it("returns null when there is neither band nor paths", () => {
    expect(coneFor({})).toBeNull();
    expect(coneFor({ band: {}, paths: [] })).toBeNull();
  });

  it("truncates a ragged band to its shortest series", () => {
    const cone = coneFor({ band: { lo: [1, 2, 3], mid: [1, 2], hi: [1, 2, 3] } })!;
    expect(cone.mid).toHaveLength(2);
    expect(cone.lo).toHaveLength(2);
  });
});
