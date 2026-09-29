// Shared synthetic market data for the builder tests. Not a test file itself
// (vitest only collects *.test.mjs).
import * as A from "./analytics.mjs";

/** Deterministic daily bars — enough history for rv120 and the bootstrap. */
export function bars(n = 200, spot = 1000) {
  let s = 11;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
  const out = [];
  let c = spot;
  const day0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const o = c * Math.exp(rnd() * 0.004);
    const nc = o * Math.exp(rnd() * 0.02);
    out.push({
      t: new Date(day0 + i * 86400000).toISOString().slice(0, 10),
      o, h: Math.max(o, nc) * 1.004, l: Math.min(o, nc) * 0.996, c: nc, v: 1e6,
    });
    c = nc;
  }
  // End exactly at `spot` so the chain below is priced around the live level.
  const k = spot / c;
  return out.map((b) => ({ ...b, o: b.o * k, h: b.h * k, l: b.l * k, c: b.c * k }));
}

/** A dense, fairly priced chain: 41 puts and 45 calls clear the seller filters. */
export function denseChain(spot, dte, iv = 0.2) {
  const t = dte / 365;
  const chain = [];
  for (let k = 850; k <= 1150; k++) {
    for (const type of ["CE", "PE"]) {
      const ltp = A.round(A.bsPrice(spot, k, t, iv, type), 2);
      if (!(ltp > 0.05)) continue;
      chain.push({
        strike: k, type, ltp, iv, oi: 500000, prevOi: 450000, volume: 20000,
        bid: null, ask: null, delta: A.bsDelta(spot, k, t, iv, type),
      });
    }
  }
  return chain;
}
