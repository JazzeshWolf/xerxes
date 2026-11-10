import { describe, it, expect } from "vitest";
import {
  isMonthly, DEFAULT_THRESHOLDS, DEFAULT_GATES, RULES, qualifies, cushionOf, mockEvents, loadAnnounced, table, inAlertWindow, formatEod, romPct, collectStocks, collectIndices, diff, formatMessages, formatHeartbeat, bumpDay,
  earningsDates, earningsBefore, SHARP, FEEDS, resultsInLife, gateText,
  resultsWarnings, chainQuote, formatResultsWarnings, rememberResults, applyKnownResults,
} from "./alerts.mjs";

const TODAY = "2026-09-16";
const row = (over = {}) => ({
  source: "stocks", symbol: "WIPRO", name: "Wipro", expiry: "2026-10-27", dte: 41,
  strike: 190, type: "CE", conviction: 72, ltp: 1.09, lot: 3000, credit: 3270,
  kind: "Monthly", displayed: true, ...over,
});
const k = (r) => `${r.symbol}|${r.expiry}|${r.strike}|${r.type}`;
const cur = (...rows) => new Map(rows.map((r) => [k(r), r]));
const always = () => true;
const run = (tracked, current, over = {}) =>
  diff(tracked, current, { threshold: 70, today: TODAY, isFresh: always, ...over });

describe("isMonthly", () => {
  const NIFTY_SEP = ["2026-09-22", "2026-09-29", "2026-10-06", "2026-10-13", "2026-10-27", "2026-11-23"];
  it("takes the last listed expiry of the month in its final days", () => {
    expect(isMonthly("2026-09-29", NIFTY_SEP)).toBe(true);
    expect(isMonthly("2026-10-27", NIFTY_SEP)).toBe(true);
    expect(isMonthly("2026-09-24", ["2026-09-17", "2026-09-24", "2026-10-01"])).toBe(true); // SENSEX (Thu)
  });
  it("does not mistake a weekly 8 days from month end for the monthly", () => {
    expect(isMonthly("2026-09-22", NIFTY_SEP)).toBe(false);
  });
  it("keeps a holiday-shifted monthly (NIFTY Nov 2026: Tue 24 → Mon 23)", () => {
    expect(isMonthly("2026-11-23", NIFTY_SEP)).toBe(true);
    expect(isMonthly("2026-11-17", ["2026-11-17", "2026-11-23"])).toBe(false);
  });
  it("does not promote a mid-month weekly when the list is truncated", () => {
    expect(isMonthly("2026-10-19", ["2026-10-06", "2026-10-13", "2026-10-19"])).toBe(false);
  });
});

describe("inAlertWindow", () => {
  const at = (iso) => inAlertWindow(new Date(iso));
  it("is open on a weekday between 09:15 and 15:50 IST", () => {
    expect(at("2026-09-28T03:45:00Z")).toBe(true);  // Mon 09:15 IST
    expect(at("2026-09-28T10:20:00Z")).toBe(true);  // Mon 15:50 IST
    expect(at("2026-09-28T03:40:00Z")).toBe(false); // 09:10, pre-open
    expect(at("2026-09-28T10:25:00Z")).toBe(false); // 15:55, after the close
  });
  it("is shut for the late GitHub run that raised a phantom alert at 23:17 IST", () => {
    expect(at("2026-09-28T17:47:23Z")).toBe(false);
  });
  it("is shut at weekends", () => {
    expect(at("2026-09-26T06:00:00Z")).toBe(false); // Sat 11:30 IST
  });
});

describe("diff", () => {
  it("announces a displayed contract crossing the threshold, once", () => {
    const r = row();
    const a = run({}, cur(r));
    expect(a.events.map((e) => e.kind)).toEqual(["NEW"]);
    const b = run(a.tracked, cur(r));
    expect(b.events).toEqual([]); // same score next run → silence
  });

  it("never starts tracking a strike that is not on the displayed list", () => {
    expect(run({}, cur(row({ displayed: false, conviction: 90 }))).events).toEqual([]);
  });

  it("reports every point of movement while above the bar, both directions", () => {
    const { tracked } = run({}, cur(row({ conviction: 70 })));
    const up = run(tracked, cur(row({ conviction: 71 })));
    expect(up.events).toMatchObject([{ kind: "MOVED", from: 70, row: { conviction: 71 } }]);
    const down = run(up.tracked, cur(row({ conviction: 70 })));
    expect(down.events).toMatchObject([{ kind: "MOVED", from: 71 }]);
  });

  it("reports the drop below the bar and stops tracking", () => {
    const { tracked } = run({}, cur(row({ conviction: 70 })));
    const d = run(tracked, cur(row({ conviction: 69 })));
    expect(d.events).toMatchObject([{ kind: "DROPPED", from: 70, row: { conviction: 69 } }]);
    expect(d.tracked).toEqual({});
    // …and a later re-cross is NEW again.
    expect(run(d.tracked, cur(row({ conviction: 71 }))).events[0].kind).toBe("NEW");
  });

  it("keeps tracking a stock that left the top 24 but is still scored in its own file", () => {
    const { tracked } = run({}, cur(row({ conviction: 72 })));
    const d = run(tracked, cur(row({ conviction: 73, displayed: false })));
    expect(d.events).toMatchObject([{ kind: "MOVED", from: 72 }]);
    expect(Object.keys(d.tracked)).toHaveLength(1);
  });

  it("reports LEFT when a tracked contract is no longer scored at all", () => {
    const { tracked } = run({}, cur(row()));
    const d = run(tracked, new Map());
    expect(d.events).toMatchObject([{ kind: "LEFT", from: 72, expiring: false }]);
    expect(d.tracked).toEqual({});
  });

  it("holds silently when the name got no fresh data this run", () => {
    const { tracked } = run({}, cur(row()));
    const d = run(tracked, new Map(), { isFresh: () => false });
    expect(d.events).toEqual([]);
    expect(d.tracked).toEqual(tracked);
  });

  it("drops expired contracts without a message", () => {
    const { tracked } = run({}, cur(row({ expiry: "2026-09-15" })), { today: "2026-09-14" });
    expect(run(tracked, new Map()).events).toEqual([]);
  });

  it("flags a contract that vanishes on its expiry day as expiring, not delisted", () => {
    const { tracked } = run({}, cur(row({ expiry: TODAY })));
    expect(run(tracked, new Map()).events[0]).toMatchObject({ kind: "LEFT", expiring: true });
  });

  it("orders entries and exits before drift", () => {
    const a = row({ strike: 185, conviction: 71 });
    const b = row({ strike: 190, conviction: 74 });
    const { tracked } = run({}, cur(a, b));
    const d = run(tracked, cur(row({ strike: 185, conviction: 72 }), row({ strike: 195, conviction: 75 })));
    expect(d.events.map((e) => e.kind)).toEqual(["NEW", "LEFT", "MOVED"]);
  });
});

