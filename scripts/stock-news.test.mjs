import { describe, it, expect } from "vitest";
import {
  parseEventDate, classifyEvent, mentionsCompany, mergeEvents, impliedEvent, ambiguousFirstWords, pruneEvents, pruneNews,
  nseTime, parseCorporateActions, parseAnnouncements, classifyFiling, pruneFilings,
} from "./stock-news.mjs";
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

describe("pruneNews", () => {
  const fresh = (title) => ({ title, snippet: "", publishedAt: new Date().toISOString(), url: title });
  it("re-applies the relevance guard to cached items", () => {
    // The exact case that survived a guard tightening on the live site.
    const kept = pruneNews(
      [fresh("Reliance Power Q1 Results: PAT jumps 44%"), fresh("Reliance Industries posts record profit")],
      "RELIANCE",
      "Reliance Industries",
    );
    expect(kept.map((n) => n.title)).toEqual(["Reliance Industries posts record profit"]);
  });
  it("drops items that have aged out", () => {
    const old = { title: "SBIN gains", snippet: "", publishedAt: new Date(Date.now() - 40 * 86400000).toISOString() };
    expect(pruneNews([old], "SBIN", "State Bank of India")).toEqual([]);
  });
  it("tolerates junk", () => {
    expect(pruneNews(null, "SBIN", "State Bank of India")).toEqual([]);
    expect(pruneNews([{}], "SBIN", "State Bank of India")).toEqual([]);
  });
});

describe("NSE corporate actions + filings", () => {
  const NOW = Date.parse("2026-10-10T05:00:00Z"); // 10:30 IST

  it("nseTime reads NSE's three date shapes as IST", () => {
    expect(new Date(nseTime("25-Oct-2026")).toISOString()).toBe("2026-10-24T18:30:00.000Z");
    expect(new Date(nseTime("09-Oct-2026 18:30:12")).toISOString()).toBe("2026-10-09T13:00:12.000Z");
    expect(new Date(nseTime("2026-10-09 18:30:12")).toISOString()).toBe("2026-10-09T13:00:12.000Z");
    expect(nseTime("-")).toBeNull();
    expect(nseTime(null)).toBeNull();
  });

  it("dates a corporate action on its ex-date and drops the history", () => {
    const ev = parseCorporateActions(
      [
        { subject: "Interim Dividend - Rs 21 Per Share", exDate: "24-Oct-2026", recDate: "24-Oct-2026" },
        { subject: "Bonus 1:1", exDate: "-", recDate: "30-Oct-2026" },
        { subject: "Dividend - Rs 2 Per Share", exDate: "01-Aug-2019" },
      ],
      NOW,
    );
    expect(ev.map((e) => [e.kind, e.date])).toEqual([
      ["Dividend", "2026-10-24"],
      ["Bonus issue", "2026-10-30"],
    ]);
    expect(ev.every((e) => e.source === "nse" && !e.approx)).toBe(true);
  });

  it("an earnings call is its own kind, not Results", () => {
    expect(classifyEvent("Infosys Q2 earnings call on 16 October")).toBe("Earnings call");
    expect(classifyFiling("Analysts/Institutional Investor Meet/Con. Call Updates")).toBe("Earnings call");
  });

  it("screens out housekeeping before classifying — a trading window is not Results", () => {
    expect(classifyFiling("Trading Window closure for the purpose of financial results")).toBeNull();
    expect(classifyFiling("Copy of Newspaper Publication of financial results")).toBeNull();
    expect(classifyFiling("Outcome of Board Meeting - financial results")).toBe("Results");
    expect(classifyFiling("Receipt of order worth Rs 480 crore")).toBe("Order win");
    expect(classifyFiling("General updates")).toBeNull();
  });

  it("puts a con-call date on the calendar and ignores the reporting period", () => {
    const { filings, events } = parseAnnouncements(
      [
        {
          desc: "Analysts/Institutional Investor Meet/Con. Call Updates",
          attchmntText: "Schedule of earnings call on October 16, 2026 for the quarter ended September 30, 2026",
          sort_date: "2026-10-08 18:30:12",
          attchmntFile: "https://nsearchives.nseindia.com/corporate/x.pdf",
        },
        {
          // No year on the period: without stripping it, "September 30" would
          // roll forward to NEXT September and be read as the meeting date.
          desc: "Board Meeting Intimation",
          attchmntText: "to consider the financial results for the quarter ended September 30 at its meeting on 14 October",
          an_dt: "01-Oct-2026 10:00:00",
        },
        { desc: "Shareholders meeting", attchmntText: "52nd Annual General Meeting to be held on Thursday, 5th November, 2026", sort_date: "2026-10-09 10:00:00" },
        { desc: "Trading Window-XBRL", attchmntText: "closure of trading window", sort_date: "2026-10-09 10:00:00" },
        { desc: "Press Release", attchmntText: "old news", sort_date: "2026-08-01 10:00:00" },
      ],
      NOW,
    );
    expect(events.map((e) => [e.kind, e.date])).toEqual([
      ["Earnings call", "2026-10-16"],
      ["Results", "2026-10-14"],
      ["AGM", "2026-11-05"],
    ]);
    // Newest first; housekeeping and anything past the window are gone.
    expect(filings.map((f) => f.kind)).toEqual(["AGM", "Earnings call", "Results"]);
    expect(filings[1].url).toMatch(/^https:/);
  });

  it("never dates an event from a filing that only names a past period", () => {
    const { events, filings } = parseAnnouncements(
      [{ desc: "Outcome of Board Meeting", attchmntText: "results for the quarter ended June 30, 2026", sort_date: "2026-10-09 10:00:00" }],
      NOW,
    );
    expect(filings).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("pruneFilings drops what has aged out", () => {
    const kept = pruneFilings(
      [
        { kind: "Order win", title: "a", publishedAt: "2026-10-09T00:00:00Z" },
        { kind: "Order win", title: "b", publishedAt: "2026-08-01T00:00:00Z" },
      ],
      NOW,
    );
    expect(kept.map((f) => f.title)).toEqual(["a"]);
  });
});
