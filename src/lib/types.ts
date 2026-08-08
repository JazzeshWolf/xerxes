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
  // --- predictive layer (stocks; optional so older published JSON still parses)
  rv60?: number | null;
  rv120?: number | null;
  /** Horizon-matched Yang-Zhang realized-vol forecast for THIS expiry. */
  sigmaForecast?: number | null;
  /** ATM IV ÷ forecast RV. >1 = the market charges more than the stock delivers. */
  vrp?: number | null;
  /** Share of recent variance arriving as overnight gaps. */
  gapShare?: number | null;
  /** ATM call IV − ATM put IV, vol points (Cremers-Weinbaum). + = bullish tilt. */
  cpIvSpread?: number | null;
  /** ~10% OTM put IV − ATM IV, vol points (Xing et al.). High = crash risk priced. */
  smirk?: number | null;
  /** Near ATM IV − far ATM IV, vol points. + = backwardation. */
  termSlope?: number | null;
}

/** One component of a conviction score — same shape as a direction `Factor`. */
export interface ConvictionFactor {
  key: string;
  label: string;
  s: number | null; // 0..1
  weight: number;
  reading: string | null;
  present: boolean;
}

export type ConvictionBand = "HIGH" | "MEDIUM" | "LOW";

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
  /** Risk-neutral P(expire OTM) = 1 − |delta|. Kept for comparison. */
  probProfit: number;
  // --- predictive layer (optional: older files, and the index build, lack these)
  conviction?: number; // 0..100
  band?: ConvictionBand;
  /** Premium − fair value under the forecast vol/drift, ₹ per share. */
  edge?: number | null;
  /** `edge` as a fraction of the margin proxy — the cross-name comparable. */
  edgePct?: number | null;
  fair?: number | null;
  /** REAL-WORLD P(expire OTM) under forecast vol + drift. Compare to probProfit. */
  pProfit?: number | null;
  /** Distance to strike in forecast sigmas (not the market's straddle). */
  cushionSigmaF?: number | null;
  probTouchF?: number | null;
  /** P(finish ITM) > 15% — NSE stock options settle physically. Warning only. */
  deliveryRisk?: boolean | null;
  /** Share of the premium that is pure tail compensation (1 = fair value ≈ 0). */
  tailReliance?: number | null;
  /** true = fair value came from the bootstrap, false = lognormal fallback. */
  empirical?: boolean;
  /** Mean P&L per share in the worst 5% of simulated outcomes (negative = loss). */
  cvar?: number | null;
  /** Worst single simulated outcome, per share. */
  worst?: number | null;
  factors?: ConvictionFactor[];
  notes?: string[];
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
  verdict?: Verdict; // direction read on THIS expiry (older files may lack it)
}

/** 1W / 1M / 2M → the expiry whose DTE best matches, `fallback` = poor match. */
export interface Horizon {
  date: string;
  dte: number;
  fallback: boolean;
}

