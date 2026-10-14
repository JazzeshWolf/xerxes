import { describe, it, expect } from "vitest";
import { squarify, tileValues } from "./treemap";
import { heatStep, defaultPeriod } from "./outlook";
import type { StockRow } from "./types";

const W = 100;
const H = 75;

describe("squarify", () => {
  const items = [60, 30, 20, 12, 8, 6, 4, 3, 2, 1].map((v, i) => ({ key: `S${i}`, value: v }));
  const rects = squarify(items, W, H);

  it("tiles the whole box, every area proportional to its value", () => {
    const total = items.reduce((a, i) => a + i.value, 0);
    const area = rects.reduce((a, r) => a + r.w * r.h, 0);
    expect(area).toBeCloseTo(W * H, 6);
    for (const r of rects) {
      const v = items.find((i) => i.key === r.key)!.value;
      expect(r.w * r.h).toBeCloseTo((v / total) * W * H, 6);
    }
  });

  it("stays inside the box and never overlaps", () => {
    const eps = 1e-9;
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-eps);
      expect(r.y).toBeGreaterThanOrEqual(-eps);
      expect(r.x + r.w).toBeLessThanOrEqual(W + eps);
      expect(r.y + r.h).toBeLessThanOrEqual(H + eps);
    }
    for (let a = 0; a < rects.length; a++)
      for (let b = a + 1; b < rects.length; b++) {
        const p = rects[a], q = rects[b];
        const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
        const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
        expect(ox > eps && oy > eps).toBe(false);
      }
  });

  it("keeps the big tiles near-square (the point of squarifying)", () => {
    const big = rects.slice(0, 3).map((r) => Math.max(r.w / r.h, r.h / r.w));
    for (const ratio of big) expect(ratio).toBeLessThan(3);
  });

  it("drops non-positive values and handles empty input", () => {
    expect(squarify([{ key: "A", value: 0 }, { key: "B", value: -1 }, { key: "C", value: NaN }], W, H)).toEqual([]);
    expect(squarify([], W, H)).toEqual([]);
    expect(squarify([{ key: "A", value: 5 }], W, H)).toEqual([{ key: "A", x: 0, y: 0, w: W, h: H }]);
  });
});

describe("tileValues", () => {
  it("sizes by traded value, giving a name without one the sector median", () => {
    const r = tileValues([{ key: "A", adv: 100 }, { key: "B", adv: 10 }, { key: "C", adv: null }, { key: "D", adv: 30 }]);
    expect(r.sized).toBe(true);
    expect(r.items.find((i) => i.key === "C")!.value).toBe(30);
  });
  it("falls back to equal tiles when nobody has a value yet", () => {
    const r = tileValues([{ key: "A" }, { key: "B", adv: null }]);
    expect(r.sized).toBe(false);
    expect(r.items.map((i) => i.value)).toEqual([1, 1]);
  });
});

describe("heat map colour + default period", () => {
  it("heatStep scales to each period's saturation point", () => {
    expect(heatStep(0, "d1")).toBe(0);
    expect(heatStep(null, "d1")).toBe(0);
    expect(heatStep(0.1, "d1")).toBe(1); // any move gets at least one step
    expect(heatStep(-1.5, "d1")).toBe(-2);
    expect(heatStep(3, "d1")).toBe(4);
    expect(heatStep(9, "d1")).toBe(4); // capped
    expect(heatStep(3, "m3")).toBe(1); // 3% over a quarter is mild
  });

  const row = (symbol: string, d1: number | null): StockRow => ({ symbol, changePct: d1, perf: { d1, w1: 1, m1: 1, m3: 1 } }) as StockRow;
  it("opens on 1W when every day move is zero (a weekend/holiday rebuild)", () => {
    expect(defaultPeriod([row("A", 0), row("B", 0)], 0)).toBe("w1");
    expect(defaultPeriod([row("A", 0), row("B", 0.4)], 0)).toBe("d1");
    expect(defaultPeriod([row("A", null)], 1.2)).toBe("d1");
  });
});
