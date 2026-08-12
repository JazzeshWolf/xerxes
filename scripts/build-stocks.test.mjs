import { describe, it, expect } from "vitest";
import { pickNewsQueue } from "./build-stocks.mjs";

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
