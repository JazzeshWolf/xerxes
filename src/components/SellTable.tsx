import { useState } from "preact/hooks";
import type { Snapshot, ExpiryBlock, SellCandidate } from "../lib/types";
import { fmt, fmtOi } from "../lib/format";
import { Card, Badge } from "./ui";

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
  // Stock snapshots carry a sell-conviction per strike; index ones don't, so the
  // extra columns simply don't render there.
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
      {!rows.length && <div className="text-xs text-white/40 py-4 text-center">No strikes pass the filters (Δ ≤ 0.25, premium ≥ min).</div>}
      {rows.length > 0 && (
        <table className="w-full text-xs tnum">
          <thead>
            <tr className="text-[9px] uppercase text-white/35">
              {scored && <th className="text-left font-medium pb-1">Conv</th>}
              <th className="text-left font-medium pb-1">Strike</th>
              <th className="text-right font-medium pb-1">Prem</th>
              <th className="text-right font-medium pb-1">Δ</th>
              <th className="text-right font-medium pb-1">P(OTM)</th>
              {scored && <th className="text-right font-medium pb-1">Edge</th>}
              <th className="text-right font-medium pb-1">Touch</th>
              <th className="text-right font-medium pb-1">OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <Row key={`${c.type}${c.strike}`} c={c} lot={lot} scored={scored} />
            ))}
          </tbody>
        </table>
      )}
      <div className="text-[9px] text-white/25 mt-2">
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
        {lot != null && <div className="text-[9px] text-white/35">₹{fmt(c.ltp * lot)}</div>}
      </td>
      <td className="text-right text-white/60">{Math.abs(c.delta).toFixed(2)}</td>
      <td className={`text-right ${pKeep >= 0.85 ? "text-emerald-300" : "text-white/70"}`}>{Math.round(pKeep * 100)}%</td>
      {scored && (
        <td className={`text-right ${(c.edgePct ?? 0) > 0 ? "text-emerald-300/80" : "text-rose-300/80"}`}>
          {c.edgePct != null ? `${(c.edgePct * 100).toFixed(1)}%` : "—"}
        </td>
      )}
      <td className="text-right text-white/60">{c.probTouch != null ? `${Math.round(c.probTouch * 100)}%` : "—"}</td>
      <td className="text-right text-white/50">{fmtOi(c.oi)}</td>
    </tr>
  );
}
