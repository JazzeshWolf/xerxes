import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { Snapshot, ExpiryBlock, SellCandidate } from "../lib/types";
import { fmt, fmtOi } from "../lib/format";
import { Card, Badge } from "./ui";

// Column explainers, shown on hover (native title, so they also read out to
// screen readers). The footnote below the table repeats the essentials for
// touch devices, where there is no hover.
const TIPS = {
  conv: "Sell conviction, 0-100. Blends expected edge, volatility premium, direction alignment, cushion, path safety and strike liquidity; missing inputs redistribute their weight. HIGH 70+, MEDIUM 50+.",
  strike: "Strike price. The small figure is its distance from spot in forecast standard deviations — how far the underlying must travel to reach it.",
  prem: "Premium per share, with the credit for one lot beneath it.",
  delta: "Delta: how much the option moves per 1 point of the underlying. Its absolute value is also the market's RISK-NEUTRAL chance of finishing in the money.",
  pOtmForecast: "Real-world probability the option expires worthless, from our realized-vol forecast plus drift — NOT the risk-neutral 1-|delta|, which is fair by construction and says nothing about profit.",
  pOtmRn: "Risk-neutral probability the option expires out of the money, approximated as 1-|delta|.",
  edge: "Premium minus the option's fair value under our vol forecast, as a percentage of margin. Negative means the market is paying you less than the risk is worth — selling it is negative expectancy.",
  touch: "Probability the strike is tested at ANY point before expiry, not merely at expiry. Roughly twice the chance of finishing in the money.",
  oi: "Open interest: contracts currently live at this strike. Thin open interest means wide spreads and difficult exits.",
};

function Th({ children, tip, right }: { children: ComponentChildren; tip: string; right?: boolean }) {
  return (
    <th className={`${right ? "text-right" : "text-left"} font-medium pb-1`}>
      <span title={tip} className="cursor-help underline decoration-dotted decoration-white/25 underline-offset-2">
        {children}
      </span>
    </th>
  );
}

/**
 * Ranked strikes a seller would actually quote: OTM, small delta, real
 * premium. The verdict's preferred side is pre-selected and badged.
 */
export function SellTable({ snap, exp }: { snap: Snapshot; exp: ExpiryBlock }) {
  const favored: "PE" | "CE" | null =
    snap.verdict.verdict === "BULLISH" ? "PE" : snap.verdict.verdict === "BEARISH" ? "CE" : null;
  const [side, setSide] = useState<"PE" | "CE">(favored ?? "PE");
  const rows = exp.candidates.filter((c) => c.type === side).slice(0, 8);
  const lot = snap.lotSize;
  // Both stocks and indices now carry a sell-conviction per strike, but a
  // snapshot published before that shipped won't — the extra columns are
  // rendered only when the data actually has them.
  const scored = rows.some((c) => c.conviction != null);

  return (
    <Card
      title="Sell candidates"
      right={
        <div className="flex gap-1">
          {(["PE", "CE"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`text-[10px] px-2 py-0.5 rounded border ${
                side === s ? "border-white/40 text-white" : "border-white/10 text-white/40"
              }`}
            >
              {s === "PE" ? "Puts" : "Calls"}
            </button>
          ))}
        </div>
      }
    >
      {favored && (
        <div className="mb-2">
          <Badge tone={favored === "PE" ? "up" : "down"}>
            verdict favors selling {favored === "PE" ? "puts" : "calls"}
          </Badge>{" "}
          {favored !== side && <Badge tone="warn">you're viewing the against-verdict side</Badge>}
        </div>
      )}
      {!rows.length && <div className="text-xs text-white/55 py-4 text-center">No strikes pass the filters (Δ ≤ 0.25, premium ≥ min).</div>}
      {/* Conv + Edge take this to 8 columns, which overflows a phone — the table
          scrolls inside its own box rather than pushing the page sideways. */}
      {rows.length > 0 && (
        <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[340px] text-xs tnum">
          <thead>
            <tr className="text-[9px] uppercase text-white/55">
              {scored && <Th tip={TIPS.conv}>Conv</Th>}
              <Th tip={TIPS.strike}>Strike</Th>
              <Th right tip={TIPS.prem}>Prem</Th>
              <Th right tip={TIPS.delta}>Δ</Th>
              <Th right tip={scored ? TIPS.pOtmForecast : TIPS.pOtmRn}>P(OTM)</Th>
              {scored && <Th right tip={TIPS.edge}>Edge</Th>}
              <Th right tip={TIPS.touch}>Touch</Th>
              <Th right tip={TIPS.oi}>OI</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <Row key={`${c.type}${c.strike}`} c={c} lot={lot} scored={scored} />
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="text-[9px] text-white/45 mt-2">
        Prem × lot {lot ? `(${lot})` : ""} = credit/lot. Touch = prob. of strike being tested before expiry.{" "}
        {scored ? (
          <>
            P(OTM) is the <em>forecast</em> probability (our realized-vol estimate + drift), not the
            risk-neutral 1−|Δ|. Edge = premium over fair value on that forecast, as a % of margin.
          </>
        ) : (
          <>P(OTM) ≈ 1−|Δ|.</>
        )}
      </div>
    </Card>
  );
}

function Row({ c, lot, scored }: { c: SellCandidate; lot: number | null; scored: boolean }) {
  // Prefer the forecast-based cushion/probability where the builder computed them.
  const cushion = c.cushionSigmaF ?? c.cushionSigma;
  const pKeep = c.pProfit ?? c.probProfit;
  const safe = cushion != null && cushion >= 1;
  const bandTone =
    c.band === "HIGH" ? "text-emerald-300" : c.band === "MEDIUM" ? "text-sky-300" : "text-white/45";
  return (
    <tr className="border-t border-white/[0.05]">
      {scored && (
        <td className={`py-1 font-bold ${bandTone}`}>
          {c.conviction ?? "—"}
          {c.deliveryRisk && <span className="ml-0.5 text-amber-300/70" title="May finish ITM — physical settlement">⚠</span>}
        </td>
      )}
      <td className="py-1">
        <span className="text-white/90 font-semibold">{fmt(c.strike)}</span>
        <span className={`ml-1 text-[9px] ${safe ? "text-emerald-300/70" : "text-amber-300/70"}`}>
          {cushion != null ? `${cushion.toFixed(1)}σ` : `${c.distancePct}%`}
        </span>
      </td>
      <td className="text-right text-white/90">
        {fmt(c.ltp, 1)}
        {lot != null && <div className="text-[9px] text-white/50">₹{fmt(c.ltp * lot)}</div>}
      </td>
      <td className="text-right text-white/70">{Math.abs(c.delta).toFixed(2)}</td>
      <td className={`text-right ${pKeep >= 0.85 ? "text-emerald-300" : "text-white/70"}`}>{Math.round(pKeep * 100)}%</td>
      {scored && (
        <td className={`text-right ${(c.edgePct ?? 0) > 0 ? "text-emerald-300/80" : "text-rose-300/80"}`}>
          {c.edgePct != null ? `${(c.edgePct * 100).toFixed(1)}%` : "—"}
        </td>
      )}
      <td className="text-right text-white/70">{c.probTouch != null ? `${Math.round(c.probTouch * 100)}%` : "—"}</td>
      <td className="text-right text-white/65">{fmtOi(c.oi)}</td>
    </tr>
  );
}
