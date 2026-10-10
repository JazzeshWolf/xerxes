import { describe, it, expect } from "vitest";
import { pickNewsQueue, pickNewsPriority, candidateSymbols, findMovers } from "./build-stocks.mjs";

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

describe("news priority", () => {
  const NOW = Date.parse("2026-10-12T06:00:00Z");
  const ago = (min) => new Date(NOW - min * 60000).toISOString();

  it("candidateSymbols dedupes across both expiries, best conviction first", () => {
    const syms = candidateSymbols({
      expiries: [
        { candidates: [{ symbol: "SBIN", conviction: 70 }, { symbol: "BHEL", conviction: 82 }, { symbol: "SBIN", conviction: 65 }] },
        { candidates: [{ symbol: "TCS", conviction: 75 }, { symbol: "BHEL", conviction: 60 }] },
      ],
    });
    expect(syms).toEqual(["BHEL", "TCS", "SBIN"]);
    expect(candidateSymbols(null)).toEqual([]);
    // The pre-expiries shape still works.
    expect(candidateSymbols({ candidates: [{ symbol: "LT", conviction: 50 }] })).toEqual(["LT"]);
  });

  it("findMovers flags an own-story move, not a stock riding its sector or the tape", () => {
    const rows = [
      // The whole bank sector is up ~2%: none of them is its own story.
      { symbol: "SBIN", sector: "Banks", changePct: 2.1, beta: 1, pace: 1 },
      { symbol: "PNB", sector: "Banks", changePct: 2.0, beta: 1, pace: 1 },
      { symbol: "BOB", sector: "Banks", changePct: 1.9, beta: 1, pace: 1 },
      // BHEL +5% while its sector is flat: own story.
      { symbol: "BHEL", sector: "Infra", changePct: 5, beta: 1, pace: 1.2 },
      { symbol: "LT", sector: "Infra", changePct: 0.4, beta: 1, pace: 1 },
      { symbol: "ABB", sector: "Infra", changePct: 0.3, beta: 1, pace: 1 },
      // Flat price on 3× volume: worth a look too.
      { symbol: "ITC", sector: "FMCG", changePct: 0.2, beta: 0.7, pace: 3 },
    ];
    const m = findMovers(rows, 0.5);
    expect(m.map((x) => x.symbol)).toEqual(["BHEL", "ITC"]);
    // A two-name sector has no robust median, so only the market is netted out.
    const pair = findMovers([{ symbol: "X", sector: "S", changePct: 5, beta: 1 }, { symbol: "Y", sector: "S", changePct: 0, beta: 1 }], 0);
    expect(pair.map((x) => x.symbol)).toEqual(["X"]);
    // Sector median includes BHEL itself (0.4), so its neighbours aren't tainted.
    expect(m[0].own).toBeCloseTo(5 - 0.5 - (0.4 - 0.5), 6);
  });

  it("movers refresh every run; candidates once their news is ~35 min old; dead names never", () => {
    const live = new Set(["A", "B", "C", "D", "M1", "M2", "M3"]);
    const r = pickNewsPriority(
      {
        candidates: ["A", "DEAD", "B", "C", "D"],
        movers: [{ symbol: "M1" }, { symbol: "M2" }, { symbol: "M3" }],
        live,
        // A was refreshed last run (20 min ago): its turn is next run. C never was.
        newsAsOfBySymbol: { A: ago(20), B: ago(40), C: null, D: ago(60), M1: ago(20), M2: ago(5) },
        now: NOW,
      },
      { candidatesMax: 2, moversMax: 2 },
    );
    expect(r.fromCandidates).toEqual(["B", "C"]); // capped at 2, best conviction first
    // M1 was fetched a run ago and still goes (movers are every run); M2 only
    // 5 min ago (back-to-back run), so M3 takes the slot.
    expect(r.fromMovers).toEqual(["M1", "M3"]);
  });

  it("over two runs every candidate name is covered", () => {
    const cands = Array.from({ length: 26 }, (_, i) => `S${i}`);
    const live = new Set(cands);
    const asOf = {};
    const run = (t) => {
      const r = pickNewsPriority({ candidates: cands, live, newsAsOfBySymbol: asOf, now: t });
      for (const s of r.set) asOf[s] = new Date(t).toISOString();
      return r.set;
    };
    // Steady state: start from everyone fetched at staggered times.
    cands.forEach((s, i) => (asOf[s] = ago(i % 2 ? 20 : 40)));
    const first = run(NOW);
    const second = run(NOW + 20 * 60000);
    expect(new Set([...first, ...second]).size).toBe(26);
    expect(first.size).toBeLessThanOrEqual(16);
  });

  it("a stock that is both a mover and a candidate takes one slot", () => {
    const r = pickNewsPriority(
      { candidates: ["A", "B"], movers: [{ symbol: "A" }], live: new Set(["A", "B"]), now: NOW },
      { candidatesMax: 2, moversMax: 1 },
    );
    expect(r.fromMovers).toEqual(["A"]);
    expect(r.fromCandidates).toEqual(["B"]);
  });

  it("the rotation still reaches everyone else with the remaining budget", () => {
    const live = ["A", "B", "C", "D", "E", "F"];
    const asOf = { A: ago(15), B: ago(15), C: ago(400), D: ago(300), E: null, F: ago(100) };
    const pr = pickNewsPriority({ candidates: ["A", "B"], live: new Set(live), newsAsOfBySymbol: asOf, now: NOW }, { candidateMaxAgeMs: 0 });
    const rot = pickNewsQueue(live.filter((s) => !pr.set.has(s)), asOf, 4 - pr.set.size);
    // Never-fetched E, then the stalest; priority names are not double-counted.
    expect([...rot].sort()).toEqual(["C", "E"]);
  });
});