describe("return bar (ROM)", () => {
  // WIPRO lot 3,000 at spot 167: capital = 15% × 167 × 3,000 = 75,150.
  const at = (credit, over = {}) => row({ conviction: 72, spot: 167, credit, ...over });
  const go = (tracked, rows, minRom) => diff(tracked, cur(...rows), { threshold: 70, today: TODAY, isFresh: always, minRom });

  it("computes ROM on the scorer's margin proxy", () => {
    expect(romPct(at(3758))).toBeCloseTo(5.0, 1);
    expect(romPct(at(3758, { source: "indices", spot: 23100, lot: 65, credit: 3166 }))).toBeCloseTo(2.64, 2);
    expect(romPct(row({ spot: null }))).toBeNull();
  });

  it("a 70+ stock needs ROM 5%+ to enter", () => {
    expect(go({}, [at(3680)], 5).events).toEqual([]);          // 4.9%
    expect(go({}, [at(3758)], 5).events[0].kind).toBe("NEW");  // 5.0%
    expect(go({}, [row({ conviction: 80, spot: null })], 5).events).toEqual([]); // unverifiable
  });

  it("a 60+ index option needs ROM 3%+ to enter", () => {
    const ix = (credit) => row({ source: "indices", symbol: "NIFTY", strike: 21600, type: "PE", kind: "Monthly",
      conviction: 61, spot: 23100, lot: 65, credit });
    const run = (r) => diff({}, cur(r), { threshold: 60, today: TODAY, isFresh: always, minRom: 3 });
    expect(run(ix(3480)).events).toEqual([]);         // 2.9%
    expect(run(ix(3604)).events[0].kind).toBe("NEW"); // 3.0%
  });

  it("ROM is not an exit: a tracked contract whose ROM falls stays tracked", () => {
    const { tracked } = go({}, [at(3800)], 5);
    const d = go(tracked, [at(1500, { conviction: 73 })], 5); // premium decayed to 2% ROM
    expect(d.events.map((e) => e.kind)).toEqual(["MOVED"]);
    expect(Object.keys(d.tracked)).toHaveLength(1);
  });

  it("alert header states both bars", () => {
    const [m] = formatMessages([{ kind: "NEW", row: at(3800) }], { source: "stocks", threshold: 70, minRom: 5, when: "10:40", today: TODAY });
    expect(m).toContain("Alert level: conviction 70+ · ROM 5%+");
  });
});

describe("firing gates (2026-10-03)", () => {
  const IDX = { threshold: 40, minCushion: 1.5 };
  const STK = { threshold: 70, minRom: 5, minDte: 5 };
  const ix = (over = {}) => row({ source: "indices", symbol: "NIFTY", strike: 21600, type: "PE", kind: "Monthly",
    conviction: 45, spot: 23100, lot: 65, credit: 300, cushion: 1.5, ...over });
  // WIPRO lot 3,000 at spot 167: 4,500 credit = 6% ROM.
  const st = (over = {}) => row({ conviction: 72, spot: 167, credit: 4500, dte: 5, ...over });
  const go = (r, gate) => diff({}, cur(r), { today: TODAY, isFresh: always, ...gate }).events.map((e) => e.kind);

  it("defaults: index conviction 60 + cushion 1.5σ, stock conviction 70 + ROM 5% + 5 days, no index ROM bar", () => {
    expect(DEFAULT_GATES).toMatchObject({ stocks: 70, indices: 60, rom: { stocks: 5, indices: 0 },
      cushion: { stocks: 0, indices: 1.5 }, dte: { stocks: 5, indices: 0 } });
  });

  it("index: cushion 1.50 enters, 1.49 does not, whatever the ROM", () => {
    expect(go(ix({ cushion: 1.49 }), IDX)).toEqual([]);
    expect(go(ix({ cushion: 1.5 }), IDX)).toEqual(["NEW"]);
    expect(romPct(ix())).toBeLessThan(1); // tiny ROM is no obstacle for indices
  });

  it("index: conviction 39 does not enter even at a 3σ cushion", () => {
    expect(go(ix({ conviction: 39, cushion: 3 }), IDX)).toEqual([]);
  });

  it("index: cushionSigmaF wins, cushionSigma only fills a null, both null means no entry", () => {
    expect(cushionOf({ cushionSigmaF: 1.2, cushionSigma: 2 })).toBe(1.2);
    expect(cushionOf({ cushionSigmaF: null, cushionSigma: 1.7 })).toBe(1.7);
    expect(cushionOf({})).toBeNull();
    expect(go(ix({ cushion: null }), IDX)).toEqual([]);
  });

  it("collectIndices reads the forecast-sigma cushion into rows", () => {
    const f = (c) => ({ NIFTY: { asOf: "2026-09-16T05:10:00Z", lotSize: 65, spot: { price: 23100 },
      expiries: { "2026-10-27": { date: "2026-10-27", candidates: [{ strike: 21600, type: "PE", conviction: 45, ltp: 5, ...c }] } } } });
    expect([...collectIndices(f({ cushionSigmaF: 1.62, cushionSigma: 2.4 })).rows.values()][0].cushion).toBe(1.62);
    expect([...collectIndices(f({ cushionSigma: 2.4 })).rows.values()][0].cushion).toBe(2.4);
  });

  it("stock: needs 5+ days to expiry and ROM 5%+ on top of conviction 70", () => {
    expect(go(st({ dte: 4 }), STK)).toEqual([]);
    expect(go(st({ dte: 5 }), STK)).toEqual(["NEW"]);
    expect(go(st({ credit: 3680 }), STK)).toEqual([]); // ROM 4.9%
    expect(go(st({ conviction: 69 }), STK)).toEqual([]);
  });

  it("stock days fall back to the calendar when the row carries no dte", () => {
    expect(qualifies(st({ dte: null, expiry: "2026-09-20" }), STK, TODAY)).toBe(false); // 4 days
    expect(qualifies(st({ dte: null, expiry: "2026-09-21" }), STK, TODAY)).toBe(true);  // 5 days
  });

  it("exits stay conviction-based: a tracked index contract whose cushion shrinks keeps being followed", () => {
    const { tracked } = diff({}, cur(ix({ cushion: 2 })), { today: TODAY, isFresh: always, ...IDX });
    const d = diff(tracked, cur(ix({ cushion: 0.8, conviction: 41 })), { today: TODAY, isFresh: always, ...IDX });
    expect(d.events.map((e) => e.kind)).toEqual(["MOVED"]); // not DROPPED
    expect(Object.keys(d.tracked)).toHaveLength(1);
  });

  it("header states the gate per source", () => {
    const [i] = formatMessages([{ kind: "NEW", row: ix() }], { source: "indices", ...IDX, when: "10:40", today: TODAY });
    expect(i).toContain("Alert level: conviction 40+ · cushion 1.5σ+ · best strike</i>");
    const [s2] = formatMessages([{ kind: "NEW", row: st() }], { source: "stocks", ...STK, when: "10:40", today: TODAY });
    expect(s2).toContain("Alert level: conviction 70+ · ROM 5%+ · 5+ days</i>");
  });

  it("the mock sample passes its own gate and keeps cards within phone width (28 stocks, 32 indices)", () => {
    for (const [source, , events] of mockEvents()) {
      const gate = source === "indices" ? IDX : STK;
      for (const e of events.filter((x) => x.kind === "NEW")) expect(qualifies(e.row, gate, "2026-10-03")).toBe(true);
      const [m] = formatMessages(events, { source, ...gate, when: "10:40", today: "2026-10-03" });
      // Stocks fit the phone's ~28; index cards carry ROM as well and the owner
      // accepted a slight scroll for it (2026-10-07) — still bounded.
      const max = source === "indices" ? 32 : 28;
      for (const pre of m.match(/<pre>[\s\S]*?<\/pre>/g))
        for (const l of pre.replace(/<\/?pre>/g, "").split("\n")) expect(l.length).toBeLessThanOrEqual(max);
    }
  });
});

