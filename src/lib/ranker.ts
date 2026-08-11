// ---------------------------------------------------------------------------
// Kronos cross-sectional ranker — types and pure derivations.
//
// The product is the RANKING, not any single name's forecast. Everything here
// is built around that: rows carry a rank, a decile and a percentile, and the
// per-name forecast return is deliberately presented as supporting detail
// rather than as a price target.
//
// The other thing this module enforces is honesty about skill. `parseIndex`
// refuses anything malformed (the tab then shows an empty state rather than a
// confident-looking table built from junk), and `skillState` decides how the
// page is allowed to present itself. The page must never look more confident
// than the measured numbers justify, so the default — no skill report at all —
// is "unvalidated", not "fine".
// ---------------------------------------------------------------------------

export type Lean = "bullish" | "bearish" | "neutral";

export interface RankerRow {
  symbol: string;
  name: string;
  sector: string;
  rank: number;
  decile: number;
  percentile: number;
  score: number;
  rawForecast: number;
  forecastReturn: number;
  lastClose: number;
  beta: number;
  quantiles: Record<string, number>;
  lean: Lean;
  implication: string;
}

export interface NeutralizationDiag {
  before: { betaRankCorr: number | null; sectorR2: number | null };
  after: { betaRankCorr: number | null; sectorR2: number | null };
  passed: boolean;
  thresholds: { maxBetaRankCorr: number; maxSectorR2: number };
}

export interface SkillVerdict {
  validated: boolean;
  icir: number | null;
  momentumIcir: number | null;
  edgeOverMomentum: number | null;
  bar: number;
  reasons: string[];
  summary: string;
}

export interface RankerIndex {
  asOf: string;
  tradeDate: string;
  engine: string;
  model: string;
  predLen: number;
  horizonLabel: string;
  universeCount: number;
  neutralization: NeutralizationDiag | null;
  corporateActions: { verdict?: string; actionsDetected?: number } | null;
  skill: SkillVerdict | null;
  validated: boolean;
  rows: RankerRow[];
  demo?: boolean;
}

export interface ArmSummary {
  ic: {
    n: number;
    meanIC: number | null;
    stdIC: number | null;
    icir: number | null;
    tStat: number | null;
    hitRate: number | null;
    overlapping?: boolean;
    note?: string;
  };
  spread: {
    meanGrossPerRebalance: number | null;
    annualisedGross: number | null;
    meanTurnover: number | null;
    costDragPerRebalance: number | null;
    net: {
      impactBps: number;
      roundTripBps: number;
      meanNetPerRebalance: number | null;
      annualisedNet: number | null;
      winRate: number | null;
    } | null;
  };
}

export interface RankerSkill {
  asOf: string;
  engine: string;
  model: string;
  verdict: SkillVerdict;
  rebalances: number;
  predLen: number;
  arms: Record<string, ArmSummary>;
  neutralization: Record<string, unknown> | null;
  dataDepth: Record<string, unknown> | null;
  universeCoverage: Record<string, unknown> | null;
  demo?: boolean;
}

export interface RankerDetail {
  symbol: string;
  name: string;
  sector: string;
  rank: number;
  decile: number;
  percentile: number;
  forecastReturn: number;
  lastClose: number;
  lean: Lean;
  implication: string;
  quantiles: Record<string, number>;
  /** A few illustrative draws. Texture behind the band — never the band itself. */
  paths: number[][];
  /** Per-step 10th/50th/90th percentile prices, computed from EVERY sample. */
  band?: { lo?: number[]; mid?: number[]; hi?: number[] };
  recent: { t: string; o: number; h: number; l: number; c: number; v: number }[];
}

// ---------------------------------------------------------------------------
// Parsing — the explicit failure path
// ---------------------------------------------------------------------------

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Validate one row. A row missing its rank or forecast is not renderable. */
function parseRow(r: unknown): RankerRow | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.symbol !== "string" || !o.symbol) return null;
  if (!isNum(o.rank) || !isNum(o.decile) || !isNum(o.forecastReturn)) return null;
  const lean: Lean =
    o.lean === "bullish" || o.lean === "bearish" ? o.lean : "neutral";
  return {
    symbol: o.symbol,
    name: typeof o.name === "string" ? o.name : o.symbol,
    sector: typeof o.sector === "string" ? o.sector : "—",
    rank: o.rank,
    decile: o.decile,
    percentile: isNum(o.percentile) ? o.percentile : 0,
    score: isNum(o.score) ? o.score : 0,
    rawForecast: isNum(o.rawForecast) ? o.rawForecast : o.forecastReturn,
    forecastReturn: o.forecastReturn,
    lastClose: isNum(o.lastClose) ? o.lastClose : 0,
    beta: isNum(o.beta) ? o.beta : 0,
    quantiles: (o.quantiles && typeof o.quantiles === "object"
      ? (o.quantiles as Record<string, number>)
      : {}),
    lean,
    implication: typeof o.implication === "string" ? o.implication : "",
  };
}

