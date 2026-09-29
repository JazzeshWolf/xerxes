import { describe, it, expect } from "vitest";
import * as A from "./analytics.mjs";
import { pickNewsQueue, buildStock, buildHealth } from "./build-stocks.mjs";
import { bars, denseChain } from "./test-fixtures.mjs";

// The news rotation has no persisted cursor: each run re-fetches the stalest
// few names by `newsAsOf`, so the ordering IS the scheduler. These tests pin
// the two properties that keeps honest.
describe("pickNewsQueue", () => {
  it("takes the stalest names first, never-fetched before merely old", () => {
    const q = pickNewsQueue(
      ["FRESH", "OLD", "NEVER", "MID"],
      {
        FRESH: "2026-08-11T09:00:00Z",
        OLD: "2026-08-01T09:00:00Z",
        NEVER: null,
        MID: "2026-08-05T09:00:00Z",
      },
      2,
    );
    expect([...q].sort()).toEqual(["NEVER", "OLD"]);
  });

  it("rotates: yesterday's picks fall to the back once they carry a timestamp", () => {
    const symbols = ["A", "B", "C", "D"];
    const asOf = { A: null, B: null, C: null, D: null };
    const first = pickNewsQueue(symbols, asOf, 2);
    for (const s of first) asOf[s] = "2026-08-11T09:00:00Z";
    const second = pickNewsQueue(symbols, asOf, 2);
    // No overlap — the whole universe cycles instead of one slice repeating.
    expect([...second].some((s) => first.has(s))).toBe(false);
  });

  // The production failure, reduced. ~33 symbols in the shipped universe no
  // longer have F&O contracts (delisted or renamed: ZOMATO→ETERNAL,
  // LTIM→LTM, …). They never resolve to a chain, so they never write a file,
  // so their `newsAsOf` is null on EVERY run — and if they're allowed into the
  // sort they win it forever. Live names behind them starve permanently.
  it("starves the live universe if dead symbols are allowed in — hence the caller filters", () => {
    const dead = ["ZOMATO", "LTIM", "ACC"];
    const liveNames = ["DELHIVERY", "BEL", "HAL"];
    const asOf = Object.fromEntries([
      ...dead.map((s) => [s, null]),
      ...liveNames.map((s) => [s, null]),
    ]);

    // Simulate many runs. Dead names never acquire a newsAsOf, because no file
    // is ever written for them; live names do.
    const seen = new Set();
    for (let run = 0; run < 10; run++) {
      const q = pickNewsQueue([...dead, ...liveNames], asOf, 3);
      for (const s of q) {
        seen.add(s);
        if (!dead.includes(s)) asOf[s] = new Date(2026, 7, 11, run).toISOString();
      }
    }
    // Ten runs, three slots each, and not one live name was ever reached.
    expect([...seen].sort()).toEqual([...dead].sort());

    // Filtering to names that actually resolved is the fix: every live name
    // gets news within the first couple of runs.
    const liveOnly = Object.fromEntries(liveNames.map((s) => [s, null]));
    expect([...pickNewsQueue(liveNames, liveOnly, 3)].sort()).toEqual([...liveNames].sort());
  });

  it("is stable when every name ties at never-fetched", () => {
    const symbols = ["A", "B", "C", "D", "E"];
    const asOf = Object.fromEntries(symbols.map((s) => [s, null]));
    // An inconsistent comparator (±1 on ties) can drop or duplicate entries;
    // assert the slice is exactly `limit` distinct symbols from the input.
    const q = pickNewsQueue(symbols, asOf, 3);
    expect(q.size).toBe(3);
    for (const s of q) expect(symbols).toContain(s);
  });
});

describe("buildStock candidate cap", () => {
  // Same regression as the index builder: a flat pre-scoring `.slice(0, 24)`
  // kept only puts whenever 24+ of them cleared the filters.
  it("scores calls even when more than 24 puts clear the filters, capping per side", () => {
    const spot = 1000;
    const expiry = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const ohlc = bars();
    const { snap } = buildStock(
      "Test Ltd",
      {
        symbol: "TEST", spot, prevClose: spot, closes: ohlc.map((b) => b.c), ohlc,
        chainsByExpiry: { [expiry]: denseChain(spot, 30) }, orderedExpiries: [expiry],
        lotSize: 75, future: null, sector: null,
      },
      { value: 14, closes: [] },
    );
    const got = snap.expiries[expiry].candidates;
    expect(got.filter((c) => c.type === "PE")).toHaveLength(A.CANDIDATES_PER_SIDE);
    expect(got.filter((c) => c.type === "CE").length).toBeGreaterThan(0);
    expect(got.every((c) => c.conviction != null)).toBe(true);
  });
});

describe("buildHealth", () => {
  // The asOf guard in stocks.yml cannot see these: an empty build still stamps
  // a fresh asOf, so an expired token used to publish an empty screener green.
  it("never lets an empty build publish, even with no previous run to compare", () => {
    expect(buildHealth(0, 207).ok).toBe(false);
    expect(buildHealth(0, null).ok).toBe(false);
    expect(buildHealth(0, null, 0).ok).toBe(false); // the override cannot publish nothing
  });

  it("refuses a collapsed build below the ratio of the previous run", () => {
    const h = buildHealth(60, 207, 0.9);
    expect(h.ok).toBe(false);
    expect(h.reason).toMatch(/built 60 stocks.*207.*need 187/);
    expect(buildHealth(186, 207, 0.9).ok).toBe(false);
    expect(buildHealth(187, 207, 0.9).ok).toBe(true);
  });

  it("passes a normal run, a first run, and a run with the ratio overridden to 0", () => {
    expect(buildHealth(207, 207).ok).toBe(true);
    expect(buildHealth(210, 207).ok).toBe(true);
    expect(buildHealth(150, null).ok).toBe(true);
    expect(buildHealth(60, 207, 0).ok).toBe(true);
  });
});