describe("index anti-noise rules", () => {
  const ix = (over = {}) => row({ source: "indices", symbol: "NIFTY", strike: 21600, type: "PE", kind: "Monthly",
    conviction: 61, spot: 23100, lot: 65, credit: 4000, ...over });
  const step = (tracked, rows, announced = new Set(), today = TODAY) =>
    diff(tracked, cur(...rows), { threshold: 60, today, isFresh: always, minRom: 3, ...RULES.indices, announced });

  it("reports a move only once it reaches 3 points from the last reported score", () => {
    let { tracked } = step({}, [ix({ conviction: 61 })]);
    for (const c of [62, 63]) {
      const d = step(tracked, [ix({ conviction: c })]);
      expect(d.events).toEqual([]);
      tracked = d.tracked;
    }
    const d = step(tracked, [ix({ conviction: 64 })]);
    expect(d.events).toMatchObject([{ kind: "MOVED", from: 61, row: { conviction: 64 } }]);
    // the next move is measured from 64
    expect(step(d.tracked, [ix({ conviction: 62 })]).events).toEqual([]);
  });

  it("drops only below 57", () => {
    let { tracked } = step({}, [ix({ conviction: 60 })]);
    for (const c of [59, 58]) {
      const d = step(tracked, [ix({ conviction: c })]);
      expect(d.events).toEqual([]); // under 60 but inside the buffer: still tracked, quiet
      tracked = d.tracked;
    }
    const at57 = step(tracked, [ix({ conviction: 57 })]);
    expect(at57.events).toMatchObject([{ kind: "MOVED", from: 60 }]); // a 3-point move, still tracked
    expect(step(at57.tracked, [ix({ conviction: 56 })]).events).toMatchObject([{ kind: "DROPPED", from: 57 }]);
  });

  it("announces a contract NEW once in its life", () => {
    const announced = new Set();
    const a = step({}, [ix({ conviction: 61 })], announced);
    expect(a.events[0].kind).toBe("NEW");
    announced.add("NIFTY|2026-10-27|21600|PE");
    const dropped = step(a.tracked, [ix({ conviction: 50 })], announced);
    expect(dropped.events[0].kind).toBe("DROPPED");
    const back = step(dropped.tracked, [ix({ conviction: 62 })], announced);
    expect(back.events).toEqual([]);                  // re-cross, any day: silent…
    expect(Object.keys(back.tracked)).toHaveLength(1); // …but tracked again
    expect(step(dropped.tracked, [ix({ conviction: 62 })], new Set()).events[0].kind).toBe("NEW"); // never announced
  });

  it("reports REMOVED only after two runs off the list", () => {
    const { tracked } = step({}, [ix()]);
    const one = step(tracked, []);
    expect(one.events).toEqual([]);
    expect(Object.keys(one.tracked)).toHaveLength(1);
    expect(step(one.tracked, []).events[0].kind).toBe("LEFT");
    // reappearing resets the count
    const back = step(one.tracked, [ix()]);
    expect(step(back.tracked, []).events).toEqual([]);
  });

  it("still reports an expiry-day disappearance at once", () => {
    const t = ix({ expiry: TODAY });
    expect(step({ [k(t)]: t }, []).events[0]).toMatchObject({ kind: "LEFT", expiring: true });
  });

  it("does not enter an index contract on its expiry day (never measured: archive entries are post-close)", () => {
    expect(step({}, [ix({ expiry: TODAY })]).events).toEqual([]);
    expect(step({}, [ix({ expiry: "2026-09-17" })]).events[0].kind).toBe("NEW");
  });

  it("keeps the announced set across days, prunes it at expiry, and reads the old per-day shape", () => {
    expect(loadAnnounced({ "NIFTY|2026-10-27|21600|PE": "2026-10-27", "NIFTY|2026-09-15|22000|CE": "2026-09-15" }, TODAY))
      .toEqual({ "NIFTY|2026-10-27|21600|PE": "2026-10-27" });
    expect(loadAnnounced({ date: "2026-09-15", keys: ["SENSEX|2026-10-08|76000|CE"] }, TODAY))
      .toEqual({ "SENSEX|2026-10-08|76000|CE": "2026-10-08" });
    expect(loadAnnounced(undefined, TODAY)).toEqual({});
  });

  it("lets only the best strike per underlying + expiry enter", () => {
    const a = ix({ strike: 21600, conviction: 63 }), b = ix({ strike: 21500, conviction: 66 }), c = ix({ strike: 21400, conviction: 66, cushion: 2 });
    const other = ix({ expiry: "2026-11-23", strike: 21000, conviction: 61 });
    const d = step({}, [a, b, c, other]);
    expect(d.events.map((e) => `${e.row.expiry} ${e.row.strike}`).sort()).toEqual(["2026-10-27 21400", "2026-11-23 21000"]);
    // When the best leaves, the next one up enters; the first stays tracked through its own row.
    const d2 = step(d.tracked, [a, b, ix({ strike: 21400, conviction: 50 }), other]);
    expect(d2.events.map((e) => [e.kind, e.row.strike])).toEqual([["NEW", 21500], ["DROPPED", 21400]]);
  });

  it("leaves stocks on the old behaviour", () => {
    expect(RULES.stocks).toEqual({ moveMin: 1, exitBuffer: 0, leftAfter: 1, bestPerCard: false, noExpiryDay: false });
  });
});

