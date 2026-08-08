import type { ExpiryBlock } from "../lib/types";
import { Card, Stat } from "./ui";

/**
 * The seller's edge case for this instrument, at this expiry.
 *
 * The number that matters is IV ÷ forecast RV. Above 1 the market is charging
 * more than the underlying has actually been delivering; below 1 you'd be
 * selling something cheap, which is how premium sellers quietly lose money.
 *
 * The reading differs by instrument, which is why `kind` exists. For a SINGLE
 * STOCK richness cannot be assumed at all — Driessen, Maenhout & Vilkov (2009)
 * found individual-equity variance risk is essentially unpriced — so a ratio
 * near 1 is unremarkable and common. For an INDEX the variance premium is
 * robustly positive on average (it is compensation for correlation risk), so a
 * ratio at or below 1 is the unusual, and cautionary, case.
 */
export function VolPremiumCard({ exp, kind = "stock" }: { exp: ExpiryBlock; kind?: "stock" | "index" }) {
  const m = exp.metrics;
  if (m.vrp == null && m.sigmaForecast == null && m.ivRank == null) return null;

  const isIndex = kind === "index";
  const noun = isIndex ? "this index" : "this stock";
  const vrp = m.vrp ?? null;
  const tone = vrp == null ? null : vrp >= 1.15 ? "up" : vrp < 1 ? "down" : null;
  const verdict =
    vrp == null
      ? `Not enough price history to judge whether ${noun}'s options are rich.`
      : vrp >= 1.25
        ? `Options are priced well above what ${noun} has been doing — the strongest case for selling premium here.`
        : vrp >= 1.05
          ? "Modest premium over realized movement. Workable, but the cushion is thin — favour distant strikes."
          : vrp >= 0.95
            ? isIndex
              ? "The premium has compressed to roughly fair. Index options normally carry a positive volatility premium, so this is a lean regime for sellers — size down or wait."
              : `The market is charging roughly what ${noun} delivers. There's no volatility edge in selling this name right now.`
            : isIndex
              ? "Options are CHEAP against realized movement. That's unusual for an index and typically means the market expects calmer conditions than recent history — a poor moment to be short premium."
              : `Options are CHEAP relative to what ${noun} actually does. Selling premium here is negative expectancy — this is a name to leave alone.`;

  return (
    <Card title="Volatility premium" right={<span className="text-[9px] text-white/35">{exp.dte}d horizon</span>}>
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="IV ÷ forecast RV"
          value={vrp != null ? `${vrp.toFixed(2)}×` : "—"}
          sub={m.atmIv != null ? `IV ${(m.atmIv * 100).toFixed(1)}%` : undefined}
          tone={tone as "up" | "down" | null}
        />
        <Stat
          label="Forecast RV"
          value={m.sigmaForecast != null ? `${(m.sigmaForecast * 100).toFixed(1)}%` : "—"}
          sub={m.rv20 != null ? `20d ${(m.rv20 * 100).toFixed(0)}%` : undefined}
        />
        <Stat
          label="IV rank"
          value={m.ivRank != null ? String(Math.round(m.ivRank)) : "—"}
          sub={m.ivRank == null ? "accruing" : m.ivPercentile != null ? `${m.ivPercentile}%ile` : undefined}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 mt-2.5">
        <Stat
          label="Term slope"
          value={m.termSlope != null ? `${m.termSlope > 0 ? "+" : ""}${m.termSlope}` : "—"}
          sub={m.termSlope == null ? undefined : m.termSlope > 2 ? "backwardation" : m.termSlope < -2 ? "contango" : "flat"}
        />
        <Stat
          label="Gap share"
          value={m.gapShare != null ? `${Math.round(m.gapShare * 100)}%` : "—"}
          sub="risk arriving overnight"
        />
        <Stat
          label="Call−put IV"
          value={m.cpIvSpread != null ? `${m.cpIvSpread > 0 ? "+" : ""}${m.cpIvSpread}` : "—"}
          sub={m.cpIvSpread == null ? undefined : m.cpIvSpread > 0 ? "calls bid" : "puts bid"}
        />
      </div>

      <div className="text-[10px] leading-relaxed text-white/55 mt-2.5">{verdict}</div>
      <div className="text-[9px] text-white/25 mt-1.5 leading-relaxed">
        Forecast RV is a Yang-Zhang (gap-aware) blend of 20/60/120-day realized vol, matched to this
        expiry{isIndex ? "" : " and inflated for names whose risk arrives overnight"}. IV rank stays
        blank until enough daily history has accrued.
        {isIndex && exp.dte <= 10
          ? " On expiries this short the return distribution is still visibly fat-tailed, so the wings are priced off a bootstrap of actual moves rather than a lognormal."
          : ""}
      </div>
    </Card>
  );
}
