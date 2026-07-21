// ---------------------------------------------------------------------------
// Plain-English explainers — every number on the dashboard should be
// understandable by someone new to options. Each explainer returns:
//   what  — what this thing IS (static, one line)
//   read  — what the CURRENT value means (dynamic)
//   expiry — what it implies for price INTO THE SELECTED EXPIRY (dynamic)
// All rule-based and deterministic; missing inputs return null (hide the row).
// ---------------------------------------------------------------------------

import type { Snapshot, ExpiryBlock, Factor } from "./types";
import { fmt } from "./format";

export interface Explain {
  what: string;
  read: string;
  expiry: string;
}

const dteWord = (dte: number) => (dte === 0 ? "today's expiry" : dte === 1 ? "tomorrow's expiry" : `expiry in ${dte} days`);

// --- Factor explainers (keys match directionScore's factors) ----------------
export function explainFactor(f: Factor, snap: Snapshot, exp: ExpiryBlock): Explain | null {
  if (!f.present || f.s == null) return null;
  const dte = exp.dte;
  const spot = snap.spot.price;
  const m = exp.metrics;
  const s = f.s;
  const dirWord = s > 0.15 ? "bullish" : s < -0.15 ? "bearish" : "neutral";

  switch (f.key) {
    case "trend":
      return {
        what: "Where price sits vs its 20- and 50-day averages — the simplest health check of the trend.",
        read:
          s > 0.15
            ? "Price is trading above its moving averages — buyers have been in control over recent weeks."
            : s < -0.15
              ? "Price is below its moving averages — sellers have had the upper hand recently."
              : "Price is hovering around its averages — no clear trend either way.",
        expiry: `A ${dirWord} trend doesn't guarantee direction by ${dteWord(dte)}, but fighting it (selling options against it) needs extra caution.`,
      };
    case "momentum":
      return {
        what: "How fast price moved over the last 5 and 20 sessions — is the move accelerating or stalling?",
        read:
          s > 0.15
            ? "Recent momentum is positive — the index has been climbing."
            : s < -0.15
              ? "Recent momentum is negative — the index has been slipping."
              : "Momentum is flat — recent sessions largely cancelled each other out.",
        expiry: `Momentum often carries a few days; over ${dteWord(dte)} it ${dte <= 2 ? "matters a lot — little time for a reversal" : "can still fade or reverse, so treat it as a lean, not a lock"}.`,
      };
    case "oiFlowSig":
      return {
        what: "Who is WRITING (selling) options today — fresh put writing signals confidence in support; fresh call writing signals a ceiling.",
        read:
          s > 0.15
            ? "Put writers are more aggressive than call writers today — traders are betting the index holds above support."
            : s < -0.15
              ? "Call writers dominate today — traders are betting upside stays capped."
              : "Put and call writing are roughly balanced today.",
        expiry: `Writers profit if their strikes stay OTM by ${dteWord(dte)}, so heavy writing marks the levels big money expects to hold.`,
      };
    case "pcrSig":
      return {
        what: "Put-Call Ratio of open interest — total put OI ÷ total call OI on this expiry.",
        read: explainPcrRead(m.pcrOi),
        expiry: `Into ${dteWord(dte)}, a high PCR often acts as a floor (puts = support), a low PCR as a lid (calls = resistance).`,
      };
    case "maxPainPull": {
      const mp = m.maxPain;
      const away = mp != null && spot > 0 ? ((mp - spot) / spot) * 100 : null;
      return {
        what: "Max pain is the price where option BUYERS lose the most — expiries often drift toward it as sellers defend it.",
        read:
          mp == null
            ? "Max pain unavailable."
            : `Max pain is ${fmt(mp)}, ${away != null && Math.abs(away) < 0.05 ? "right at spot" : `${fmt(Math.abs(away ?? 0), 2)}% ${(away ?? 0) > 0 ? "above" : "below"} spot`} — a mild gravitational ${(away ?? 0) > 0 ? "upward" : (away ?? 0) < 0 ? "downward" : "neutral"} pull.`,
        expiry: `The pull is weak early in the week and strongest in the final hours before ${dteWord(dte)} — it's a magnet, not a magnet crane.`,
      };
    }
    case "skewSig":
      return {
        what: "IV skew compares the price of downside puts vs upside calls — which side is the crowd paying up to protect?",
        read:
          s < -0.15
            ? "Puts are pricier than calls — the crowd is paying for downside protection (fear). Often this fear is overpriced."
            : s > 0.15
              ? "Calls are pricier than puts — traders are chasing upside."
              : "Skew is flat — neither side is being chased.",
        expiry: `Heavy put skew into ${dteWord(dte)} makes selling puts better paid — but remember it's paid BECAUSE a drop is possible.`,
      };
    case "vixSig":
      return {
        what: "India VIX = the market's expected volatility. Rising VIX usually accompanies falling prices (risk-off).",
        read:
          s > 0.15
            ? "VIX has been falling — calm is returning, which usually supports the index."
            : s < -0.15
              ? "VIX has been rising — nervousness building, usually a headwind for the index."
              : "VIX is steady — no change in the fear gauge.",
        expiry: `A VIX spike before ${dteWord(dte)} widens the expected move and can hurt short-option positions even if direction is right.`,
      };
    case "basisSig": {
      const b = snap.future?.basisPts;
      return {
        what: "Basis = futures price minus spot. Futures trading rich (premium) means leveraged traders lean long; a discount means caution.",
        read:
          b == null
            ? "No futures quote."
            : b > 0
              ? `Futures trade ${fmt(b, 1)} pts ABOVE spot — a healthy premium; leveraged money is positioned long.`
              : `Futures trade ${fmt(Math.abs(b), 1)} pts BELOW spot — a discount; leveraged money is defensive.`,
        expiry: `Basis converges to zero by the futures expiry; a fat premium fading into ${dteWord(dte)} can add mild drag.`,
      };
    }
    default:
      return null;
  }
}

