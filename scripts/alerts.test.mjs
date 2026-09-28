import { describe, it, expect } from "vitest";
import {
  isMonthly, table, inAlertWindow, formatEod, collectStocks, collectIndices, diff, formatMessages, formatHeartbeat, bumpDay,
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

  it("prices index ROM on the 8% index margin proxy, not the stock 15%", () => {
    const r = row({ source: "indices", symbol: "NIFTY", strike: 21600, type: "PE", kind: "Monthly",
      conviction: 63, ltp: 48.7, lot: 65, credit: 3166, spot: 23100, pop: 0.96 });
    const [m] = formatMessages([{ kind: "NEW", row: r }], { source: "indices", threshold: 60, when: "10:40", today: "2026-09-26" });
    // 3,166 ÷ (8% × 23,100 × 65 = 120,120) = 2.64%
    expect(m).toMatch(/21600PE +63 +48\.7 +2\.6 +96/);
    expect(m).toContain("8% of spot × lot");
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
    expect(m).toContain("Stocks at 70+ at the close (1)");
    expect(m).toMatch(/1040PE +72/);
    expect(m).not.toContain("900CE");
    expect(m).toMatch(/Indices at 60\+ at the close \(0\)<\/b>\nNone\./);
  });

  it("heartbeat warns when a feed ran zero times today", () => {
    const s = bumpDay({ tracked: {} }, [], TODAY, "2026-09-16T10:10:00Z");
    expect(formatHeartbeat(s, s, TODAY)).toMatch(/^✓/);
    expect(formatHeartbeat(s, null, TODAY)).toContain("zero times");
  });
});
