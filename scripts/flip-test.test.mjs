import { describe, it, expect } from "vitest";
import { parseCandles, oppositeAtm, entryIndex, simulate, netReturn, summarize, evaluate, istSeconds, buildReport } from "./flip-test.mjs";

// 5-min candles from minute m with o/h/l/c.
const C = (m, o, h, l, c) => ({ t: m, o, h, l, c, v: 100 });
const T = (hh, mm) => hh * 60 + mm;

describe("parseCandles", () => {
  it("reads Upstox arrays newest-first into IST minutes, oldest-first", () => {
    const out = parseCandles([
      ["2026-11-13T12:40:00+05:30", 2.5, 2.6, 2.4, 2.55, 1000, 5],
      ["2026-11-13T12:35:00+05:30", 2.4, 2.5, 2.3, 2.5, 800, 5],
      ["2026-11-13T12:30:00+05:30", 0, 0, 0, 0, 0, 0],
    ]);
    expect(out.map((c) => c.t)).toEqual([T(12, 35), T(12, 40)]);
  });
});

describe("oppositeAtm", () => {
  it("flips the side and takes the strike nearest spot", () => {
    expect(oppositeAtm("CE", 84.2, [80, 82, 84, 86, 90])).toEqual({ type: "PE", strike: 84 });
    expect(oppositeAtm("PE", 85.4, [80, 85, 86])).toEqual({ type: "CE", strike: 85 });
  });
  it("breaks a tie toward the lower strike", () => {
    expect(oppositeAtm("CE", 85, [84, 86])).toEqual({ type: "PE", strike: 84 });
  });
  it("returns null without strikes or spot", () => {
    expect(oppositeAtm("CE", 85, [])).toBeNull();
    expect(oppositeAtm("CE", null, [85])).toBeNull();
  });
});

describe("entryIndex", () => {
  const cs = [C(T(12, 30), 1, 1, 1, 1), C(T(12, 35), 1, 1, 1, 1), C(T(12, 40), 1, 1, 1, 1)];
  it("an alert at 12:31 enters on the 12:35 candle", () => {
    expect(entryIndex(cs, T(12, 31) * 60 + 5)).toBe(1);
  });
  it("an alert at 12:35:20 waits for 12:40 — that candle had already started", () => {
    expect(entryIndex(cs, T(12, 35) * 60 + 20)).toBe(2);
  });
});

describe("simulate", () => {
  it("hits the target at the target price", () => {
    const cs = [C(600, 2.0, 2.05, 1.98, 2.02), C(605, 2.02, 2.12, 2.0, 2.1)];
    expect(simulate(cs, 0, { stop: 0.1 })).toMatchObject({ entry: 2, exit: 2.1, reason: "target" });
  });
  it("stops out at the stop price", () => {
    const cs = [C(600, 2.0, 2.05, 1.95, 1.96), C(605, 1.96, 1.97, 1.75, 1.8)];
    expect(simulate(cs, 0, { stop: 0.1 })).toMatchObject({ exit: 1.8, reason: "stop" });
  });
  it("a candle touching both counts as the stop, flagged ambiguous", () => {
    const cs = [C(600, 2.0, 2.2, 1.7, 2.0)];
    expect(simulate(cs, 0, { stop: 0.1 })).toMatchObject({ reason: "stop", ambiguous: true });
  });
  it("a gap through the stop fills at the open, not the stop", () => {
    const cs = [C(600, 2.0, 2.05, 1.95, 1.96), C(605, 1.5, 1.6, 1.45, 1.5)];
    expect(simulate(cs, 0, { stop: 0.1 })).toMatchObject({ exit: 1.5, reason: "stop" });
  });
  it("squares off at the 15:15 candle's open", () => {
    const cs = [C(T(15, 5), 2.0, 2.05, 1.95, 2.0), C(T(15, 10), 2.0, 2.04, 1.96, 2.01), C(T(15, 15), 2.03, 2.2, 2.0, 2.1)];
    expect(simulate(cs, 0, { stop: 0.1 })).toMatchObject({ exit: 2.03, reason: "time", at: T(15, 15) });
  });
  it("without a stop only target or time can end it", () => {
    const cs = [C(600, 2.0, 2.04, 0.5, 0.6), C(T(15, 15), 0.7, 0.7, 0.7, 0.7)];
    expect(simulate(cs, 0, { stop: null })).toMatchObject({ exit: 0.7, reason: "time" });
  });
  it("rounds the target UP to a tick, so +5% means at least +5%", () => {
    const cs = [C(600, 2.55, 2.65, 2.55, 2.6), C(605, 2.6, 2.7, 2.6, 2.7)];
    // 2.55 × 1.05 = 2.6775 → 2.70
    expect(simulate(cs, 0, { stop: null })).toMatchObject({ exit: 2.7, reason: "target", at: 605 });
  });
});

describe("netReturn", () => {
  it("costs turn a +5% gross target into a smaller net", () => {
    const r = netReturn({ entry: 2.5, exit: 2.65, reason: "target" }, 5425);
    expect(r.grossPct).toBeCloseTo(6, 5);
    expect(r.netPct).toBeLessThan(4.5);
    expect(r.netPct).toBeGreaterThan(2);
  });
  it("a flat trade loses money", () => {
    expect(netReturn({ entry: 2.5, exit: 2.5, reason: "time" }, 5425).netPct).toBeLessThan(-3);
  });
});

describe("summarize / evaluate", () => {
  it("summarizes hit rates", () => {
    const s = summarize([{ reason: "target", netPct: 3, netRs: 100 }, { reason: "stop", netPct: -12, netRs: -400 }]);
    expect(s).toMatchObject({ n: 2, targetPct: 50, stopPct: 50, winPct: 50, meanNet: -4.5, sumRs: -300 });
  });
  it("skips an alert with no trade for over 30 minutes", () => {
    const cs = [C(T(10, 0), 2, 2, 2, 2), C(T(11, 0), 2, 2, 2, 2)];
    expect(evaluate(cs, T(10, 2) * 60, 1000).skip).toMatch(/illiquid/);
  });
  it("skips an alert after the last entry time", () => {
    const cs = [C(T(15, 10), 2, 2, 2, 2), C(T(15, 15), 2, 2, 2, 2)];
    expect(evaluate(cs, T(15, 11) * 60, 1000).skip).toMatch(/too late|no candle/);
  });
  it("evaluates every stop level with a baseline, and the report renders", () => {
    const cs = [];
    for (let m = T(9, 15), p = 2; m <= T(15, 25); m += 5, p += 0.01) cs.push(C(m, p, p + 0.05, p - 0.05, p + 0.01));
    const ev = evaluate(cs, istSeconds("2026-11-13T07:01:00Z"), 1000); // 12:31 IST
    expect(ev.entryAt).toBe(T(12, 35));
    expect(Object.keys(ev.byStop)).toEqual(["5%", "10%", "20%", "none"]);
    const trade = { feeds: ["stocks"], buyType: "PE", entryIst: "12:35", expiry: "2026-11-23", byStop: ev.byStop };
    expect(buildReport([trade], [{ skip: "x" }], { expiredApi: "ok", generatedAt: "now", signals: 2 })).toMatch(/\| 10% \| 1 \|/);
  });
});
