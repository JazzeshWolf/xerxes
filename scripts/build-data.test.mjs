import { describe, it, expect } from "vitest";
import * as A from "./analytics.mjs";
import { buildIndex } from "./build-data.mjs";
import { bars, denseChain } from "./test-fixtures.mjs";

describe("buildIndex candidate cap", () => {
  // Regression: the cap used to be a flat `.slice(0, 24)` BEFORE scoring, and
  // sellCandidates lists every put before any call — so a deep expiry with 24+
  // qualifying puts published "24 PE / 0 CE" and its calls were never scored.
  it("scores calls even when more than 24 puts clear the filters, capping per side", () => {
    const spot = 1000;
    const expiry = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const chain = denseChain(spot, 30);

    const filtered = A.sellCandidates(chain, spot, 30 / 365, spot * 0.2 * Math.sqrt(30 / 365), {
      maxDelta: 0.25, minPremium: 2, quote: A.INDEX_SELL_OPTS.quote,
    });
    const nPut = filtered.filter((c) => c.type === "PE").length;
    const nCall = filtered.filter((c) => c.type === "CE").length;
    expect(nPut).toBeGreaterThan(A.CANDIDATES_PER_SIDE); // the precondition for the old bug
    expect(nCall).toBeGreaterThan(0);

    const ohlc = bars();
    const snap = buildIndex(
      { assetSymbol: "TEST", name: "TEST", expiryKind: "monthly" },
      {
        source: "fixture", spot, prevClose: spot, vix: 14, vixHistory: [],
        spotHistory: ohlc.map((b) => ({ t: b.t, v: b.c })), spotOhlc: ohlc,
        future: null, chainsByExpiry: { [expiry]: chain }, orderedExpiries: [expiry],
        labels: { [expiry]: "monthly" }, lotSize: 75,
      },
      null,
    );
    const got = snap.expiries[expiry].candidates;
    const puts = got.filter((c) => c.type === "PE");
    const calls = got.filter((c) => c.type === "CE");

    expect(calls.length).toBe(Math.min(nCall, A.CANDIDATES_PER_SIDE));
    expect(puts.length).toBe(A.CANDIDATES_PER_SIDE);
    expect(got.every((c) => c.conviction != null)).toBe(true);
    // Ranked by conviction, not by the pre-scoring puts-first order.
    for (let i = 1; i < got.length; i++) expect(got[i - 1].conviction).toBeGreaterThanOrEqual(got[i].conviction);
  });
});
