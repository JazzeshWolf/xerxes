// ---------------------------------------------------------------------------
// Shared domain types — mirrors the snapshot written by scripts/build-data.mjs
// ---------------------------------------------------------------------------

export interface Point {
  t: string; // ISO date
  v: number;
}

export interface ChainRow {
  strike: number;
  type: "CE" | "PE";
  ltp: number | null;
  iv: number | null; // fraction (0.12 = 12%)
  oi: number;
  prevOi: number | null;
  volume: number;
  delta: number | null;
}

export interface OiLevel {
  strike: number;
  oi: number;
}

export interface Factor {
  key: string;
  label: string;
  s: number | null; // signal in [-1, +1]
  weight: number;
  reading: string | null;
  present: boolean;
}

export interface Verdict {
  score: number; // -10..+10
  confidence: number; // 0..1
  verdict: "BULLISH" | "BEARISH" | "NEUTRAL" | "NO DATA";
  structure: string;
  factors: Factor[];
}

export interface SellCandidate {
  strike: number;
  type: "CE" | "PE";
  ltp: number;
  iv: number;
  oi: number;
  delta: number;
  distancePct: number;
  cushionSigma: number | null;
  probTouch: number | null;
  probProfit: number;
}

export interface Gex {
  netPct: number;
  regime: "pinning" | "balanced" | "volatile";
  pinStrike: number;
  coverage: number;
}

export interface Snapshot {
  asOf: string;
  stale: boolean;
  source: "upstox" | "nse" | "fixture" | null;
  index: string;
  name: string;
  expiryKind: string;
  lotSize: number | null;
  spot: { price: number; prevClose: number | null; changePct: number | null; history: Point[] };
  vix: { value: number | null; history: Point[] };
  future: { price: number; expiry: string; oi: number | null; basisPts: number | null } | null;
  expiry: { date: string; dte: number; tYears: number; all: string[] };
  metrics: {
    pcrOi: number | null;
    pcrVolume: number | null;
    totalCallOi: number;
    totalPutOi: number;
    maxPain: number | null;
    callWall: number | null;
    putWall: number | null;
    supports: OiLevel[];
    resistances: OiLevel[];
    oiFlow: { callOiChg: number; putOiChg: number } | null;
    atmStrike: number | null;
    atmIv: number | null;
    ivRank: number | null;
    ivPercentile: number | null;
    ivHistory: Point[];
    rv20: number | null;
    straddle: number | null;
    expectedMove: number | null;
    skew: number | null;
    gex: Gex | null;
  };
  verdict: Verdict;
  candidates: SellCandidate[];
  chain: ChainRow[];
}