/**
 * Parse a published ranker payload, or return null.
 *
 * Null is a first-class outcome, not an error path bolted on afterwards: if the
 * ranker has never run, or the JSON is truncated mid-publish, the tab shows an
 * empty state and the rest of the app is untouched. Rendering a half-parsed
 * ranking would be strictly worse than rendering nothing.
 */
export function parseIndex(raw: unknown): RankerIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.rows)) return null;

  const rows = o.rows.map(parseRow).filter((r): r is RankerRow => r !== null);
  // A cross-sectional ranking of a handful of names is not a ranking. Breadth
  // is the edge, so too few rows is a broken payload, not a small one.
  if (rows.length < 20) return null;

  rows.sort((a, b) => a.rank - b.rank);
  const skill = parseVerdict(o.skill);
  return {
    asOf: typeof o.asOf === "string" ? o.asOf : "",
    tradeDate: typeof o.tradeDate === "string" ? o.tradeDate : "",
    engine: typeof o.engine === "string" ? o.engine : "unknown",
    model: typeof o.model === "string" ? o.model : "unknown",
    predLen: isNum(o.predLen) ? o.predLen : 21,
    horizonLabel: typeof o.horizonLabel === "string" ? o.horizonLabel : "",
    universeCount: isNum(o.universeCount) ? o.universeCount : rows.length,
    neutralization: (o.neutralization as NeutralizationDiag) ?? null,
    corporateActions: (o.corporateActions as RankerIndex["corporateActions"]) ?? null,
    skill,
    // Trust the verdict object over the convenience flag: `validated: true`
    // with no supporting verdict is exactly the shape a stale or hand-edited
    // file would have.
    validated: skill ? skill.validated : false,
    rows,
    demo: o.demo === true,
  };
}

function parseVerdict(raw: unknown): SkillVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.validated !== "boolean") return null;
  return {
    validated: o.validated,
    icir: isNum(o.icir) ? o.icir : null,
    momentumIcir: isNum(o.momentumIcir) ? o.momentumIcir : null,
    edgeOverMomentum: isNum(o.edgeOverMomentum) ? o.edgeOverMomentum : null,
    bar: isNum(o.bar) ? o.bar : 0,
    reasons: Array.isArray(o.reasons) ? o.reasons.filter((r): r is string => typeof r === "string") : [],
    summary: typeof o.summary === "string" ? o.summary : "",
  };
}

export function parseSkill(raw: unknown): RankerSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const verdict = parseVerdict(o.verdict);
  if (!verdict) return null;
  return {
    asOf: typeof o.asOf === "string" ? o.asOf : "",
    engine: typeof o.engine === "string" ? o.engine : "unknown",
    model: typeof o.model === "string" ? o.model : "unknown",
    verdict,
    rebalances: isNum(o.rebalances) ? o.rebalances : 0,
    predLen: isNum(o.predLen) ? o.predLen : 21,
    arms: (o.arms as Record<string, ArmSummary>) ?? {},
    neutralization: (o.neutralization as Record<string, unknown>) ?? null,
    dataDepth: (o.dataDepth as Record<string, unknown>) ?? null,
    universeCoverage: (o.universeCoverage as Record<string, unknown>) ?? null,
    demo: o.demo === true,
  };
}

// ---------------------------------------------------------------------------
// How confident the page is allowed to look
// ---------------------------------------------------------------------------

export type SkillLevel = "demo" | "unmeasured" | "failed" | "validated";

export interface SkillState {
  level: SkillLevel;
  headline: string;
  detail: string;
  tone: "up" | "warn" | "down";
  /** Whether the ranks may be presented as an actionable lean. */
  actionable: boolean;
}

/**
 * The gate. Four states, and three of them say "do not trade this yet".
 *
 * `unmeasured` is separated from `failed` on purpose: "we have not checked" and
 * "we checked and it did not clear the bar" are different claims, and collapsing
 * them into one warning would let a never-validated model borrow the credibility
 * of a tested one.
 */