function explainPcrRead(pcr: number | null): string {
  if (pcr == null) return "PCR unavailable.";
  if (pcr >= 1.3) return `PCR ${fmt(pcr, 2)} — puts far outnumber calls. Heavy put writing = strong support below, but extreme readings can also mean complacency.`;
  if (pcr >= 1.1) return `PCR ${fmt(pcr, 2)} — more put OI than call OI. Writers are backing the downside to hold: mildly supportive.`;
  if (pcr > 0.9) return `PCR ${fmt(pcr, 2)} — puts and calls roughly balanced. No positioning edge either way.`;
  if (pcr > 0.7) return `PCR ${fmt(pcr, 2)} — more call OI than put OI. Writers are selling upside: rallies likely to meet resistance.`;
  return `PCR ${fmt(pcr, 2)} — call OI dominates. Either strong conviction of a ceiling, or (after a fall) a washed-out market ready to bounce.`;
}

// --- Metric explainers (Positioning & vol card) -----------------------------
export function explainPcr(pcr: number | null, dte: number): Explain | null {
  if (pcr == null) return null;
  return {
    what: "Put-Call Ratio (OI): total put open interest ÷ total call open interest on this expiry. ~1.0 = balanced.",
    read: explainPcrRead(pcr),
    expiry: `Option WRITERS drive this number. Their strikes act like guard-rails into ${dteWord(dte)}: high PCR → rails below price, low PCR → rails above.`,
  };
}

export function explainAtmIv(m: ExpiryBlock["metrics"], dte: number): Explain | null {
  if (m.atmIv == null) return null;
  const iv = m.atmIv * 100;
  const rv = m.rv20 != null ? m.rv20 * 100 : null;
  const richness =
    rv != null
      ? iv > rv * 1.25
        ? `IV is well ABOVE recent realized volatility (${fmt(rv, 1)}%) — options are expensive; sellers are being paid richly.`
        : iv < rv * 0.85
          ? `IV is BELOW recent realized volatility (${fmt(rv, 1)}%) — options are cheap; selling premium here earns little.`
          : `IV is close to recent realized volatility (${fmt(rv, 1)}%) — options are fairly priced.`
      : "";
  return {
    what: "ATM IV = the market's expected annualised volatility, read from the at-the-money option prices. It's the 'price of insurance'.",
    read: `ATM IV is ${fmt(iv, 1)}%${m.ivRank != null ? ` (IV rank ${fmt(m.ivRank)}/100 vs the past year)` : ""}. ${richness}`,
    expiry: `Higher IV = bigger expected swings priced in by ${dteWord(dte)} — and fatter premiums for sellers who think the market is overestimating the move.`,
  };
}

export function explainStraddle(m: ExpiryBlock["metrics"], spot: number, dte: number): Explain | null {
  if (m.straddle == null && m.expectedMove == null) return null;
  const em = m.expectedMove ?? m.straddle ?? 0;
  return {
    what: "The ATM straddle (call + put at the money) is the market's own price for the TOTAL move it expects by expiry.",
    read: `The market is paying ${fmt(m.straddle ?? em, 0)} points for the move — i.e. it expects spot to travel roughly ±${fmt(em)} pts (${fmt((em / spot) * 100, 1)}%) by ${dteWord(dte)}.`,
    expiry: `Strikes OUTSIDE ${fmt(spot - em)}–${fmt(spot + em)} are beyond the priced move — that's where sellers hunt; inside it, you're trading against the market's own estimate.`,
  };
}

export function explainOiFlowToday(flow: { callOiChg: number; putOiChg: number } | null, dte: number): Explain | null {
  if (!flow) return null;
  const p = flow.putOiChg, c = flow.callOiChg;
  const read =
    p > 0 && c > 0
      ? p > c * 1.5
        ? "Both sides added OI, but put writing dominates — conviction that the downside holds."
        : c > p * 1.5
          ? "Both sides added OI, but call writing dominates — conviction that upside is capped."
          : "Both sides are writing in similar size — a range is being built around the current price."
      : p > 0 && c <= 0
        ? "Puts added while calls unwound — positioning is turning supportive."
        : c > 0 && p <= 0
          ? "Calls added while puts unwound — positioning is turning heavy/capped."
          : "OI is unwinding on both sides — positions being closed, conviction leaving the table.";
  return {
    what: "Today's fresh option writing per side. Writers only sell strikes they believe won't be crossed.",
    read,
    expiry: `The strikes gathering today's OI are the fresh battle-lines for ${dteWord(dte)}.`,
  };
}

export function explainSkew(skew: number | null, dte: number): Explain | null {
  if (skew == null) return null;
  const pts = skew * 100;
  return {
    what: "Skew: the IV of downside puts minus upside calls (~2.5% out). It shows which tail the crowd fears.",
    read:
      pts > 0.5
        ? `Puts trade ${fmt(pts, 1)} vol pts richer than calls — downside protection is in demand (fear priced in).`
        : pts < -0.5
          ? `Calls trade ${fmt(Math.abs(pts), 1)} vol pts richer than puts — upside chase is on.`
          : "Skew is flat — put and call IVs are nearly equal; no tail is being chased.",
    expiry: `Rich put skew into ${dteWord(dte)} = better pay for put sellers, but it exists because a drop is genuinely feared. Don't collect it blindly.`,
  };
}