export interface Snapshot {
  asOf: string;
  stale: boolean;
  source: "upstox" | "nse" | "fixture" | null;
  index: string; // IndexKey for indices; the NSE symbol for single stocks
  name: string;
  expiryKind: string;
  lotSize: number | null;
  spot: { price: number; prevClose: number | null; changePct: number | null; history: Point[] };
  vix: { value: number | null; history: Point[] };
  future: { price: number; expiry: string; oi: number | null; basisPts: number | null } | null;
  defaultExpiry: string;
  horizons?: Record<string, Horizon>; // "1W" | "1M" | "2M" (older files may lack it)
  expiries: Record<string, ExpiryBlock>;
  ivHistory: Point[];
  verdict: Verdict;
  structure: Structure | null;
  // --- per-stock news layer (absent on indices and on older published files)
  sector?: string | null;
  news?: StockNewsItem[];
  events?: StockEvent[];
  /** When this stock's news was last fetched — null if never. */
  newsAsOf?: string | null;
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

/** A headline about one specific company. Same shape as the macro `NewsItem`
 *  minus `indirect`, which only means something for market-wide news. */
export interface StockNewsItem {
  title: string;
  url: string;
  source: string;
  trusted: boolean;
  publishedAt: string;
  snippet: string;
  impact: "up" | "down" | "twoway";
}

/** A scheduled thing that could move the stock before expiry.
 *  `source` records which of the four feeds produced it, because their
 *  reliability differs: "nse" is exact, "news" approximate, "options" is a
 *  window inferred from the IV term structure and never a calendar date. */
export interface StockEvent {
  kind: string;
  title: string;
  date: string | null;
  approx: boolean;
  source: "nse" | "news" | "options";
  url?: string;
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

// --- Stock screener (Phase C) ----------------------------------------------
export type LiquidityBucket = "High" | "Medium-High" | "Medium" | "Medium-Low" | "Low" | "None";

export interface StockRow {
  symbol: string;
  name: string;
  file: string; // filename slug for public/data/stocks/<file>.json
  spot: number;
  changePct: number | null;
  sector?: string | null;
  liquidity: { bucket: LiquidityBucket; score: number };
  structure: { label: string; bias: string } | null;
  verdict: { verdict: string; score: number };
  topCandidate: {
    type: "CE" | "PE";
    strike: number;
    probProfit: number;
    pProfit?: number | null;
    conviction?: number | null;
    band?: ConvictionBand | null;
  } | null;
  /** Best conviction available on this name (current expiry). */
  conviction?: number | null;
  vrp?: number | null;
  ivRank?: number | null;
}

export interface StockScreener {
  asOf: string;
  count: number;
  vix: number | null;
  stocks: StockRow[];
}

export interface StockCandidate {
  symbol: string;
  name: string;
  file: string;
  expiry: string;
  dte: number;
  type: "CE" | "PE";
  strike: number;
  ltp: number;
  delta: number | null;
  iv: number | null;
  distancePct: number | null;
  cushionSigma: number | null;
  probProfit: number;
  probTouch: number | null;
  creditPerLot: number | null;
  liquidity: string | null;
  // --- predictive layer (optional so a cached older candidates.json still renders)
  conviction?: number;
  band?: ConvictionBand;
  edge?: number | null;
  edgePct?: number | null;
  fair?: number | null;
  pProfit?: number | null;
  cushionSigmaF?: number | null;
  probTouchF?: number | null;
  deliveryRisk?: boolean | null;
  tailReliance?: number | null;
  empirical?: boolean;
  cvar?: number | null;
  worst?: number | null;
  vrp?: number | null;
  ivRank?: number | null;
  factors?: ConvictionFactor[];
  notes?: string[];
}

/** One expiry's candidate list, gated on that expiry's OWN liquidity cohort. */
export interface CandidateExpiry {
  slot: "current" | "next";
  label: string;
  date: string | null;
  dte: number | null;
  /** Names clearing the liquidity floor for this expiry specifically. */
  liquidNames: number;
  candidateCount: number;
  /** Too few candidates cleared — far-month stock chains are genuinely thin. */
  thin: boolean;
  candidates: StockCandidate[];
}

export interface StockCandidates {
  asOf: string;
  /** Per-expiry blocks. Absent on older published files. */
  expiries?: CandidateExpiry[];
  /** Current-expiry list — kept flat for backward compatibility. */
  candidates: StockCandidate[];
}

export const INDEX_META: Record<IndexKey, { label: string; file: string; blurb: string }> = {
  NIFTY: { label: "NIFTY 50", file: "nifty", blurb: "Weekly · Tuesday expiry" },
  BANKNIFTY: { label: "BANK NIFTY", file: "banknifty", blurb: "Monthly · last Tuesday" },
  SENSEX: { label: "SENSEX", file: "sensex", blurb: "Weekly · Thursday (BSE)" },
};
