import { describe, it, expect } from "vitest";
import { premiumFromCandidate, premiumCardSvg, premiumCaption, premiumButtons } from "./premium.mjs";

const c = {
  symbol: "RVNL", name: "Rail Vikas Nigam", strike: 212.5, type: "CE", expiry: "2026-10-27", dte: 20, ltp: 2.04,
  creditPerLot: 3927, conviction: 76, pProfit: 0.89, probTouchF: 0.25, cushionSigmaF: 1.2, distancePct: 8.18,
  iv: 0.391, vrp: 1.33, cvar: -11.4, oiLots: 107, spreadPct: 0.03,
  bid: 1.88, ask: 1.94, quotedAt: "2026-10-07T07:12:40Z",
};

describe("premium notification", () => {
  it("shows the LTP it was decided on, the book, spot and when it was priced", () => {
    const q = premiumFromCandidate(c, { spot: 196.23 });
    const svg = premiumCardSvg(q, { when: "12:45 IST" });
    expect(svg).toContain("₹2.04");
    expect(svg).toContain("bid 1.88 · ask 1.94");
    expect(svg).toContain("spot ₹196.23");
    expect(svg).toContain("12:42 IST"); // the quote time, not the send time
    expect(svg).toContain("sent 12:45 IST");
    const cap = premiumCaption(q);
    expect(cap).toContain("LTP <b>₹2.04</b> × 1,925 = <b>₹3,927</b> credit per lot");
    expect(cap).toContain("<i>priced 12:42 IST · bid 1.88 / ask 1.94 · spot ₹196.23</i>");
  });

  it("leaves out what it doesn't have rather than guessing", () => {
    const q = premiumFromCandidate({ ...c, bid: undefined, ask: undefined, quotedAt: undefined });
    expect(premiumCardSvg(q)).not.toContain("priced");
    expect(premiumCaption(q)).not.toMatch(/bid \d/);
    expect(premiumFromCandidate(c, { quotedAt: "2026-10-07T08:00:00Z" }).quotedAt).toBe("2026-10-07T08:00:00Z");
  });

  const p = premiumFromCandidate(c);

  it("recovers lot, spot and ROM on the stock margin proxy", () => {
    expect(p.lot).toBe(1925);
    expect(p.spot).toBeCloseTo(212.5 / 1.0818, 2);
    expect(p.rom).toBeCloseTo((3927 / (0.15 * p.spot * 1925)) * 100, 6);
  });

  it("card shows the listed strike, not a rounded one", () => {
    const svg = premiumCardSvg(p, { label: "TEST" });
    expect(svg).toContain("SELL 212.5 CE");
    expect(svg).toContain("TEST");
    expect(svg).toContain("₹3,927");
  });

  it("caption fits Telegram's 1024-char cap and states the trade", () => {
    const cap = premiumCaption(p, { test: true });
    expect(cap.length).toBeLessThanOrEqual(1024);
    expect(cap).toContain("Sell RVNL 212.5 CE · 27 Oct");
    expect(cap).toContain("<b>₹3,927</b> credit per lot");
  });

  it("caption states the premium gate when given", () => {
    const cap = premiumCaption(p, { gate: "conviction 70+ · no results before expiry" });
    expect(cap).toContain("<i>Premium gate: conviction 70+ · no results before expiry</i>");
    expect(cap).not.toContain("test of the new format");
  });

  it("buttons open the screener and the stock's NSE chain", () => {
    const [[a, b]] = premiumButtons(p).inline_keyboard;
    expect(a.url).toBe("https://jazzeshwolf.github.io/xerxes/");
    expect(b.url).toContain("symbol=RVNL");
  });
});
