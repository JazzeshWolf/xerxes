// ---------------------------------------------------------------------------
// Shared domain types — mirrors the snapshot written by scripts/build-data.mjs
// ---------------------------------------------------------------------------

export type IndexKey = "NIFTY" | "BANKNIFTY" | "SENSEX";

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

export interface Gex {
  netPct: number;
  regime: "pinning" | "balanced" | "volatile";
  pinStrike: number;
  coverage: number;
}

export interface Metrics {
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
  rv20: number | null;
  straddle: number | null;
  expectedMove: number | null;
  skew: number | null;
  gex: Gex | null;
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

export interface Structure {
  label: "Long buildup" | "Short buildup" | "Short covering" | "Long unwinding" | "Indecisive";
  bias: "bullish" | "bearish" | "neutral";
  strength: "strong" | "weak";
  why: string;
  howToTrade: string;
  priceChgPct: number; // fraction
  oiChgPct: number; // fraction
}

/** One expiry's full analytics — the unit the expiry dropdown switches between. */
export interface ExpiryBlock {
  label: "weekly" | "monthly";
  date: string; // ISO
  dte: number;
  tYears: number;
  metrics: Metrics;
  candidates: SellCandidate[];
  chain: ChainRow[];
}

export interface Snapshot {
  asOf: string;
  stale: boolean;
  source: "upstox" | "nse" | "fixture" | null;
  index: IndexKey;
  name: string;
  expiryKind: string;
  lotSize: number | null;
  spot: { price: number; prevClose: number | null; changePct: number | null; history: Point[] };
  vix: { value: number | null; history: Point[] };
  future: { price: number; expiry: string; oi: number | null; basisPts: number | null } | null;
  defaultExpiry: string;
  expiries: Record<string, ExpiryBlock>;
  ivHistory: Point[];
  verdict: Verdict;
  structure: Structure | null;
}

export interface MarketEvent {
  name: string;
  date: string;
  kind: string;
  weight: number;
  effect: string;
  approx?: boolean; // date not yet officially confirmed
  done?: boolean; // event already happened
  realized?: Record<string, number | null>; // per-index % move on the event day
}

export interface Announcement {
  title: string;
  url: string;
  source: string;
  trusted: boolean;
  symbols: string[];
  publishedAt: string;
  impact: "up" | "down" | "twoway";
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  trusted: boolean;
  indirect: boolean;
  publishedAt: string;
  snippet: string;
  impact: "up" | "down" | "twoway";
}

export interface Driver {
  symbol: string;
  weight: number;
  pct: number;
  contribution: number; // weight × pct/100
}

export interface MarketData {
  asOf: string;
  events: MarketEvent[];
  news: NewsItem[];
  announcements?: Announcement[];
  drivers: Record<string, Driver[]>;
}

export const INDEX_META: Record<IndexKey, { label: string; file: string; blurb: string }> = {
  NIFTY: { label: "NIFTY 50", file: "nifty", blurb: "Weekly · Tuesday expiry" },
  BANKNIFTY: { label: "BANK NIFTY", file: "banknifty", blurb: "Monthly · last Tuesday" },
  SENSEX: { label: "SENSEX", file: "sensex", blurb: "Weekly · Thursday (BSE)" },
};