describe("collectIndices", () => {
  const snap = (asOf, conv = 61) => ({
    asOf, stale: false, name: "NIFTY 50", lotSize: 65,
    expiries: { "2026-10-27": { date: "2026-10-27", dte: 41, candidates: [{ strike: 21600, type: "PE", conviction: conv, ltp: 48.7 }] } },
  });

  it("marks an index fresh only when its asOf moved", () => {
    const c = collectIndices({ NIFTY: snap("2026-09-16T05:00:00Z") }, { NIFTY: "2026-09-16T05:00:00Z" });
    expect(c.anyFresh).toBe(false);
    const d = collectIndices({ NIFTY: snap("2026-09-16T05:10:00Z") }, { NIFTY: "2026-09-16T05:00:00Z" });
    expect(d.anyFresh).toBe(true);
    expect([...d.rows.values()][0]).toMatchObject({ kind: "Monthly", credit: 3166, displayed: true });
  });

  it("ignores a snapshot the builder marked stale", () => {
    expect(collectIndices({ NIFTY: { ...snap("2026-09-16T05:10:00Z"), stale: true } }).anyFresh).toBe(false);
  });
});

describe("collectStocks", () => {
  const file = (asOf) => ({
    asOf, index: "WIPRO", name: "Wipro", lotSize: 3000,
    expiries: { "2026-10-27": { date: "2026-10-27", dte: 41, candidates: [
      { strike: 190, type: "CE", conviction: 74, ltp: 1.09 },
      { strike: 200, type: "CE", conviction: 71, ltp: 0.6 },
    ] } },
  });
  const cands = { expiries: [{ slot: "next", candidates: [
    { symbol: "WIPRO", name: "Wipro", expiry: "2026-10-27", dte: 41, strike: 190, type: "CE", conviction: 74, ltp: 1.09, creditPerLot: 3270 },
  ] }] };

  it("marks only displayed rows as eligible to enter, but scores the rest", () => {
    const { rows } = collectStocks(cands, { WIPRO: file("2026-09-16T05:00:00Z") });
    expect(rows.get("WIPRO|2026-10-27|190|CE")).toMatchObject({ displayed: true, lot: 3000, credit: 3270 });
    expect(rows.get("WIPRO|2026-10-27|200|CE")).toMatchObject({ displayed: false, conviction: 71 });
  });

  it("treats a seeded, un-refreshed stock file as not fresh", () => {
    const { isFresh } = collectStocks({ expiries: [] }, { WIPRO: file("2026-09-16T04:00:00Z") }, "2026-09-16T04:30:00Z");
    expect(isFresh({ symbol: "WIPRO" })).toBe(false);
  });
});

