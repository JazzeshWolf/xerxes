import { describe, it, expect } from "vitest";
import {
  isMonthly, table, collectStocks, collectIndices, diff, formatMessages, formatHeartbeat, bumpDay, tierMark,
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
  it("marks stock tiers but never index ones", () => {
    expect(tierMark("stocks", 80)).toBe("🔥");
    expect(tierMark("stocks", 76)).toBe("⭐");
    expect(tierMark("stocks", 72)).toBe("");
    expect(tierMark("indices", 85)).toBe("");
  });

  it("escapes HTML and splits under Telegram's length cap", () => {
    const events = Array.from({ length: 200 }, (_, i) => ({ kind: "NEW", row: row({ strike: 100 + i, symbol: "M&M" }) }));
    const msgs = formatMessages(events, { source: "stocks", threshold: 70, when: "10:40" });
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(4096);
    expect(msgs[0]).toContain("M&amp;M");
    expect(msgs.join("").match(/\n\d+ CE +72/g)).toHaveLength(200);
    for (const m of msgs) expect((m.match(/<pre>/g) ?? []).length).toBe((m.match(/<\/pre>/g) ?? []).length);
  });

  it("carries the unproven caveat on new index alerts only", () => {
    const idx = formatMessages([{ kind: "NEW", row: row({ source: "indices", symbol: "NIFTY", kind: "Monthly" }) }], { source: "indices", threshold: 60, when: "10:40" });
    expect(idx[0]).toContain("unproven");
    const stk = formatMessages([{ kind: "NEW", row: row() }], { source: "stocks", threshold: 70, when: "10:40" });
    expect(stk[0]).not.toContain("unproven");
  });

  it("arming lists the starting set, and says so when it is empty", () => {
    const armed = formatMessages([{ kind: "NEW", row: row() }], { source: "stocks", threshold: 70, when: "09:20", armed: true });
    expect(armed[0]).toContain("Alerts armed");
    expect(armed[0]).toContain("<b>WIPRO · 27 Oct</b>");
    expect(armed[0]).toContain("190 CE");
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

  it("renders one card per underlying + expiry, with aligned NEW / OUT / MOVED sections", () => {
    const [m] = formatMessages([
      { kind: "NEW", row: row({ strike: 190, conviction: 76 }) },
      { kind: "DROPPED", from: 72, row: row({ strike: 150, type: "PE", conviction: 66 }) },
      { kind: "MOVED", from: 73, row: row({ strike: 185, conviction: 75, ltp: 1.61 }) },
      { kind: "NEW", row: row({ symbol: "IEX", strike: 125, conviction: 71, lot: 4350, credit: 5742 }) },
    ], { source: "stocks", threshold: 70, when: "10:40", today: "2026-09-26" });
    expect(m).toContain("<b>WIPRO · 27 Oct</b> · 31d left · lot 3,000");
    // WIPRO (NEW at 76) leads IEX (NEW at 71).
    expect(m.indexOf("WIPRO")).toBeLessThan(m.indexOf("IEX"));
    const pre = m.slice(m.indexOf("<pre>") + 5, m.indexOf("</pre>")).split("\n");
    expect(pre).toEqual([
      "NEW     CONV PREM CREDIT",
      "190 CE    76 1.09  3,270 ⭐",
      "",
      "OUT     CONV REASON",
      "150 PE 72&gt;66 below 70",
      "",
      "MOVED   CONV PREM    CHG",
      "185 CE 73&gt;75 1.61     +2",
    ]);
  });

  it("heartbeat warns when a feed ran zero times today", () => {
    const s = bumpDay({ tracked: {} }, [], TODAY, "2026-09-16T10:10:00Z");
    expect(formatHeartbeat(s, s, TODAY)).toMatch(/^✓/);
    expect(formatHeartbeat(s, null, TODAY)).toContain("zero times");
  });
});
