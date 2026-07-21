// ---------------------------------------------------------------------------
// Horizon mapping: 1W / 1M / 2M → the expiry whose days-to-expiry best matches
// the target tenor. The data builder emits `snap.horizons`; this also derives
// the same mapping client-side so older snapshots (without the field) still get
// the chips. `fallback` marks a poor match — e.g. BANKNIFTY has no weekly, so
// its "1W" lands on the nearest monthly.
// ---------------------------------------------------------------------------

import type { Snapshot, Horizon } from "./types";

const TARGETS: [string, number][] = [
  ["1W", 7],
  ["1M", 30],
  ["2M", 60],
];

export function resolveHorizons(snap: Snapshot): Record<string, Horizon> {
  if (snap.horizons && Object.keys(snap.horizons).length) return snap.horizons;
  const exps = Object.values(snap.expiries);
  const out: Record<string, Horizon> = {};
  for (const [key, target] of TARGETS) {
    let best: { date: string; dte: number; d: number } | null = null;
    for (const b of exps) {
      const d = Math.abs(b.dte - target);
      if (!best || d < best.d) best = { date: b.date, dte: b.dte, d };
    }
    if (best) out[key] = { date: best.date, dte: best.dte, fallback: best.d > target * 0.6 };
  }
  return out;
}