describe("formatting", () => {
  it("escapes HTML and splits under Telegram's length cap", () => {
    const events = Array.from({ length: 200 }, (_, i) => ({ kind: "NEW", row: row({ strike: 100 + i, symbol: "M&M" }) }));
    const msgs = formatMessages(events, { source: "stocks", threshold: 70, when: "10:40" });
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(4096);
    expect(msgs[0]).toContain("M&amp;M");
    expect(msgs.join("").match(/\n\d+CE +72/g)).toHaveLength(200);
    for (const m of msgs) expect((m.match(/<pre>/g) ?? []).length).toBe((m.match(/<\/pre>/g) ?? []).length);
  });

  it("cites the archive basis on new index alerts only", () => {
    const idx = formatMessages([{ kind: "NEW", row: row({ source: "indices", symbol: "NIFTY", kind: "Monthly", cushion: 1.8 }) }],
      { source: "indices", threshold: 40, minCushion: 1.5, when: "10:40" });
    expect(idx[0]).toContain("index trades sold at 1.5σ+: 136 at conviction 40+, none finished in the money — only 7 so far at 60+");
    expect(idx[0]).not.toContain("unproven");
    const stk = formatMessages([{ kind: "NEW", row: row() }], { source: "stocks", threshold: 70, when: "10:40" });
    expect(stk[0]).not.toContain("index trades");
  });

  it("arming lists the starting set, and says so when it is empty", () => {
    const armed = formatMessages([{ kind: "NEW", row: row() }], { source: "stocks", threshold: 70, when: "09:20", armed: true });
    expect(armed[0]).toContain("Alerts armed");
    expect(armed[0]).toContain("<b>WIPRO · 27 Oct</b>");
    expect(armed[0]).toContain("190CE");
    expect(formatMessages([], { source: "stocks", threshold: 70, when: "09:20", armed: true })[0]).toContain("nothing above the bar");
    expect(formatMessages([], { source: "stocks", threshold: 70, when: "09:20" })).toEqual([]);
  });

  it("lays rows out as aligned columns, dividers and end-of-row marks outside the grid", () => {
    const t = table(["Contract", "Conv"], [
      { divider: "── 27 Oct ──" },
      { cells: ["IEX 125CE", 76], mark: "⭐" },
      { cells: ["BANKBARODA 250CE", 72] },
    ], ["l", "r"]).split("\n");
    expect(t).toEqual([
      "Contract         Conv",
      "── 27 Oct ──",
      "IEX 125CE          76 ⭐",
      "BANKBARODA 250CE   72",
    ]);
  });

  it("renders one card per underlying + expiry, every row with the same five columns", () => {
    const [m] = formatMessages([
      { kind: "NEW", row: row({ strike: 190, conviction: 76, spot: 167, pop: 0.934 }) },
      { kind: "DROPPED", from: 72, row: row({ strike: 150, type: "PE", conviction: 66, ltp: 1.55, credit: 4650, spot: 167, pop: 0.9 }) },
      { kind: "MOVED", from: 73, row: row({ strike: 185, conviction: 75, ltp: 1.61, credit: 4830, spot: 167, pop: 0.89 }) },
      { kind: "LEFT", from: 71, row: row({ strike: 200, conviction: 71, ltp: 0.8, credit: 2400 }) },
      { kind: "NEW", row: row({ symbol: "IEX", strike: 125, conviction: 71, lot: 4350, credit: 5742 }) },
    ], { source: "stocks", threshold: 70, when: "10:40", today: "2026-09-26" });
    expect(m).toContain("<b>WIPRO · 27 Oct</b>\n31 days left · lot 3,000");
    // WIPRO (NEW at 76) leads IEX (NEW at 71).
    expect(m.indexOf("WIPRO")).toBeLessThan(m.indexOf("IEX"));
    const pre = m.slice(m.indexOf("<pre>") + 5, m.indexOf("</pre>")).split("\n");
    // ROM: 3,270 ÷ (15% × 167 × 3,000 = 75,150) = 4.35%.
    expect(pre).toEqual([
      "NEW      CONV PREM ROM POP",
      "190CE      76 1.09 4.4  93",
      "",
      "MOVED    CONV PREM ROM POP",
      "185CE   73→75 1.61 6.4  89",
      "",
      "DROPPED  CONV PREM ROM POP",
      "150PE   72→66 1.55 6.2  90",
      "",
      "REMOVED  CONV PREM ROM POP",
      "200CE    71→–  0.8   –   –",
    ]);
    // Narrow enough for a phone held upright at a large text size: the owner's
    // screenshot scrolled sideways at ~30 characters.
    for (const l of pre) expect(l.length).toBeLessThanOrEqual(28);
  });

  it("shows – rather than a made-up ROM or POP when spot or pProfit is missing", () => {
    const [m] = formatMessages([{ kind: "NEW", row: row() }], { source: "stocks", threshold: 70, when: "10:40", today: "2026-09-26" });
    expect(m).toMatch(/190CE +72 1\.09 +– +–/);
  });

  it("index cards lead with cushion and carry ROM on the 8% index margin proxy", () => {
    const r = row({ source: "indices", symbol: "NIFTY", strike: 21600, type: "PE", kind: "Monthly",
      conviction: 43, ltp: 48.7, lot: 65, credit: 3166, spot: 23100, pop: 0.96, cushion: 1.82 });
    const [m] = formatMessages([{ kind: "NEW", row: r }, { kind: "MOVED", from: 44, row: { ...r, strike: 55000, type: "CE", ltp: 1234.5, conviction: 48, cushion: null } }],
      { source: "indices", threshold: 40, minCushion: 1.5, when: "10:40", today: "2026-09-26" });
    expect(m).toMatch(/NEW +CONV CUSH +PREM ROM POP/);
    // ROM: 3,166 ÷ (8% × 23,100 × 65 = 120,120) = 2.64%.
    expect(m).toMatch(/21600PE +43 +1\.82 +48\.7 +2\.6 +96/);
    expect(m).toMatch(/55000CE +44→48 +– +1,235/);
    expect(m).toContain("CUSH = distance to strike in forecast σ");
    expect(m).toContain("ROM % = credit ÷ capital (8% of spot × lot)");
    for (const l of m.match(/<pre>([\s\S]*?)<\/pre>/)[1].split("\n")) expect(l.length).toBeLessThanOrEqual(32);
  });

  it("carries spot and pProfit from the snapshot files into rows", () => {
    const idx = collectIndices({ NIFTY: { asOf: "2026-09-16T05:10:00Z", name: "NIFTY 50", lotSize: 65, spot: { price: 23100 },
      expiries: { "2026-10-27": { date: "2026-10-27", candidates: [{ strike: 21600, type: "PE", conviction: 63, ltp: 48.7, pProfit: 0.96 }] } } } });
    expect([...idx.rows.values()][0]).toMatchObject({ spot: 23100, pop: 0.96 });
  });

  it("end-of-day report lists every tracked contract, drops expired ones, and says None when empty", () => {
    const st = { day: { date: "2026-09-28", runs: 32, NEW: 1, MOVED: 0, DROPPED: 0, LEFT: 0 }, lastRunAt: "2026-09-28T10:15:00Z",
      tracked: {
        a: { ...row({ strike: 1040, type: "PE", conviction: 72, spot: 1252.6, pop: 0.96 }) },
        b: { ...row({ strike: 900, conviction: 71, expiry: "2026-09-25" }) }, // expired: left out
      } };
    const ix = { day: { date: "2026-09-28", runs: 74, NEW: 0, MOVED: 0, DROPPED: 0, LEFT: 0 }, tracked: {} };
    const [m] = formatEod(st, ix, "2026-09-28");
    expect(m.startsWith("📋 <b>Xerxes · end of day 28 Sep</b>")).toBe(true);
    expect(m).toContain("Stocks · conviction 70+ · ROM 5%+ · 5+ days · at the close (1)");
    expect(m).toMatch(/1040PE +72/);
    expect(m).not.toContain("900CE");
    expect(m).toMatch(/Indices · conviction 60\+ · cushion 1\.5σ\+ · at the close \(0\)<\/b>\nNone\./);
  });

  it("snapshot mode lists the same contracts under a snapshot heading, without run counts", () => {
    // 3,270 ÷ 75,150 = 4.35% < 5%: tracked, but not passing right now.
    const st = { tracked: { a: row({ conviction: 72, spot: 167, pop: 0.9, credit: 4000 }), b: row({ strike: 200, conviction: 71, spot: 167 }) } };
    const [m] = formatEod(st, { tracked: {} }, TODAY, DEFAULT_GATES, { snapshotAt: "13:15" });
    expect(m).not.toContain("200CE");
    expect(m.startsWith("📸 <b>Xerxes · snapshot 16 Sep</b>")).toBe(true);
    expect(m).toContain("as of the last run, 13:15 IST");
    expect(m).toContain("Stocks · conviction 70+ · ROM 5%+ · 5+ days · now (1)");
    expect(m).not.toContain("Runs");
  });

  it("heartbeat warns when a feed ran zero times today", () => {
    const s = bumpDay({ tracked: {} }, [], TODAY, "2026-09-16T10:10:00Z");
    expect(formatHeartbeat(s, s, TODAY)).toMatch(/^✓/);
    expect(formatHeartbeat(s, null, TODAY)).toContain("zero times");
  });
});