export function skillState(index: RankerIndex | null): SkillState {
  if (index?.demo)
    return {
      level: "demo",
      headline: "Synthetic demo data",
      detail:
        "These ranks were generated from invented prices to exercise the pipeline. " +
        "They are not a forecast of anything. Do not trade them.",
      tone: "down",
      actionable: false,
    };

  const v = index?.skill ?? null;
  if (!v)
    return {
      level: "unmeasured",
      headline: "Skill not yet measured",
      detail:
        "The walk-forward validation has not run against this engine yet, so " +
        "there is no ICIR to judge these ranks by. Treat them as unproven.",
      tone: "warn",
      actionable: false,
    };

  if (!v.validated)
    return {
      level: "failed",
      headline: "Unvalidated — measured skill did not clear the bar",
      detail: v.summary.replace(/^UNVALIDATED\s*--\s*/, ""),
      tone: "warn",
      actionable: false,
    };

  return {
    level: "validated",
    headline: "Validated against the stated bar",
    detail: v.summary,
    tone: "up",
    actionable: true,
  };
}

// ---------------------------------------------------------------------------
// Derivations for the table and charts
// ---------------------------------------------------------------------------

export interface DecileGroup {
  decile: number;
  rows: RankerRow[];
  lean: Lean;
  meanForecast: number;
}

/** Group rows by decile, most bullish (10) first. */
export function decileGroups(rows: RankerRow[]): DecileGroup[] {
  const by = new Map<number, RankerRow[]>();
  for (const r of rows) {
    const list = by.get(r.decile);
    if (list) list.push(r);
    else by.set(r.decile, [r]);
  }
  return [...by.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([decile, list]) => ({
      decile,
      rows: list.sort((a, b) => a.rank - b.rank),
      lean: list[0]?.lean ?? "neutral",
      meanForecast: list.reduce((s, r) => s + r.forecastReturn, 0) / list.length,
    }));
}

export const leanTone = (lean: Lean): "up" | "down" | null =>
  lean === "bullish" ? "up" : lean === "bearish" ? "down" : null;

/** The two ends of the book — what the operator actually acts on. */
export function edges(rows: RankerRow[], n = 10): { top: RankerRow[]; bottom: RankerRow[] } {
  return {
    top: rows.slice(0, n),
    bottom: rows.slice(-n).reverse(),
  };
}

export function sectorCounts(rows: RankerRow[], decile: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.decile !== decile) continue;
    counts.set(r.sector, (counts.get(r.sector) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// Cone geometry (hand-rolled SVG — the app has no chart library)
// ---------------------------------------------------------------------------

export interface Cone {
  lo: number[];
  hi: number[];
  mid: number[];
  min: number;
  max: number;
}

/**
 * The cone to draw, preferring the builder's authoritative band.
 *
 * The band is computed server-side across *every* sample path; `paths` are only
 * the handful kept for display. Deriving the median from those few would put a
 * noisy subsample's median on the chart next to a headline forecast taken over
 * hundreds — and the two visibly disagree, which is exactly the bug that made
 * this function exist. Paths are the fallback for older payloads only.
 */
export function coneFor(detail: {
  band?: { lo?: number[]; mid?: number[]; hi?: number[] };
  paths?: number[][];
}): Cone | null {
  const b = detail.band;
  if (b?.lo?.length && b?.mid?.length && b?.hi?.length) {
    const steps = Math.min(b.lo.length, b.mid.length, b.hi.length);
    if (steps >= 2) {
      const lo = b.lo.slice(0, steps);
      const hi = b.hi.slice(0, steps);
      return { lo, hi, mid: b.mid.slice(0, steps), min: Math.min(...lo), max: Math.max(...hi) };
    }
  }
  return coneFromPaths(detail.paths ?? []);
}

/**
 * Per-step quantile bands across sampled price paths.
 *
 * Computed across paths at each step rather than interpolating the terminal
 * quantiles backwards: the cone should show how the model's uncertainty actually
 * opens up over the horizon, and a straight interpolation would draw a tidy
 * wedge that no sample supports.
 */
export function coneFromPaths(paths: number[][], loQ = 0.1, hiQ = 0.9): Cone | null {
  if (!paths.length) return null;
  const steps = Math.min(...paths.map((p) => p.length));
  if (steps < 2) return null;

  const lo: number[] = [], hi: number[] = [], mid: number[] = [];
  for (let s = 0; s < steps; s++) {
    const col = paths.map((p) => p[s]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!col.length) return null;
    lo.push(quantile(col, loQ));
    mid.push(quantile(col, 0.5));
    hi.push(quantile(col, hiQ));
  }
  return { lo, hi, mid, min: Math.min(...lo), max: Math.max(...hi) };
}

/** Linear-interpolated quantile of a pre-sorted array. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const base = Math.floor(pos);
  const rest = pos - base;
  return base + 1 < sorted.length
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}
