import { describe, it, expect } from "vitest";
import { eventsForTrade, leadEvent, daysUntil, istToday, EVENT_ABBR } from "./events";
import type { RowEvent } from "./types";

const ev = (kind: string, date: string): RowEvent => ({ kind, date, source: "nse" });

describe("screener event marker", () => {
  // BSE on 16 Oct: results on 4 Nov.
  const bse = [ev("Results", "2026-11-04")];

  it("marks only events inside the trade's life, expiry day included", () => {
    expect(eventsForTrade(bse, "2026-10-27", "2026-10-19")).toEqual([]); // results after a 27 Oct expiry
    expect(eventsForTrade(bse, "2026-11-23", "2026-10-19")).toEqual(bse); // inside a 23 Nov one
    expect(eventsForTrade([ev("Dividend", "2026-10-27")], "2026-10-27", "2026-10-19")).toHaveLength(1);
    expect(eventsForTrade([ev("Results", "2026-10-16")], "2026-10-27", "2026-10-19")).toEqual([]); // already past
    expect(eventsForTrade(undefined, "2026-10-27", "2026-10-19")).toEqual([]);
    expect(eventsForTrade(bse, undefined, "2026-10-19")).toEqual([]);
  });

  it("the badge leads with results-type events over earlier corporate actions", () => {
    expect(leadEvent([ev("Dividend", "2026-10-20"), ev("Results", "2026-10-23")])!.kind).toBe("Results");
    expect(leadEvent([ev("Dividend", "2026-10-20"), ev("AGM", "2026-10-22")])!.kind).toBe("Dividend");
    expect(leadEvent([])).toBeNull();
    // Same day (BANKINDIA, 23 Oct): show the results, not the call.
    expect(leadEvent([ev("Earnings call", "2026-10-23"), ev("Results", "2026-10-23")])!.kind).toBe("Results");
    // An earlier call still leads a later results date.
    expect(leadEvent([ev("Earnings call", "2026-10-21"), ev("Results", "2026-10-23")])!.kind).toBe("Earnings call");
  });

  it("counts days and reads the IST date", () => {
    expect(daysUntil("2026-10-23", "2026-10-19")).toBe(4);
    expect(daysUntil("2026-10-19", "2026-10-19")).toBe(0);
    // 20:00 UTC on 18 Oct is already 19 Oct in India.
    expect(istToday(Date.parse("2026-10-18T20:00:00Z"))).toBe("2026-10-19");
  });

  it("has a badge label for every kind the build lets through", () => {
    for (const k of ["Results", "Earnings call", "Board meeting", "Dividend", "Bonus issue", "Stock split", "Buyback", "Rights issue", "Fund raise", "AGM", "EGM", "Corporate action"])
      expect(EVENT_ABBR[k]).toBeTruthy();
  });
});