describe("results warning on stock cards", () => {
  // LAURUSLABS on 27 Oct: the 2360 CE (23 Nov) alert went out with results on
  // 29 Oct and nothing on the card said so.
  const TODAY27 = "2026-10-27";
  const fileEvents = [
    { kind: "Event priced in", date: "2026-10-27", approx: true, source: "options" },
    { kind: "Dividend", date: "2026-10-30", approx: false, source: "nse" },
    { kind: "Earnings call", date: "2026-10-29", approx: false, source: "news" },
    { kind: "Results", date: "2026-10-29", approx: false, source: "nse" },
  ];
  const laurus = (over = {}) => row({
    symbol: "LAURUSLABS", name: "Laurus Labs", expiry: "2026-11-23", dte: 27, strike: 2360, type: "CE",
    conviction: 73, ltp: 20.1, lot: 850, spot: 2141, pop: 0.93, earnings: earningsDates(fileEvents), ...over,
  });

  it("keeps results-type dates only, results first on a shared day", () => {
    expect(earningsDates(fileEvents)).toEqual([
      { kind: "Results", date: "2026-10-29" },
      { kind: "Earnings call", date: "2026-10-29" },
    ]);
    expect(earningsDates(undefined)).toEqual([]);
  });

  it("warns under the header when results land before the card's expiry", () => {
    const [m] = formatMessages([{ kind: "MOVED", from: 74, row: laurus() }], { source: "stocks", threshold: 70, when: "14:00", today: TODAY27 });
    expect(m).toContain("<b>LAURUSLABS · 23 Nov</b>\n27 days left · lot 850\n⚠️ <b>Results 29 Oct</b> (in 2 days) — before expiry");
    // Outside the <pre>: the rows keep their phone width.
    const pre = m.match(/<pre>([\s\S]*?)<\/pre>/)[1].split("\n");
    for (const l of pre) expect(l.length).toBeLessThanOrEqual(28);
  });

  it("says nothing when the results come after expiry or have already happened", () => {
    expect(earningsBefore([{ kind: "Results", date: "2026-11-04" }], "2026-10-27", "2026-10-20")).toBeNull();
    expect(earningsBefore([{ kind: "Results", date: "2026-10-16" }], "2026-11-23", TODAY27)).toBeNull();
    const [m] = formatMessages([{ kind: "NEW", row: laurus({ earnings: [{ kind: "Results", date: "2026-11-30" }] }) }],
      { source: "stocks", threshold: 70, when: "14:00", today: TODAY27 });
    expect(m).not.toContain("⚠️ <b>Results");
  });

  it("reads 'today' and 'tomorrow' plainly", () => {
    const at = (today) => formatMessages([{ kind: "NEW", row: laurus() }], { source: "stocks", threshold: 70, when: "10:00", today })[0];
    expect(at("2026-10-29")).toContain("(today) — before expiry");
    expect(at("2026-10-28")).toContain("(tomorrow) — before expiry");
  });

  it("flows from the stock file through tracking into the end-of-day report", () => {
    const f = {
      asOf: "2026-10-27T08:00:00Z", index: "LAURUSLABS", name: "Laurus Labs", lotSize: 850, events: fileEvents,
      expiries: { "2026-11-23": { date: "2026-11-23", dte: 27, candidates: [{ strike: 2360, type: "CE", conviction: 74, ltp: 20.85, pProfit: 0.93 }] } },
    };
    const cands = { expiries: [{ slot: "next", candidates: [
      { symbol: "LAURUSLABS", name: "Laurus Labs", expiry: "2026-11-23", dte: 27, strike: 2360, type: "CE", conviction: 74, ltp: 20.85, creditPerLot: 17723 },
    ] }] };
    const { rows } = collectStocks(cands, { LAURUSLABS: f });
    expect(rows.get("LAURUSLABS|2026-11-23|2360|CE").earnings).toEqual([
      { kind: "Results", date: "2026-10-29" }, { kind: "Earnings call", date: "2026-10-29" },
    ]);
    const { tracked } = diff({}, rows, { threshold: 70, today: TODAY27, isFresh: () => true });
    const [eod] = formatEod({ tracked }, { tracked: {} }, TODAY27);
    expect(eod).toContain("⚠️ <b>Results 29 Oct</b> (in 2 days) — before expiry");
  });

  it("never warns on index cards", () => {
    const [m] = formatMessages([{ kind: "NEW", row: row({ source: "indices", symbol: "NIFTY", cushion: 1.8, earnings: [{ kind: "Results", date: "2026-09-20" }] }) }],
      { source: "indices", threshold: 60, minCushion: 1.5, when: "10:40", today: TODAY });
    expect(m).not.toContain("⚠️ <b>Results");
  });
});

describe("premium feed (stocks-sharp, 2026-11-01)", () => {
  // WIPRO lot 3,000 at spot 167: 4,500 credit = 6% ROM; 1.30σ cushion; 41 days.
  const ok = (over = {}) => row({ spot: 167, credit: 4500, cushion: 1.3, nextResults: null, ...over });
  const SHARP_GATE = { threshold: DEFAULT_GATES[SHARP], minRom: DEFAULT_GATES.rom[SHARP],
    minCushion: DEFAULT_GATES.cushion[SHARP], minDte: DEFAULT_GATES.dte[SHARP], skipResults: DEFAULT_GATES.results[SHARP] };
  const STOCK_GATE = { threshold: 70, minRom: 5, minDte: 5 };
  const go = (r, gate) => diff({}, cur(r), { today: TODAY, isFresh: always, ...gate }).events.map((e) => e.kind);

  it("defaults to conviction 70 · ROM 5% · cushion 1.25σ · 5 days · no results before expiry", () => {
    expect(SHARP_GATE).toEqual({ threshold: 70, minRom: 5, minCushion: 1.25, minDte: 5, skipResults: true });
    expect(gateText(SHARP_GATE, SHARP)).toBe("conviction 70+ · cushion 1.25σ+ · ROM 5%+ · 5+ days · no results before expiry");
  });

  it("leaves the existing stock and index gates untouched", () => {
    expect(DEFAULT_GATES).toMatchObject({ stocks: 70, indices: 60, rom: { stocks: 5, indices: 0 },
      cushion: { stocks: 0, indices: 1.5 }, dte: { stocks: 5, indices: 0 }, results: { stocks: false, indices: false } });
    expect(RULES[SHARP]).toEqual(RULES.stocks);
    expect(FEEDS[SHARP].data).toBe("stocks");
  });

  it("cushion 1.25 enters, 1.24 does not; the forecast cushion is the one gated", () => {
    expect(go(ok({ cushion: 1.25 }), SHARP_GATE)).toEqual(["NEW"]);
    expect(go(ok({ cushion: 1.24 }), SHARP_GATE)).toEqual([]);
    expect(go(ok({ cushion: null }), SHARP_GATE)).toEqual([]); // can't verify → no
  });

  it("each of conviction, ROM and days still binds", () => {
    expect(go(ok({ conviction: 69 }), SHARP_GATE)).toEqual([]);
    expect(go(ok({ credit: 3680 }), SHARP_GATE)).toEqual([]); // ROM 4.9%
    expect(go(ok({ dte: 4 }), SHARP_GATE)).toEqual([]);
  });

  it("skips a contract with a Results date inside its life, today included", () => {
    expect(go(ok({ nextResults: "2026-10-20" }), SHARP_GATE)).toEqual([]);
    expect(go(ok({ nextResults: TODAY }), SHARP_GATE)).toEqual([]);
    // The same contract still alerts on the existing stock feed.
    expect(go(ok({ nextResults: "2026-10-20" }), STOCK_GATE)).toEqual(["NEW"]);
  });

  it("falls back to the stock file's Results events when the stamp is missing", () => {
    const r = ok({ nextResults: undefined, earnings: [{ kind: "Board meeting", date: "2026-10-01" }, { kind: "Results", date: "2026-10-20" }] });
    expect(resultsInLife(r, TODAY)).toBe("2026-10-20");
    expect(go(r, SHARP_GATE)).toEqual([]);
    // Results after expiry, or only a board meeting inside it: not a block.
    expect(resultsInLife(ok({ nextResults: undefined, earnings: [{ kind: "Results", date: "2026-11-05" }] }), TODAY)).toBeNull();
    expect(go(ok({ nextResults: undefined, earnings: [{ kind: "Board meeting", date: "2026-10-01" }] }), SHARP_GATE)).toEqual(["NEW"]);
  });

  it("is an entry gate only: a tracked contract is kept when cushion, ROM or results change", () => {
    const tracked = { [k(ok())]: { ...ok(), reported: 72 } };
    const later = ok({ conviction: 73, cushion: 0.8, credit: 1500, nextResults: "2026-10-20" });
    const d = diff(tracked, cur(later), { today: TODAY, isFresh: always, ...SHARP_GATE });
    expect(d.events.map((e) => e.kind)).toEqual(["MOVED"]);
    expect(Object.keys(d.tracked)).toEqual([k(ok())]);
  });

  it("collectStocks carries the results stamp and the full candidate for the card", () => {
    const c = { symbol: "WIPRO", name: "Wipro", expiry: "2026-10-27", dte: 41, strike: 190, type: "CE",
      conviction: 72, ltp: 1.5, creditPerLot: 4500, nextResults: "2026-10-20", cushionSigmaF: 1.3 };
    const { rows } = collectStocks({ expiries: [{ slot: "current", candidates: [c] }] }, {});
    const r = rows.get("WIPRO|2026-10-27|190|CE");
    expect(r.nextResults).toBe("2026-10-20");
    expect(r.cand).toBe(c);
    expect(r.source).toBe("stocks"); // the margin proxy key, not the feed key
    expect(r.quotedAt).toBeNull(); // nothing stamped: no time is invented
    const stamped = collectStocks({ expiries: [{ slot: "current", candidates: [{ ...c, quotedAt: "2026-10-07T07:12:40Z" }] }] }, {});
    expect(stamped.rows.get("WIPRO|2026-10-27|190|CE").quotedAt).toBe("2026-10-07T07:12:40Z");
  });

  it("follow-up messages carry the premium header and gate", () => {
    const [m] = formatMessages([{ kind: "MOVED", from: 72, row: ok({ conviction: 75 }) }],
      { source: SHARP, ...SHARP_GATE, when: "10:40", today: TODAY });
    expect(m.startsWith("💎 <b>Xerxes · Premium</b> · 10:40 IST")).toBe(true);
    expect(m).toContain("no results before expiry");
    expect(m).toContain("ROM % = credit ÷ capital (15% of spot × lot)");
  });
});

