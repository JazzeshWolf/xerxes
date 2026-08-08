import { describe, it, expect } from "vitest";
import { parseEventDate, classifyEvent, mentionsCompany, mergeEvents, impliedEvent, ambiguousFirstWords, pruneEvents } from "./stock-news.mjs";
import { STOCKS } from "./stocks-universe.mjs";

// Fixed reference so "28 Aug" resolves deterministically.
const NOW = Date.UTC(2026, 7, 8); // 8 Aug 2026

describe("parseEventDate", () => {
  it("reads both day-month and month-day orders", () => {
    expect(parseEventDate("Q1 results on 28 Aug", NOW)).toBe("2026-08-28");
    expect(parseEventDate("board meeting Sept 3", NOW)).toBe("2026-09-03");
    expect(parseEventDate("results 28th August 2026", NOW)).toBe("2026-08-28");
  });
  it("rolls a long-past bare month forward to next year", () => {
    // In August, a bare "15 Feb" means next February, not six months ago.
    expect(parseEventDate("board meeting 15 Feb", NOW)).toBe("2027-02-15");
    // But a month just behind us is still this year.
    expect(parseEventDate("results 30 Jul", NOW)).toBe("2026-07-30");
  });
  it("returns null on no date and on impossible dates", () => {
    expect(parseEventDate("board meeting scheduled", NOW)).toBeNull();
    expect(parseEventDate("results on 31 Feb", NOW)).toBeNull();
    expect(parseEventDate("", NOW)).toBeNull();
    expect(parseEventDate(null, NOW)).toBeNull();
  });
});

describe("classifyEvent", () => {
  it("recognises the event types that move a single stock", () => {
    expect(classifyEvent("Infosys Q2 results date announced")).toBe("Results");
    expect(classifyEvent("board meeting to consider fund raising")).toBe("Board meeting");
    expect(classifyEvent("declares interim dividend of Rs 5")).toBe("Dividend");
    expect(classifyEvent("announces Rs 1000 cr buyback")).toBe("Buyback");
    expect(classifyEvent("approves stock split in 1:5 ratio")).toBe("Stock split");
  });
  it("ignores ordinary price commentary", () => {
    expect(classifyEvent("shares rise 3% on strong volumes")).toBeNull();
  });
});

describe("mentionsCompany", () => {
  it("accepts the ticker or the distinctive part of the name", () => {
    expect(mentionsCompany("MANAPPURAM Finance gains 4%", "MANAPPURAM", "Manappuram Finance")).toBe(true);
    expect(mentionsCompany("Adani Green wins solar order", "ADANIGREEN", "Adani Green")).toBe(true);
  });
  it("rejects a headline that never names the company", () => {
    // The guard that stops an OR-query dragging in unrelated market chatter.
    expect(mentionsCompany("Nifty ends higher on banking gains", "ADANIGREEN", "Adani Green")).toBe(false);
    // Generic corporate words alone must not count as a match.
    expect(mentionsCompany("India Industries Ltd reports profit", "ADANIGREEN", "Adani Green")).toBe(false);
  });
});

