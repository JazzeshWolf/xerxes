import type { ExpiryBlock } from "../lib/types";
import { Card, Stat } from "./ui";

/**
 * The seller's edge case for this name, at this expiry — stock-only, so the
 * index Dashboard is untouched.
 *
 * The number that matters is IV ÷ forecast RV. Above 1 the market is charging
 * more than this stock has actually been delivering; below 1 you'd be selling
 * something cheap, which is how premium sellers quietly lose money. This can't
 * be assumed: Driessen, Maenhout & Vilkov (2009) found individual-equity
 * variance risk is essentially unpriced, so richness has to be checked per name.
 */
export function VolPremiumCard({ exp }: { exp: ExpiryBlock }) {
  const m = exp.metrics;
  if (m.vrp == null && m.sigmaForecast == null && m.ivRank == null) return null;

  const vrp = m.vrp ?? null;
  const tone = vrp == null ? null : vrp >= 1.15 ? "up" : vrp < 1 ? "down" : null;
  const verdict =
    vrp == null
      ? "Not enough price history to judge whether this name's options are rich."
      : vrp >= 1.25
        ? "Options are priced well above what this stock has been doing — the strongest case for selling premium here."
        : vrp >= 1.05
          ? "Modest premium over realized movement. Workable, but the cushion is thin — favour distant strikes."
          : vrp >= 0.95
            ? "The market is charging roughly what this stock delivers. There's no volatility edge in selling this name right now."
            : "Options are CHEAP relative to what this stock actually does. Selling premium here is negative expectancy — this is a name to leave alone.";

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
        expiry and inflated for names whose risk arrives overnight. IV rank stays blank until enough
        daily history has accrued.
      </div>
    </Card>
  );
}