describe("premium feed in the end-of-day report", () => {
  const D = "2026-09-28";
  const day = (runs, extra = {}) => ({ day: { date: D, runs, NEW: 0, MOVED: 0, DROPPED: 0, LEFT: 0 }, ...extra });
  const prem = row({ strike: 195, conviction: 74, spot: 167, credit: 4500, cushion: 1.4, pop: 0.94 });
  const st = day(30, { lastRunAt: "2026-09-28T10:05:00Z", tracked: { a: row({ strike: 1040, type: "PE", conviction: 72, spot: 1252.6 }) } });
  const ix = day(70, { tracked: {} });
  const sharp = day(30, { lastRunAt: "2026-09-28T09:45:00Z", tracked: { p: prem } });

  it("leads with the premium list, then stocks, then indices", () => {
    const [m] = formatEod(st, ix, D, DEFAULT_GATES, { sharpState: sharp });
    const iP = m.indexOf("💎 <b>Premium · conviction 70+ · cushion 1.25σ+ · ROM 5%+ · 5+ days · no results before expiry · at the close (1)</b>");
    const iS = m.indexOf("📈 <b>Stocks · conviction 70+");
    const iI = m.indexOf("🏛 <b>Indices ·");
    expect(iP).toBeGreaterThan(0);
    expect(iP).toBeLessThan(iS);
    expect(iS).toBeLessThan(iI);
    expect(m).toMatch(/195CE +74/);
  });

  it("adds a Premium row to the run counts and its last run time", () => {
    const [m] = formatEod(st, ix, D, DEFAULT_GATES, { sharpState: sharp });
    expect(m).toMatch(/Premium +30/);
    expect(m).toContain("Last run: stocks 15:35 · indices — · premium 15:15 IST");
  });

  it("warns when the premium step ran zero times while stocks ran", () => {
    expect(formatHeartbeat(st, ix, D, day(0))).toContain("premium feed ran zero times");
    expect(formatHeartbeat(st, ix, D, null)).toContain("premium feed ran zero times");
    expect(formatHeartbeat(st, ix, D, sharp)).toMatch(/^✓/);
    expect(formatHeartbeat(st, ix, D)).not.toContain("Premium"); // not passed: two-feed report as before
  });

  it("says None when nothing premium is held, and the snapshot re-applies the results rule", () => {
    const [none] = formatEod(st, ix, D, DEFAULT_GATES, { sharpState: day(30, { tracked: {} }) });
    expect(none).toMatch(/Premium · .* at the close \(0\)<\/b>\nNone\./);
    // Tracked before a Results date was known; the snapshot (which re-applies the
    // whole entry gate) leaves it out once results fall inside its life.
    const late = day(30, { tracked: { p: { ...prem, earnings: [{ kind: "Results", date: "2026-10-05" }] } } });
    const [snap] = formatEod(st, ix, D, DEFAULT_GATES, { snapshotAt: "13:15", sharpState: late });
    expect(snap).toContain("Premium · conviction 70+ · cushion 1.25σ+ · ROM 5%+ · 5+ days · no results before expiry · now (0)");
    const [eod] = formatEod(st, ix, D, DEFAULT_GATES, { sharpState: late });
    expect(eod).toMatch(/195CE +74/); // the close lists everything still tracked at 70+
  });
});

