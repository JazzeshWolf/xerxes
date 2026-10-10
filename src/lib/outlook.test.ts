import { describe, it, expect } from "vitest";
import { median, sectorMedian, splitMove, moveReading, vsExpiry, mergeLiveNews, priceMovingNews } from "./outlook";
import type { LiveNews, Snapshot, StockRow } from "./types";

const row = (symbol: string, changePct: number | null, w1: number | null = null): StockRow =>
  ({ symbol, changePct, perf: { d1: changePct, w1, m1: null, m3: null } }) as StockRow;

describe("stock outlook helpers", () => {
  it("median ignores nulls and handles even counts", () => {
    expect(median([3, null, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([null])).toBeNull();
  });

  it("sectorMedian includes the stock, so one outlier can't taint its neighbours", () => {
    const sector = [row("BHEL", 5), row("LT", 0.4), row("ABB", 0.3)];
    expect(sectorMedian(sector, "d1")).toBe(0.4); // the same answer from LT's page and BHEL's
    expect(sectorMedian(sector, "w1")).toBeNull(); // older index.json: no perf
    expect(sectorMedian(sector.slice(0, 2), "d1")).toBeNull(); // 2 names: no robust median
  });

  it("splitMove always sums back to the stock's move", () => {
    const s = splitMove(2.5, 1, 1.2, 1.5)!;
    expect(s.market).toBeCloseTo(1.2);
    expect(s.sector).toBeCloseTo(0.5);
    expect(s.own).toBeCloseTo(0.8);
    expect(s.market + s.sector + s.own).toBeCloseTo(2.5);
    // No peers → no sector part; no market → no split at all.
    expect(splitMove(2, 1, null, null)!.sector).toBe(0);
    expect(splitMove(2, null, 1, 1)).toBeNull();
  });

  it("moveReading names the dominant driver", () => {
    expect(moveReading(splitMove(4, 0.2, 1, 0.3)!)).toMatch(/own story/);
    expect(moveReading(splitMove(-1.6, -1.5, 1, -1.5)!)).toMatch(/Mostly the market/);
    expect(moveReading(splitMove(0.1, 0.05, 1, 0.1)!)).toMatch(/quiet/);
  });

  it("vsExpiry places an event against the selected expiry", () => {
    expect(vsExpiry("2026-10-14", "2026-10-27")).toBe("before");
    expect(vsExpiry("2026-10-27", "2026-10-27")).toBe("on");
    expect(vsExpiry("2026-11-02", "2026-10-27")).toBe("after");
    expect(vsExpiry(null, "2026-10-27")).toBeNull();
  });

  it("priceMovingNews keeps directional or eventful headlines", () => {
    const n = (title: string, impact: "up" | "down" | "twoway") => ({ title, impact, url: title, source: "x", trusted: true, publishedAt: "", snippet: "" });
    const out = priceMovingNews([n("Stocks to watch today", "twoway"), n("BHEL bags order", "twoway"), n("BHEL shares surge", "up")]);
    expect(out.map((x) => x.title)).toEqual(["BHEL bags order", "BHEL shares surge"]);
  });
});

describe("mergeLiveNews", () => {
  const snap = {
    index: "BHEL",
    newsAsOf: "2026-10-09T10:00:00Z",
    news: [{ title: "old", url: "o" }],
    events: [
      { kind: "Results", title: "Financial Results", date: "2026-10-14", approx: false, source: "nse" },
      { kind: "Event priced in", title: "…", date: "2026-10-27", approx: true, source: "options" },
      { kind: "Dividend", title: "old headline", date: null, approx: true, source: "news" },
    ],
    filings: [{ kind: "Order win", title: "cached", publishedAt: "2026-10-08T00:00:00Z", url: null }],
  } as unknown as Snapshot;
  const live = (over: Partial<LiveNews> = {}): LiveNews => ({
    symbol: "BHEL",
    newsAsOf: "2026-10-10T05:00:00Z",
    news: [{ title: "fresh", url: "f", source: "x", trusted: true, publishedAt: "", snippet: "", impact: "up" }],
    events: [],
    filings: [],
    nseOk: false,
    ...over,
  });

  it("replaces headlines and keeps what the Worker can't see", () => {
    const m = mergeLiveNews(snap, live());
    expect(m.news!.map((n) => n.title)).toEqual(["fresh"]);
    expect(m.newsAsOf).toBe("2026-10-10T05:00:00Z");
    // NSE didn't answer live → its dates and filings survive; options window always does.
    expect(m.events!.map((e) => e.kind)).toEqual(["Results", "Event priced in"]);
    expect(m.filings!.map((f) => f.title)).toEqual(["cached"]);
  });

  it("takes live NSE data when NSE answered", () => {
    const m = mergeLiveNews(
      snap,
      live({ nseOk: true, events: [{ kind: "Results", title: "Board meeting", date: "2026-10-15", approx: false, source: "nse" }], filings: [] }),
    );
    expect(m.events!.map((e) => `${e.kind} ${e.date}`)).toEqual(["Results 2026-10-15", "Event priced in 2026-10-27"]);
    expect(m.filings).toEqual([]);
  });

  it("a failed Google fetch neither wipes the list nor claims freshness", () => {
    const m = mergeLiveNews(snap, live({ news: [] }));
    expect(m.news!.map((n) => n.title)).toEqual(["old"]);
    expect(m.newsAsOf).toBe("2026-10-09T10:00:00Z");
  });

  it("ignores a stale or mismatched answer", () => {
    expect(mergeLiveNews(snap, live({ newsAsOf: "2026-10-01T00:00:00Z" }))).toBe(snap);
    expect(mergeLiveNews(snap, live({ symbol: "SBIN" }))).toBe(snap);
  });
});
