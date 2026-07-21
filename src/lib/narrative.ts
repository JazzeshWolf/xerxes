// ---------------------------------------------------------------------------
// Rule-based narrative — turns the computed snapshot into a plain-English read.
// Deterministic, no LLM, no keys. Every sentence is assembled from numbers the
// engine already produced; missing inputs are dropped, never guessed.
// ---------------------------------------------------------------------------

import type { Snapshot, ExpiryBlock } from "./types";
import { fmt, fmtPct } from "./format";

export interface Narrative {
  whatsGoingOn: string[];
  howToRead: string[];
  whereHeaded: string[];
  whatFlips: string[];
}

export function buildNarrative(snap: Snapshot, exp: ExpiryBlock): Narrative {
  const m = exp.metrics;
  const spot = snap.spot.price;
  const chg = snap.spot.changePct;
  const v = snap.verdict;
  const s = snap.structure;

  const whatsGoingOn: string[] = [];
  const howToRead: string[] = [];
  const whereHeaded: string[] = [];
  const whatFlips: string[] = [];

  // --- What's going on -------------------------------------------------------
  whatsGoingOn.push(
    `${snap.name} is at ${fmt(spot, 2)}${chg != null ? `, ${chg >= 0 ? "up" : "down"} ${fmtPct(Math.abs(chg), 2, false)} on the day` : ""}.`,
  );
  if (s && s.label !== "Indecisive") {
    whatsGoingOn.push(
      `Futures show a **${s.label.toLowerCase()}** (price ${pct(s.priceChgPct)}, OI ${pct(s.oiChgPct)}) — ${s.bias}, ${s.strength === "strong" ? "with conviction" : "but low-conviction"}.`,
    );
  } else if (s) {
    whatsGoingOn.push(`Futures are **indecisive** — little net change in price or open interest today.`);
  }
  if (m.pcrOi != null) {
    const lean = m.pcrOi > 1.1 ? "put-heavy (supportive)" : m.pcrOi < 0.8 ? "call-heavy (capped)" : "balanced";
    whatsGoingOn.push(`Options positioning is ${lean} — PCR(OI) ${fmt(m.pcrOi, 2)}.`);
  }
  if (m.putWall != null || m.callWall != null) {
    const bits: string[] = [];
    if (m.putWall != null) bits.push(`put support at ${fmt(m.putWall)}`);
    if (m.callWall != null) bits.push(`call resistance at ${fmt(m.callWall)}`);
    whatsGoingOn.push(`The biggest walls: ${bits.join(" and ")}.`);
  }

  // --- How to read it --------------------------------------------------------
  howToRead.push(
    `The direction engine reads **${v.verdict}** (score ${v.score > 0 ? "+" : ""}${v.score}) at ${Math.round(v.confidence * 100)}% confidence — ${
      v.verdict === "NEUTRAL"
        ? "signals are mixed, so there's no strong directional edge"
        : `the weight of evidence leans ${v.verdict.toLowerCase()}`
    }.`,
  );
  if (m.maxPain != null) {
    const rel = m.maxPain > spot ? "above spot — a mild upward pull" : m.maxPain < spot ? "below spot — a mild downward pull" : "right at spot";
    howToRead.push(`Max pain sits at ${fmt(m.maxPain)}, ${rel} into expiry (${exp.dte}d).`);
  }
  if (m.ivRank != null) {
    howToRead.push(
      `ATM IV is ${m.atmIv != null ? fmtPct(m.atmIv * 100, 1, false) : "—"} (IV rank ${fmt(m.ivRank)}) — premiums are ${m.ivRank >= 60 ? "rich; good for sellers" : m.ivRank <= 30 ? "cheap; thin edge for sellers" : "middling"}.`,
    );
  } else if (m.atmIv != null) {
    howToRead.push(`ATM IV is ${fmtPct(m.atmIv * 100, 1, false)} (IV-rank history still building).`);
  }
  if (m.skew != null && Math.abs(m.skew) > 0.005) {
    howToRead.push(`Skew shows ${m.skew > 0 ? "puts bid — downside is being hedged" : "calls bid — upside is being chased"}.`);
  }

  // --- Where it's likely headed ---------------------------------------------
  if (m.putWall != null && m.callWall != null) {
    whereHeaded.push(`Boxed between the ${fmt(m.putWall)} put wall (support) and the ${fmt(m.callWall)} call wall (resistance).`);
  }
  if (m.expectedMove != null && m.expectedMove > 0) {
    whereHeaded.push(
      `The market is pricing a ±${fmt(m.expectedMove)}-point move by expiry — roughly ${fmt(spot - m.expectedMove)}–${fmt(spot + m.expectedMove)}.`,
    );
  }
  whereHeaded.push(
    v.verdict === "NEUTRAL"
      ? `Lean: **no conviction** — treat as range-bound; the edge is in selling the wings, not picking a side.`
      : `Lean: **${v.verdict.toLowerCase()}**, best expressed by selling premium on the opposite side (${v.verdict === "BULLISH" ? "puts below support" : "calls above resistance"}).`,
  );

  // --- What would change the view -------------------------------------------
  if (m.callWall != null) whatFlips.push(`A sustained move above ${fmt(m.callWall)} (call wall) turns resistance into a breakout — cover short calls.`);
  if (m.putWall != null) whatFlips.push(`A break below ${fmt(m.putWall)} (put wall) opens downside — cover short puts.`);
  if (s) {
    whatFlips.push(
      s.label === "Long unwinding" || s.label === "Short covering"
        ? `Fresh OI building on the move would upgrade this weak drift into a real trend.`
        : `OI starting to unwind would drain conviction from the current move.`,
    );
  }
  if (snap.vix.value != null) whatFlips.push(`A sharp VIX spike (currently ${fmt(snap.vix.value, 2)}) would widen the expected move and stress short strikes.`);

  return { whatsGoingOn, howToRead, whereHeaded, whatFlips };
}

const pct = (frac: number) => `${frac >= 0 ? "+" : ""}${(frac * 100).toFixed(2)}%`;