describe("results announced after a premium card (2026-11-04)", () => {
  // The RVNL case: cards on 2 and 3 Nov, NSE listed results for 13 Nov on 4 Nov.
  const NOW = "2026-11-04";
  const announced = { "RVNL|2026-11-23|202.5|CE": "2026-11-23", "RVNL|2026-11-23|205|CE": "2026-11-23", "IRFC|2026-12-29|88|CE": "2026-12-29" };
  const earningsOf = { RVNL: [{ kind: "Results", date: "2026-11-13" }], IRFC: [] };

  it("warns for every carded contract whose life now holds a Results date, tracked or not", () => {
    const w = resultsWarnings(announced, earningsOf, {}, NOW);
    expect(w.map((x) => x.key)).toEqual(["RVNL|2026-11-23|202.5|CE", "RVNL|2026-11-23|205|CE"]);
    expect(w[0]).toMatchObject({ symbol: "RVNL", strike: 202.5, type: "CE", expiry: "2026-11-23", date: "2026-11-13" });
  });

  it("warns once per contract and date, and again if the date moves", () => {
    const warned = { "RVNL|2026-11-23|202.5|CE": "2026-11-13", "RVNL|2026-11-23|205|CE": "2026-11-13" };
    expect(resultsWarnings(announced, earningsOf, warned, NOW)).toEqual([]);
    const moved = resultsWarnings(announced, { RVNL: [{ kind: "Results", date: "2026-11-14" }] }, warned, NOW);
    expect(moved.map((x) => x.date)).toEqual(["2026-11-14", "2026-11-14"]);
  });

  it("ignores results outside the trade's life, other event kinds and expired contracts", () => {
    expect(resultsWarnings(announced, { RVNL: [{ kind: "Results", date: "2026-11-24" }] }, {}, NOW)).toEqual([]); // after expiry
    expect(resultsWarnings(announced, { RVNL: [{ kind: "Results", date: "2026-11-03" }] }, {}, NOW)).toEqual([]); // already past
    expect(resultsWarnings(announced, { RVNL: [{ kind: "Board meeting", date: "2026-11-13" }] }, {}, NOW)).toEqual([]);
    expect(resultsWarnings(announced, earningsOf, {}, "2026-11-24")).toEqual([]); // expired
    expect(resultsWarnings(announced, { RVNL: [{ kind: "Results", date: "2026-11-23" }] }, {}, NOW)).toHaveLength(2); // expiry day counts
  });

  it("reads the contract's current quote from the stock file's chain", () => {
    const f = { index: "RVNL", spot: { price: 190.31 }, expiries: { a: { date: "2026-11-23", chain: [
      { strike: 202.5, type: "PE", ltp: 14.1 }, { strike: 202.5, type: "CE", ltp: 2.93, bid: 2.96, ask: 3 }] } } };
    expect(chainQuote(f, "2026-11-23", 202.5, "CE")).toEqual({ ltp: 2.93, bid: 2.96, ask: 3, spot: 190.31 });
    expect(chainQuote(f, "2026-12-29", 202.5, "CE")).toBeNull();
    expect(chainQuote(undefined, "2026-11-23", 202.5, "CE")).toBeNull();
  });

  it("says when results land, how far before expiry, and the card price against now", () => {
    const w = resultsWarnings(announced, earningsOf, {}, NOW);
    const m = formatResultsWarnings(w, { when: "09:35", today: NOW,
      quotes: { [w[0].key]: { ltp: 2.93, bid: 2.96, ask: 3, spot: 190.31 } },
      cards: { [w[0].key]: { ltp: 2.25, date: "2026-11-02" } } });
    expect(m.startsWith("💎 <b>Xerxes · Premium</b> · 09:35 IST\n⚠️ <b>Results announced before your expiry</b>")).toBe(true);
    expect(m).toContain("<b>RVNL 202.5 CE · 23 Nov</b>\nResults <b>Fri 13 Nov</b> (in 9 days), 10 days before expiry");
    expect(m).toContain("Card at ₹2.25 (2 Nov) · now ₹2.93 (bid 2.96 / ask 3.00)");
    expect(m).toContain("Spot ₹190.31 · strike 6.4% away");
    // The 205 CE has no quote or card price on hand: those lines are left out, not guessed.
    expect(m).toMatch(/<b>RVNL 205 CE · 23 Nov<\/b>\nResults <b>Fri 13 Nov<\/b> \(in 9 days\), 10 days before expiry\n\n<i>/);
    expect(formatResultsWarnings([], { when: "09:35", today: NOW })).toBeNull();
  });

  it("collectStocks exposes each stock's results dates", () => {
    const { earningsOf: e } = collectStocks({ expiries: [] }, { RVNL: { index: "RVNL", events: [{ kind: "Results", date: "2026-11-13", source: "nse" }] } });
    expect(e.RVNL).toEqual([{ kind: "Results", date: "2026-11-13" }]);
  });
});

describe("premium remembers results dates (KALYANKJIL, 9 Nov)", () => {
  const D = "2026-11-09";
  const GATE = { threshold: 70, minRom: 5, minCushion: 1.25, minDte: 5, skipResults: true };
  // KALYANKJIL 680 CE as scored at 15:01: the run's data had lost the 10 Nov date.
  const kal = (over = {}) => row({ symbol: "KALYANKJIL", expiry: "2026-11-23", dte: 14, strike: 680, type: "CE",
    conviction: 72, ltp: 9, lot: 125, credit: 6000, spot: 611, cushion: 1.4, nextResults: null, earnings: [], ...over });

  it("adds what each run sees and keeps it until the day passes", () => {
    const k1 = rememberResults({}, { KALYANKJIL: [{ kind: "Results", date: "2026-11-10" }, { kind: "Board meeting", date: "2026-11-10" }] }, D);
    expect(k1).toEqual({ KALYANKJIL: ["2026-11-10"] });
    expect(rememberResults(k1, { KALYANKJIL: [] }, D)).toEqual({ KALYANKJIL: ["2026-11-10"] }); // lost from the data: still known
    expect(rememberResults(k1, {}, "2026-11-11")).toEqual({}); // passed: forgotten
    expect(rememberResults({ RVNL: ["2026-11-13"] }, { RVNL: [{ kind: "Results", date: "2026-11-12" }] }, D))
      .toEqual({ RVNL: ["2026-11-12", "2026-11-13"] });
  });

  it("a remembered date closes the gate when the run's own data has lost it", () => {
    const rows = cur(kal());
    expect(diff({}, rows, { today: D, isFresh: always, ...GATE }).events.map((e) => e.kind)).toEqual(["NEW"]); // the bug
    applyKnownResults(rows, { KALYANKJIL: ["2026-11-10"] }, D);
    expect([...rows.values()][0].nextResults).toBe("2026-11-10");
    expect(diff({}, rows, { today: D, isFresh: always, ...GATE }).events).toEqual([]); // fixed
  });

  it("only stamps dates inside the row's life, and only earlier than what it already has", () => {
    const rows = cur(kal({ nextResults: "2026-11-20" }), kal({ strike: 700, expiry: "2026-11-08", dte: 0 }));
    applyKnownResults(rows, { KALYANKJIL: ["2026-11-10"] }, D);
    const [a, b] = [...rows.values()];
    expect(a.nextResults).toBe("2026-11-10");
    expect(b.nextResults).toBeNull(); // expired before the date
  });
});