describe("mergeEvents", () => {
  const nse = { kind: "Results", title: "Quarterly Results", date: "2026-08-28", approx: false, source: "nse" };
  const news = { kind: "Results", title: "Q1 results on 28 Aug", date: "2026-08-28", approx: false, source: "news" };
  const undated = { kind: "Results", title: "results awaited", date: null, approx: true, source: "news" };

  it("prefers the NSE entry when two sources agree on a date", () => {
    const out = mergeEvents([news], [nse]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("nse");
  });
  it("drops an undated entry once the same kind has a date", () => {
    expect(mergeEvents([undated], [nse]).map((e) => e.date)).toEqual(["2026-08-28"]);
  });
  it("keeps an undated entry when nothing else dates that kind", () => {
    expect(mergeEvents([undated])).toHaveLength(1);
  });
  it("sorts soonest first, undated last", () => {
    const later = { ...nse, date: "2026-09-30", kind: "AGM" };
    const out = mergeEvents([later, nse, { ...undated, kind: "Buyback" }]);
    expect(out.map((e) => e.kind)).toEqual(["Results", "AGM", "Buyback"]);
  });
});

describe("impliedEvent", () => {
  it("fires only when the front month is meaningfully bid over the next", () => {
    expect(impliedEvent(6, "2026-08-25")).not.toBeNull();
    expect(impliedEvent(6, "2026-08-25").source).toBe("options");
    expect(impliedEvent(6, "2026-08-25").approx).toBe(true); // a window, never a date
    expect(impliedEvent(1, "2026-08-25")).toBeNull(); // flat term structure
    expect(impliedEvent(-4, "2026-08-25")).toBeNull(); // contango
    expect(impliedEvent(null, "2026-08-25")).toBeNull();
    expect(impliedEvent(6, null)).toBeNull();
  });
});

describe("stocks universe", () => {
  it("tags every name with a sector", () => {
    // A missing tag silently drops the stock out of its peer group, which is
    // invisible in the UI — so it's asserted rather than eyeballed.
    const bad = STOCKS.filter((r) => r.length !== 3 || typeof r[2] !== "string" || !r[2].trim());
    expect(bad.map((r) => r[0])).toEqual([]);
  });
  it("has no duplicate symbols", () => {
    const syms = STOCKS.map((r) => r[0]);
    expect(syms.length).toBe(new Set(syms).size);
  });
});

describe("ambiguous company names", () => {
  const ambiguous = ambiguousFirstWords(STOCKS);

  it("derives shared first words from the universe itself", () => {
    // Multiple Bajaj / Adani / Tata entities are all in F&O, so counting finds them.
    expect(ambiguous.has("bajaj")).toBe(true);
    expect(ambiguous.has("adani")).toBe(true);
    expect(ambiguous.has("tata")).toBe(true);
    // A one-of-a-kind name is not ambiguous.
    expect(ambiguous.has("manappuram")).toBe(false);
    expect(ambiguous.has("hindalco")).toBe(false);
  });

  it("also covers houses whose other arms are outside the F&O universe", () => {
    // Only Reliance Industries is in F&O, so counting alone would miss that
    // "Reliance" identifies nobody — Reliance Power's results matched it live.
    expect(ambiguous.has("reliance")).toBe(true);
  });

  it("stops another company's news being filed under a shared prefix", () => {
    // Seen live: "Reliance Power Q1 Results" was landing on RELIANCE.
    const other = "Reliance Power Q1 Results: PAT jumps 44%";
    expect(mentionsCompany(other, "RELIANCE", "Reliance Industries", ambiguous)).toBe(false);
    // The real thing still matches, by full name or by ticker.
    expect(mentionsCompany("Reliance Industries posts record profit", "RELIANCE", "Reliance Industries", ambiguous)).toBe(true);
    expect(mentionsCompany("RELIANCE gains 2% on volumes", "RELIANCE", "Reliance Industries", ambiguous)).toBe(true);
  });

  it("leaves unambiguous names matching on their distinctive word", () => {
    expect(mentionsCompany("Manappuram gains 4% after results", "MANAPPURAM", "Manappuram Finance", ambiguous)).toBe(true);
  });
});

describe("pruneEvents", () => {
  const NOW2 = Date.UTC(2026, 7, 8);
  it("drops events that have gone by but keeps a recent one", () => {
    const kept = pruneEvents(
      [
        { kind: "Results", date: "2005-01-28", source: "nse" }, // ancient
        { kind: "Results", date: "2026-08-05", source: "nse" }, // 3 days ago
        { kind: "Board meeting", date: "2026-09-01", source: "nse" }, // upcoming
      ],
      NOW2,
    );
    expect(kept.map((e) => e.date)).toEqual(["2026-08-05", "2026-09-01"]);
  });
  it("keeps undated entries, since nothing better has dated them yet", () => {
    expect(pruneEvents([{ kind: "Buyback", date: null, source: "news" }], NOW2)).toHaveLength(1);
  });
  it("tolerates junk", () => {
    expect(pruneEvents(null, NOW2)).toEqual([]);
    expect(pruneEvents([null, {}], NOW2)).toEqual([]);
  });
});
