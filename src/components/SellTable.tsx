import { useState } from "preact/hooks";
import type { Snapshot, SellCandidate } from "../lib/types";
import { fmt, fmtOi } from "../lib/format";
import { Card, Badge } from "./ui";

/**
 * Ranked strikes a seller would actually quote: OTM, small delta, real
 * premium. The verdict's preferred side is pre-selected and badged.
 */
export function SellTable({ snap }: { snap: Snapshot }) {
  const favored: "PE" | "CE" | null =
    snap.verdict.verdict === "BULLISH" ? "PE" : snap.verdict.verdict === "BEARISH" ? "CE" : null;
  const [side, setSide] = useState<"PE" | "CE">(favored ?? "PE");
  const rows = snap.candidates.filter((c) => c.type === side).slice(0, 8);
  const lot = snap.lotSize;

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
              <th className="text-left font-medium pb-1">Strike</th>
              <th className="text-right font-medium pb-1">Prem</th>
              <th className="text-right font-medium pb-1">Δ</th>
              <th className="text-right font-medium pb-1">P(OTM)</th>
              <th className="text-right font-medium pb-1">Touch</th>
              <th className="text-right font-medium pb-1">OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <Row key={`${c.type}${c.strike}`} c={c} lot={lot} />
            ))}
          </tbody>
        </table>
      )}
      <div className="text-[9px] text-white/25 mt-2">
        Prem × lot {lot ? `(${lot})` : ""} = credit/lot. P(OTM) ≈ 1−|Δ|; Touch = prob. of strike being tested before expiry.
      </div>
    </Card>
  );
}

function Row({ c, lot }: { c: SellCandidate; lot: number | null }) {
  const safe = c.cushionSigma != null && c.cushionSigma >= 1;
  return (
    <tr className="border-t border-white/[0.05]">
      <td className="py-1">
        <span className="text-white/90 font-semibold">{fmt(c.strike)}</span>
        <span className={`ml-1 text-[9px] ${safe ? "text-emerald-300/70" : "text-amber-300/70"}`}>
          {c.cushionSigma != null ? `${c.cushionSigma.toFixed(1)}σ` : `${c.distancePct}%`}
        </span>
      </td>
      <td className="text-right text-white/90">
        {fmt(c.ltp, 1)}
        {lot != null && <div className="text-[9px] text-white/35">₹{fmt(c.ltp * lot)}</div>}
      </td>
      <td className="text-right text-white/60">{Math.abs(c.delta).toFixed(2)}</td>
      <td className={`text-right ${c.probProfit >= 0.85 ? "text-emerald-300" : "text-white/70"}`}>{Math.round(c.probProfit * 100)}%</td>
      <td className="text-right text-white/60">{c.probTouch != null ? `${Math.round(c.probTouch * 100)}%` : "—"}</td>
      <td className="text-right text-white/50">{fmtOi(c.oi)}</td>
    </tr>
  );
}
